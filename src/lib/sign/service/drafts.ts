// ============================================================
// Preparing a document: a draft from an uploaded file or from a template, changes to the draft, and its
// signing list. A draft belongs to the workspace and is freely editable; sending it (send.ts) freezes it.
// ============================================================

import { randomUUID } from "node:crypto";

import { ConvertError, ImageError, UploadError, prepareUpload, type ConvertOptions, type PreparedUpload } from "../convert";
import { PdfError } from "../pdf/load";
import { resolveDefaults, cleanReminderDays } from "../defaults";
import { validateForm } from "../forms";
import type { PlacedField } from "../pdf/types";
import { SENDER_ROLE, normalizePhone, validateFields, validateRoles, type Issue } from "../rules";
import { copyFile, documentPath, putFile, removeFiles, safeFileName } from "../storage";
import type { SignDocumentRow, SignRole, SignSignerRow, SignTemplateVersionRow } from "../types";
import { SIGN_LOCALES } from "../types";
import { loadDocument, loadSettings, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

// ---- upload errors ---------------------------------------------------------------

/** Turn what the upload pipeline throws into a SignError a route can answer with. */
export function mapPrepareError(err: unknown): SignError {
  if (err instanceof SignError) return err;
  if (err instanceof UploadError) return new SignError(err.code, err.message, err.code === "upload_too_large" ? 413 : 400);
  if (err instanceof PdfError) return new SignError(err.code, err.message, err.code === "pdf_too_large" ? 413 : 400);
  if (err instanceof ImageError) return new SignError(err.code, err.message, 400);
  if (err instanceof ConvertError) {
    const unavailable = err.code === "converter_not_configured" || err.code === "converter_unavailable";
    return new SignError(err.code, err.message, unavailable ? 503 : 422);
  }
  console.error("[sign] unexpected upload error:", err instanceof Error ? err.message : err);
  return new SignError("upload_failed", "This file could not be processed.", 500);
}

export async function prepareOrThrow(bytes: Uint8Array, filename: string, converter?: ConvertOptions): Promise<PreparedUpload> {
  try {
    return await prepareUpload(bytes, filename, converter);
  } catch (err) {
    throw mapPrepareError(err);
  }
}

// ---- small checks -------------------------------------------------------------------

async function assertCategory(ctx: SignCtx, categoryId: string | null | undefined) {
  if (!categoryId) return null;
  const { data, error } = await ctx.admin.from("sign_categories").select("*").eq("id", categoryId).eq("account_id", ctx.accountId).eq("archived", false).maybeSingle();
  if (error) raiseDatabaseError(error, "load category");
  if (!data) throw new SignError("category_not_found", "That category was not found.", 400);
  return data as { id: string; expiry_days: number | null; reminder_days: number[] | null; code_required: boolean; sign_in_order: boolean };
}

async function assertContact(ctx: SignCtx, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null;
  const { data, error } = await ctx.admin.from("contacts").select("id").eq("id", contactId).eq("account_id", ctx.accountId).is("deleted_at", null).maybeSingle();
  if (error) raiseDatabaseError(error, "load contact");
  if (!data) throw new SignError("contact_not_found", "That contact was not found.", 400);
  return contactId;
}

const stripExt = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();

export interface DraftLinks {
  title?: string | null;
  categoryId?: string | null;
  contactId?: string | null;
  ticketId?: string | null;
  dealId?: string | null;
}

async function insertDraft(ctx: SignCtx, row: Record<string, unknown>, files: Record<string, unknown>[], paths: string[]): Promise<SignDocumentRow> {
  const { data, error } = await ctx.admin.from("sign_documents").insert(row).select("*").single();
  if (error || !data) {
    await removeFiles(ctx.admin, paths);
    raiseDatabaseError(error, "insert draft");
  }
  const doc = data as SignDocumentRow;
  if (files.length) {
    const f = await ctx.admin.from("sign_document_files").insert(files.map((x) => ({ ...x, account_id: ctx.accountId, document_id: doc.id })));
    if (f.error) console.error("[sign] could not record files:", f.error.message);
  }
  return doc;
}

// ---- from an upload -------------------------------------------------------------------

export async function createDraftFromUpload(
  ctx: SignCtx,
  args: DraftLinks & { bytes: Uint8Array; filename: string; converter?: ConvertOptions },
): Promise<{ document: SignDocumentRow; converted: boolean }> {
  const prepared = await prepareOrThrow(args.bytes, args.filename, args.converter);
  const [settings, category, contactId] = await Promise.all([loadSettings(ctx), assertCategory(ctx, args.categoryId), assertContact(ctx, args.contactId)]);
  const defaults = resolveDefaults({ category, workspace: settings });

  const docId = randomUUID();
  const name = safeFileName(args.filename, "document");
  const basePath = documentPath(ctx.accountId, docId, "base", `${prepared.pdfSha256}.pdf`);
  const paths = [basePath];
  await putFile(ctx.admin, basePath, prepared.pdf, "application/pdf");
  let originalPath = basePath;
  const files: Record<string, unknown>[] = [];
  if (prepared.converted) {
    originalPath = documentPath(ctx.accountId, docId, "source", `${prepared.original.sha256.slice(0, 16)}-${name}`);
    paths.push(originalPath);
    await putFile(ctx.admin, originalPath, prepared.original.bytes, prepared.original.mime);
    files.push({ kind: "source", path: originalPath, name, mime: prepared.original.mime, size_bytes: prepared.original.bytes.byteLength, sha256: prepared.original.sha256 });
    files.push({ kind: "converted", path: basePath, name: `${stripExt(name)}.pdf`, mime: "application/pdf", size_bytes: prepared.pdf.byteLength, sha256: prepared.pdfSha256 });
  } else {
    files.push({ kind: "source", path: basePath, name, mime: "application/pdf", size_bytes: prepared.pdf.byteLength, sha256: prepared.pdfSha256 });
  }

  const document = await insertDraft(
    ctx,
    {
      id: docId,
      account_id: ctx.accountId,
      title: (args.title?.trim() || stripExt(name) || "Untitled document").slice(0, 200),
      status: "draft",
      category_id: category?.id ?? null,
      contact_id: contactId,
      ticket_id: args.ticketId ?? null,
      deal_id: args.dealId ?? null,
      fields_snapshot: [],
      roles_snapshot: [],
      sign_in_order: defaults.signInOrder,
      code_required: defaults.codeRequired,
      locale: defaults.locale,
      reminder_days: defaults.reminderDays,
      original_path: originalPath,
      original_type: prepared.original.mime,
      original_sha256: prepared.original.sha256,
      base_path: basePath,
      base_sha256: prepared.pdfSha256,
      page_count: prepared.info.pageCount,
      created_by: ctx.userId,
    },
    files,
    paths,
  );
  await logEvent(ctx, document.id, "created", { actor: "user", userId: ctx.userId, detail: { source: "upload", type: prepared.original.mime, converted: prepared.converted } });
  return { document, converted: prepared.converted };
}

// ---- from a template ------------------------------------------------------------------

export async function createDraftFromTemplate(ctx: SignCtx, args: DraftLinks & { templateId: string }): Promise<SignDocumentRow> {
  const t = await ctx.admin.from("sign_templates").select("*").eq("id", args.templateId).eq("account_id", ctx.accountId).maybeSingle();
  if (t.error) raiseDatabaseError(t.error, "load template");
  const template = t.data as { id: string; name: string; status: string; category_id: string | null; current_version_id: string | null } | null;
  if (!template) throw new SignError("template_not_found", "That template was not found.", 404);
  if (template.status !== "active") throw new SignError("template_not_active", "This template is not active.", 409);
  if (!template.current_version_id) throw new SignError("template_has_no_version", "This template has no saved version yet.", 409);
  const v = await ctx.admin.from("sign_template_versions").select("*").eq("id", template.current_version_id).eq("account_id", ctx.accountId).maybeSingle();
  if (v.error || !v.data) raiseDatabaseError(v.error, "load template version");
  const version = v.data as SignTemplateVersionRow;

  const [settings, category, contactId] = await Promise.all([loadSettings(ctx), assertCategory(ctx, args.categoryId ?? template.category_id), assertContact(ctx, args.contactId)]);
  const defaults = resolveDefaults({ template: version.defaults, category, workspace: settings });

  const docId = randomUUID();
  const basePath = documentPath(ctx.accountId, docId, "base", `${version.source_sha256}.pdf`);
  await copyFile(ctx.admin, version.source_path, basePath, ctx.accountId);
  const document = await insertDraft(
    ctx,
    {
      id: docId,
      account_id: ctx.accountId,
      title: (args.title?.trim() || version.defaults.subject?.trim() || template.name).slice(0, 200),
      status: "draft",
      category_id: category?.id ?? null,
      template_version_id: version.id,
      contact_id: contactId,
      ticket_id: args.ticketId ?? null,
      deal_id: args.dealId ?? null,
      fields_snapshot: version.fields,
      roles_snapshot: version.roles,
      // the form is the template's; the draft keeps its own frozen copy, and only when there is one
      ...(version.form ? { form_snapshot: version.form } : {}),
      message: version.defaults.message ?? null,
      sign_in_order: defaults.signInOrder,
      code_required: defaults.codeRequired,
      locale: defaults.locale,
      reminder_days: defaults.reminderDays,
      // the template's own original file stays with the template; this document works on its own copy
      original_path: null,
      original_type: null,
      base_path: basePath,
      base_sha256: version.source_sha256,
      page_count: version.page_count,
      created_by: ctx.userId,
    },
    [{ kind: "source", path: basePath, name: `${safeFileName(template.name, "template")}.pdf`, mime: "application/pdf", size_bytes: 0, sha256: version.source_sha256 }],
    [basePath],
  );
  await logEvent(ctx, document.id, "created", { actor: "user", userId: ctx.userId, detail: { source: "template", template: template.name, version: version.version_no } });
  return document;
}

// ---- changes to a draft ------------------------------------------------------------------

export interface DraftPatch {
  title?: string;
  categoryId?: string | null;
  contactId?: string | null;
  message?: string | null;
  locale?: string;
  expiresAt?: string | null;
  signInOrder?: boolean;
  codeRequired?: boolean;
  reminderDays?: number[];
  mergeValues?: Record<string, unknown>;
  fields?: PlacedField[];
  roles?: SignRole[];
}

/** Validate and apply changes to a draft. Throws SignError with the issues when the layout is not sound. */
export async function updateDraft(ctx: SignCtx, documentId: string, patch: DraftPatch): Promise<SignDocumentRow> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "This document was already sent.", 409);

  const update: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (t.length < 1 || t.length > 200) throw new SignError("bad_title", "Give the document a title of up to 200 characters.", 400);
    update.title = t;
  }
  if (patch.categoryId !== undefined) update.category_id = (await assertCategory(ctx, patch.categoryId))?.id ?? null;
  if (patch.contactId !== undefined) update.contact_id = await assertContact(ctx, patch.contactId);
  if (patch.message !== undefined) {
    if (patch.message !== null && patch.message.length > 2000) throw new SignError("bad_message", "The message can be up to 2000 characters.", 400);
    update.message = patch.message?.trim() ? patch.message.trim() : null;
  }
  if (patch.locale !== undefined) {
    if (!SIGN_LOCALES.includes(patch.locale as never)) throw new SignError("bad_locale", "Choose English, Bahasa Melayu, Chinese or Korean.", 400);
    update.locale = patch.locale;
  }
  if (patch.expiresAt !== undefined) {
    if (patch.expiresAt === null) update.expires_at = null;
    else {
      const d = new Date(patch.expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= ctx.now().getTime()) throw new SignError("expiry_in_the_past", "The expiry date must be in the future.", 400);
      update.expires_at = d.toISOString();
    }
  }
  if (patch.signInOrder !== undefined) update.sign_in_order = !!patch.signInOrder;
  if (patch.codeRequired !== undefined) update.code_required = !!patch.codeRequired;
  if (patch.reminderDays !== undefined) update.reminder_days = cleanReminderDays(patch.reminderDays);
  if (patch.mergeValues !== undefined) {
    const mv = patch.mergeValues;
    if (typeof mv !== "object" || mv === null || Array.isArray(mv) || Object.keys(mv).length > 200) throw new SignError("bad_merge_values", "The values to fill in are not valid.", 400);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(mv)) {
      if (!/^[A-Za-z][A-Za-z0-9_.]{0,59}$/.test(k)) throw new SignError("bad_merge_values", "The values to fill in are not valid.", 400);
      if (v === null || v === undefined || v === "") continue;
      const s = String(v);
      if (s.length > 2000) throw new SignError("bad_merge_values", "A value to fill in is too long.", 400);
      clean[k] = s;
    }
    update.merge_values = clean;
  }
  if (patch.fields !== undefined || patch.roles !== undefined) {
    const fields = patch.fields ?? doc.fields_snapshot;
    const roles = patch.roles ?? doc.roles_snapshot;
    const issues: Issue[] = [...validateRoles(roles), ...validateFields(fields, roles, doc.page_count ?? 1)];
    // the form belongs to the template and is not editable here, but the placements must still print it soundly
    if (doc.form_snapshot) issues.push(...validateForm(doc.form_snapshot, roles, fields));
    else if (fields.some((f) => f.data !== undefined)) issues.push(...validateForm({ version: 1, parts: [], fields: [] }, roles, fields));
    if (issues.length) throw new SignError("invalid_layout", "The fields on this document are not valid.", 400, issues);
    if (patch.fields !== undefined) update.fields_snapshot = fields;
    if (patch.roles !== undefined) update.roles_snapshot = roles;
  }
  if (Object.keys(update).length === 0) return doc;

  const { data, error } = await ctx.admin.from("sign_documents").update(update).eq("id", documentId).eq("account_id", ctx.accountId).eq("status", "draft").select("*").maybeSingle();
  if (error) raiseDatabaseError(error, "update draft");
  if (!data) throw new SignError("document_not_draft", "This document was already sent.", 409);
  return data as SignDocumentRow;
}

