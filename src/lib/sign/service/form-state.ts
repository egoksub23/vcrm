// ============================================================
// Forms on the server: how the answers to a document's form are read, grouped and shown. Every rule (what
// is visible, required, done, ready) is the shared module's (src/lib/sign/forms); this file only gathers
// the stored answers into the shape those functions take, and turns the result into what a signer's page or
// the sender's screen is allowed to see (a stored file's path never leaves the server).
// ============================================================

import { isFormDefinition, partsForRole, roleProgress, ruleFields, signReady, type DataField, type FileSummary, type FormDefinition, type FormPart, type FormValue, type FormValueView, type PartProgress, type SignerFormView } from "../forms";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { loadSigners, logEvent, type SignCtx } from "./context";
import { raiseDatabaseError } from "./errors";

export type AnswerSource = "signer" | "sender" | "contact" | "forwarded";

/** A row of sign_answers as the services read it. */
export interface AnswerRow {
  signer_id: string;
  field_key: string;
  value: unknown;
  source?: AnswerSource;
  saved_at?: string | null;
}

/** The form of a document, or null for a document that is only fields on the page. */
export function formOf(doc: Pick<SignDocumentRow, "form_snapshot">): FormDefinition | null {
  return doc.form_snapshot && isFormDefinition(doc.form_snapshot) ? doc.form_snapshot : null;
}

/** The parts a role completes, in order, shown or not (a hidden part may become shown by an answer). */
export const rolePartsOf = (form: FormDefinition, roleKey: string): FormPart[] => form.parts.filter((p) => p.role === roleKey);

export const roleHasParts = (form: FormDefinition, roleKey: string): boolean => form.parts.some((p) => p.role === roleKey);

/** The data fields of a role's parts, by key. */
export function ownDataFields(form: FormDefinition, roleKey: string): Map<string, DataField> {
  const parts = new Set(rolePartsOf(form, roleKey).map((p) => p.key));
  return new Map(form.fields.filter((f) => parts.has(f.part)).map((f) => [f.key, f]));
}

export async function loadAnswerRows(ctx: SignCtx, documentId: string): Promise<AnswerRow[]> {
  const { data, error } = await ctx.admin.from("sign_answers").select("signer_id, field_key, value, source, saved_at").eq("document_id", documentId).eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "load answers");
  return (data ?? []) as AnswerRow[];
}

// ---- the answers of a whole document ------------------------------------------------------------------

export interface FormState {
  /** The answer to each data field, from the person of the role that owns it. */
  map: Record<string, FormValue>;
  /** When each was last saved. */
  savedAt: Record<string, string>;
  source: Record<string, AnswerSource>;
}

/**
 * Gather the stored answers into one map keyed by data field. A data field belongs to the role of its part;
 * only an answer written by a person of that role counts, whatever else is in the table.
 */
export function formState(form: FormDefinition, signers: readonly Pick<SignSignerRow, "id" | "role_key">[], rows: readonly AnswerRow[]): FormState {
  const roleOf = new Map(signers.map((s) => [s.id, s.role_key]));
  const owner = new Map<string, string>();
  for (const f of form.fields) {
    const part = form.parts.find((p) => p.key === f.part);
    if (part) owner.set(f.key, part.role);
  }
  const state: FormState = { map: {}, savedAt: {}, source: {} };
  for (const r of rows) {
    const role = owner.get(r.field_key);
    if (!role || roleOf.get(r.signer_id) !== role) continue;
    if (!r.value || typeof r.value !== "object") continue;
    const prev = state.savedAt[r.field_key];
    if (prev && r.saved_at && prev > r.saved_at) continue; // two people in one role: the later answer wins
    state.map[r.field_key] = r.value as FormValue;
    if (r.saved_at) state.savedAt[r.field_key] = r.saved_at;
    state.source[r.field_key] = r.source ?? "signer";
  }
  return state;
}

export async function loadFormState(ctx: SignCtx, doc: SignDocumentRow, form: FormDefinition): Promise<{ state: FormState; signers: SignSignerRow[]; rows: AnswerRow[] }> {
  const [signers, rows] = await Promise.all([loadSigners(ctx, doc.id), loadAnswerRows(ctx, doc.id)]);
  return { state: formState(form, signers, rows), signers, rows };
}

// ---- what may be shown --------------------------------------------------------------------------------

/** A stored value without the server's file paths. */
export function toView(value: FormValue): FormValueView {
  if ("files" in value) {
    const files: FileSummary[] = value.files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, sha256: f.sha256 }));
    return { files };
  }
  return value;
}

/** What another role's answer is reduced to when only the fact that it exists matters to a rule. */
function redacted(value: FormValue): FormValueView {
  if ("files" in value) return { files: value.files.map((f) => ({ id: f.id, name: "file", mime: "", size: 0, sha256: "" })) };
  if ("image" in value) return { image: "image", mime: value.mime };
  return value;
}

