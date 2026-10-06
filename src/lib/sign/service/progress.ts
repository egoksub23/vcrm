// ============================================================
// The sender's side of a form: how far each person is, the answers so far, a later expiry date, and an
// uploaded file. Read only except for the expiry. The rules (visible, required, done) are the shared module's.
// ============================================================

import { fieldVisible, overallPercent, roleProgress, type L10n } from "../forms";
import type { ExtendExpiryResult, StaffAnswerRow, StaffProgress, StaffRoleProgress } from "../forms/api-types";
import type { Issue } from "../rules";
import { getFile } from "../storage";
import { loadDocument, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf, loadFormState, rolePartsOf, toView } from "./form-state";
import { fitIssues } from "./signing";

const latest = (...times: (string | null | undefined)[]): string | null => times.filter((t): t is string => !!t).sort().pop() ?? null;

/** A document with a form, seen by the sender. 404 `no_form` for a document that has none. */
export async function loadProgress(ctx: SignCtx, documentId: string): Promise<StaffProgress> {
  const doc = await loadDocument(ctx, documentId);
  const form = formOf(doc);
  if (!form) throw new SignError("no_form", "This document has no form.", 404);
  const { state, signers } = await loadFormState(ctx, doc, form);

  const events = await ctx.admin.from("sign_events").select("signer_id, created_at").eq("document_id", documentId).eq("account_id", ctx.accountId).order("created_at", { ascending: false }).limit(500);
  if (events.error) raiseDatabaseError(events.error, "load events");
  const lastEvent = new Map<string, string>();
  for (const e of (events.data ?? []) as { signer_id: string | null; created_at: string }[]) if (e.signer_id && !lastEvent.has(e.signer_id)) lastEvent.set(e.signer_id, e.created_at);

  const roles: StaffRoleProgress[] = [];
  for (const role of doc.roles_snapshot) {
    const parts = rolePartsOf(form, role.key);
    if (parts.length === 0) continue;
    const signer = signers.find((s) => s.role_key === role.key) ?? null;
    const progress = roleProgress(form, role.key, state.map, state.savedAt);
    const titleOf = new Map<string, L10n>(parts.map((p) => [p.key, p.title]));
    const roleFields = new Set(form.fields.filter((f) => titleOf.has(f.part)).map((f) => f.key));
    roles.push({
      roleKey: role.key,
      roleLabel: role.label,
      signer: signer ? { id: signer.id, name: signer.full_name, email: signer.email, status: signer.status } : null,
      parts: progress.map((p) => ({ ...p, title: titleOf.get(p.key) ?? { en: p.key } })),
      percent: overallPercent(progress),
      lastActivityAt: latest(...[...roleFields].map((k) => state.savedAt[k]), signer ? lastEvent.get(signer.id) : null),
    });
  }

  const roleOfPart = new Map(form.parts.map((p) => [p.key, p.role]));
  const answers: StaffAnswerRow[] = form.fields
    .filter((f) => fieldVisible(form, f, state.map))
    .map((f) => {
      const value = state.map[f.key];
      return {
        key: f.key,
        type: f.type,
        part: f.part,
        label: f.label,
        role: roleOfPart.get(f.part) ?? "",
        value: value ? toView(value) : null,
        source: state.source[f.key] ?? "signer",
        savedAt: state.savedAt[f.key] ?? null,
      };
    });

  // answers too long for where they print, while someone can still change them
  let issues: Issue[] = [];
  if (doc.status === "sent" || doc.status === "in_progress") {
    try {
      issues = await fitIssues(ctx, doc, form, state);
    } catch (err) {
      console.error("[sign] could not check how answers fit:", err instanceof Error ? err.message : err);
    }
  }

  return {
    form,
    roles,
    answers,
    lastActivityAt: latest(...roles.map((r) => r.lastActivityAt), ...Object.values(state.savedAt)),
    issues,
  };
}

/** The most a deadline may be pushed: a year from now, the longest a document may be given when it is sent. */
export const MAX_EXPIRY_AHEAD_DAYS = 365;

/**
 * Give people more time. Only while the document is still open (sent or in progress), only to a time that is later
 * than now and later than the current expiry. Nothing else is reopened. The guard on the table allows this
 * column to change after sending.
 */
export async function extendExpiry(ctx: SignCtx, documentId: string, requested: unknown): Promise<ExtendExpiryResult> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "sent" && doc.status !== "in_progress") throw new SignError("document_not_open", "Only a document that is waiting for signatures can be given more time.", 409);
  const at = typeof requested === "string" || typeof requested === "number" ? new Date(requested) : null;
  if (!at || Number.isNaN(at.getTime())) throw new SignError("bad_expiry", "Choose a date and time.", 400);
  const now = ctx.now();
  if (at.getTime() <= now.getTime()) throw new SignError("expiry_in_the_past", "The new expiry must be in the future.", 400);
  if (doc.expires_at && at.getTime() <= new Date(doc.expires_at).getTime()) throw new SignError("expiry_not_later", "The new expiry must be later than the current one.", 400);
  if (at.getTime() > now.getTime() + MAX_EXPIRY_AHEAD_DAYS * 86_400_000) throw new SignError("expiry_too_far", `The new expiry can be at most ${MAX_EXPIRY_AHEAD_DAYS} days from now.`, 400);

  const { data, error } = await ctx.admin
    .from("sign_documents")
    .update({ expires_at: at.toISOString() })
    .eq("id", documentId)
    .eq("account_id", ctx.accountId)
    .in("status", ["sent", "in_progress"])
    .select("id");
  if (error) raiseDatabaseError(error, "extend expiry");
  if (!data || (data as unknown[]).length === 0) throw new SignError("document_not_open", "Only a document that is waiting for signatures can be given more time.", 409);
  await logEvent(ctx, documentId, "expiry_extended", { actor: "user", userId: ctx.userId, detail: { old: doc.expires_at, new: at.toISOString() } });
  return { expiresAt: at.toISOString() };
}

/** A file a signer uploaded to this document, for the sender. The id must belong to this document and workspace. */
export async function uploadedFileForStaff(ctx: SignCtx, documentId: string, fileId: string): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
  const { data, error } = await ctx.admin
    .from("sign_document_files")
    .select("id, path, name, mime")
    .eq("id", fileId)
    .eq("document_id", documentId)
    .eq("account_id", ctx.accountId)
    .eq("kind", "signer_upload")
    .maybeSingle();
  if (error) raiseDatabaseError(error, "load uploaded file");
  const row = data as { id: string; path: string; name: string; mime: string | null } | null;
  if (!row) throw new SignError("file_not_found", "That file was not found.", 404);
  const bytes = await getFile(ctx.admin, row.path, ctx.accountId);
  await logEvent(ctx, documentId, "downloaded", { actor: "user", userId: ctx.userId, detail: { file: row.id } });
  return { bytes, name: row.name, mime: row.mime ?? "application/octet-stream" };
}