// ---- the signing list ------------------------------------------------------------------------

export interface SignerInput {
  roleKey: string;
  kind: "signer" | "filler";
  fullName: string;
  email: string;
  phone?: string | null;
  channel: "email" | "whatsapp";
  orderNo: number;
  internalUserId?: string | null;
}

/** Replace a draft's signing list. Details are checked again at send; this stops what could never be valid. */
export async function setSigners(ctx: SignCtx, documentId: string, signers: SignerInput[]): Promise<SignSignerRow[]> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "This document was already sent.", 409);
  if (signers.length > 20) throw new SignError("too_many_signers", "A document can have up to 20 people.", 400);
  const roleKeys = new Set(doc.roles_snapshot.map((r) => r.key));
  const rows = signers.map((s, i) => {
    const name = s.fullName.trim();
    const email = s.email.trim();
    if (!name || name.length > 160) throw new SignError("signer_name", `Enter a full name for person ${i + 1}.`, 400, [{ code: "signer_name", detail: String(i) }]);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new SignError("signer_email", `Enter a valid email for person ${i + 1}.`, 400, [{ code: "signer_email", detail: String(i) }]);
    if (s.channel === "whatsapp" && !normalizePhone(s.phone)) throw new SignError("signer_phone", `Enter a phone number with country code for person ${i + 1}.`, 400, [{ code: "signer_phone", detail: String(i) }]);
    if (s.roleKey === SENDER_ROLE || (roleKeys.size > 0 && !roleKeys.has(s.roleKey))) throw new SignError("signer_role", `Choose a role for person ${i + 1}.`, 400, [{ code: "signer_role", detail: String(i) }]);
    return {
      account_id: ctx.accountId,
      document_id: documentId,
      role_key: s.roleKey,
      kind: s.kind,
      full_name: name,
      email,
      phone: s.channel === "whatsapp" ? normalizePhone(s.phone) : s.phone?.trim() || null,
      channel: s.channel,
      order_no: Math.max(1, Math.floor(s.orderNo || i + 1)),
      internal_user_id: s.internalUserId ?? null,
    };
  });
  const del = await ctx.admin.from("sign_signers").delete().eq("document_id", documentId).eq("account_id", ctx.accountId);
  if (del.error) raiseDatabaseError(del.error, "clear signers");
  if (rows.length === 0) return [];
  const ins = await ctx.admin.from("sign_signers").insert(rows).select("*");
  if (ins.error) raiseDatabaseError(ins.error, "insert signers");
  return (ins.data ?? []) as SignSignerRow[];
}

/** Delete a draft and its files. A document that was sent is voided, never deleted. */
export async function deleteDraft(ctx: SignCtx, documentId: string): Promise<void> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "Only a draft can be deleted. Void a document that was sent.", 409);
  const files = await ctx.admin.from("sign_document_files").select("path").eq("document_id", documentId).eq("account_id", ctx.accountId);
  const mine = `account-${ctx.accountId}/${documentId}/`;
  const paths = new Set<string>((files.data ?? []).map((f: { path: string }) => f.path));
  for (const p of [doc.base_path, doc.original_path]) if (p) paths.add(p);
  // only files that live in this document's own folder: never a template's file or another document's
  for (const p of [...paths]) if (!p.startsWith(mine)) paths.delete(p);
  const { error } = await ctx.admin.from("sign_documents").delete().eq("id", documentId).eq("account_id", ctx.accountId).eq("status", "draft");
  if (error) raiseDatabaseError(error, "delete draft");
  await removeFiles(ctx.admin, [...paths]);
}