/**
 * The form as one signer's page gets it: their role's parts and fields, plus any other field a rule of theirs
 * refers to (with its answer, because the rule needs it). Nothing else of the other roles is sent.
 */
export function signerFormView(form: FormDefinition, signer: Pick<SignSignerRow, "role_key">, state: FormState): SignerFormView {
  const parts = rolePartsOf(form, signer.role_key);
  const partKeys = parts.map((p) => p.key);
  const own = new Set(partKeys);
  const ownFields = form.fields.filter((f) => own.has(f.part));

  const referred = new Set<string>();
  for (const p of parts) if (p.visibleIf) ruleFields(p.visibleIf).forEach((k) => referred.add(k));
  for (const f of ownFields) {
    if (f.visibleIf) ruleFields(f.visibleIf).forEach((k) => referred.add(k));
    if (f.requiredIf) ruleFields(f.requiredIf).forEach((k) => referred.add(k));
  }
  const ownKeys = new Set(ownFields.map((f) => f.key));
  const foreignKeys = new Set([...referred].filter((k) => !ownKeys.has(k) && form.fields.some((f) => f.key === k)));

  const answers: Record<string, FormValueView> = {};
  for (const k of ownKeys) if (state.map[k]) answers[k] = toView(state.map[k]);
  for (const k of foreignKeys) if (state.map[k]) answers[k] = redacted(state.map[k]);

  const unconfirmed = [...ownKeys].filter((k) => state.map[k] && state.source[k] === "contact");
  return {
    definition: { version: 1, parts, fields: form.fields.filter((f) => ownKeys.has(f.key) || foreignKeys.has(f.key)) },
    partKeys,
    answers,
    unconfirmed,
    progress: roleProgress(form, signer.role_key, state.map, state.savedAt),
    ready: signReady(form, signer.role_key, state.map),
  };
}

export interface Standing {
  progress: PartProgress[];
  ready: boolean;
  unconfirmed: string[];
}

/** Where one role stands: part progress, whether the sign step may open, and the answers still to be confirmed. */
export function standing(form: FormDefinition, roleKey: string, state: FormState): Standing {
  const own = ownDataFields(form, roleKey);
  return {
    progress: roleProgress(form, roleKey, state.map, state.savedAt),
    ready: signReady(form, roleKey, state.map),
    unconfirmed: [...own.keys()].filter((k) => state.map[k] && state.source[k] === "contact"),
  };
}

// ---- audit --------------------------------------------------------------------------------------------

/** `part_completed` when a part becomes done and `part_reopened` when a done part stops being done. No values are logged. */
export async function recordPartChanges(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, form: FormDefinition, before: FormState, after: FormState): Promise<void> {
  const was = new Map(roleProgress(form, signer.role_key, before.map, before.savedAt).map((p) => [p.key, p.state]));
  const now = new Map(roleProgress(form, signer.role_key, after.map, after.savedAt).map((p) => [p.key, p.state]));
  for (const part of rolePartsOf(form, signer.role_key)) {
    const a = was.get(part.key) === "done";
    const b = now.get(part.key);
    if (!a && b === "done") await logEvent(ctx, doc.id, "part_completed", { actor: "signer", signerId: signer.id, detail: { part: part.key } });
    else if (a && b !== undefined && b !== "done") await logEvent(ctx, doc.id, "part_reopened", { actor: "signer", signerId: signer.id, detail: { part: part.key } });
  }
}

export const SAVED_EVENT_EVERY_MS = 5 * 60_000;

/** An autosave leaves a trace, but at most one `saved` event per signer every five minutes, and never a value. */
export async function recordSaved(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, count: number): Promise<void> {
  try {
    const last = await ctx.admin
      .from("sign_events")
      .select("created_at")
      .eq("document_id", doc.id)
      .eq("account_id", ctx.accountId)
      .eq("signer_id", signer.id)
      .eq("type", "saved")
      .order("created_at", { ascending: false })
      .limit(1);
    const at = (last.data as { created_at: string }[] | null)?.[0]?.created_at;
    if (at && ctx.now().getTime() - new Date(at).getTime() < SAVED_EVENT_EVERY_MS) return;
  } catch {
    // an unreadable log is no reason to skip a new entry
  }
  await logEvent(ctx, doc.id, "saved", { actor: "signer", signerId: signer.id, detail: { fields: count } });
}

/** Titles of the parts a signer has not finished, in the document's language order. */
export function unfinishedParts(form: FormDefinition, roleKey: string, state: FormState): FormPart[] {
  const progress = new Map(roleProgress(form, roleKey, state.map, state.savedAt).map((p) => [p.key, p.state]));
  return partsForRole(form, roleKey, state.map).filter((p) => progress.get(p.key) !== "done");
}
