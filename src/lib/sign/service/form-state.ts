// ============================================================
// Forms on the server: how the answers to a document's form are read, grouped and shown. Every rule (what
// is visible, required, done, ready) is the shared module's (src/lib/sign/forms); this file only gathers
// the stored answers into the shape those functions take, and turns the result into what a signer's page or
// the sender's screen is allowed to see (a stored file's path never leaves the server).
// ============================================================

import { isFormDefinition, missingFormRequired, partsForRole, presenceOnly, roleProgress, ruleFields, sensitiveKeysOf, unsoundAnswers, type DataField, type FileSummary, type FormDefinition, type FormPart, type FormValue, type FormValueView, type PartProgress, type SignerFormView } from "../forms";
import { heldParts, isDelegate, mayAnswerPart, openDelegations, partsAnswered, partsShown, type SignerLike } from "../forward";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { loadSigners, logEvent, type SignCtx } from "./context";
import { raiseDatabaseError } from "./errors";
import { ANSWER_COLUMNS, openRows, type StoredRow } from "./sensitive";

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

/**
 * The data fields a person answers themselves: their role's, less any part they handed to a delegate, and for a
 * delegate only the parts they were handed. `signers` are the people of the document (to know which parts are handed over).
 */
export function ownDataFieldsFor(form: FormDefinition, signer: Pick<SignerLike, "role_key" | "part_keys">, signers: readonly Pick<SignerLike, "part_keys">[] = []): Map<string, DataField> {
  const parts = new Set(partsAnswered(form, signer, signers).map((p) => p.key));
  return new Map(form.fields.filter((f) => parts.has(f.part)).map((f) => [f.key, f]));
}

/** The required fields this person has not answered: for a delegate only those of the parts they hold. */
export function missingFor(form: FormDefinition, signer: Pick<SignerLike, "role_key" | "part_keys">, map: FormState["map"]): DataField[] {
  const all = missingFormRequired(form, signer.role_key, map);
  return isDelegate(signer) ? all.filter((f) => (signer.part_keys ?? []).includes(f.part)) : all;
}

/** Answers of this person's parts that are no longer sound; for a delegate only those of the parts they hold. */
export function unsoundFor(form: FormDefinition, signer: Pick<SignerLike, "role_key" | "part_keys">, map: FormState["map"]): { field: string; code: string }[] {
  const all = unsoundAnswers(form, signer.role_key, map);
  if (!isDelegate(signer)) return all;
  const mine = new Set(form.fields.filter((f) => (signer.part_keys ?? []).includes(f.part)).map((f) => f.key));
  return all.filter((u) => mine.has(u.field));
}

/** The answers of a document, any signer's. A sensitive answer is opened here (in memory only); whoever shows it to a person masks it first (sensitive-staff.ts). */
export async function loadAnswerRows(ctx: SignCtx, documentId: string): Promise<AnswerRow[]> {
  const { data, error } = await ctx.admin.from("sign_answers").select(ANSWER_COLUMNS).eq("document_id", documentId).eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "load answers");
  return openRows((data ?? []) as unknown as StoredRow[], documentId);
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
 * only an answer written by a person of that role counts, whatever else is in the table. A part handed to a
 * delegate (migration 166) is answered by the delegate alone: what the signer typed before handing it over, and
 * what anyone else of the role writes, is not the part's answer.
 */
export function formState(form: FormDefinition, signers: readonly Pick<SignerLike, "id" | "role_key" | "part_keys">[], rows: readonly AnswerRow[]): FormState {
  const who = new Map(signers.map((s) => [s.id, s]));
  const held = heldParts(signers);
  const owner = new Map<string, FormPart>();
  for (const f of form.fields) {
    const part = form.parts.find((p) => p.key === f.part);
    if (part) owner.set(f.key, part);
  }
  const state: FormState = { map: {}, savedAt: {}, source: {} };
  for (const r of rows) {
    const part = owner.get(r.field_key);
    const person = who.get(r.signer_id);
    if (!part || !person || !mayAnswerPart(person, part, held)) continue;
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
 * refers to (with its answer, because the rule needs it). Nothing else of the other roles is sent. A delegate is
 * sent only the parts they were handed; a signer who handed a part over still sees it (read only), and cannot
 * sign while a delegate is open. `signers` are the people of the document.
 */
export function signerFormView(form: FormDefinition, signer: Pick<SignerLike, "id" | "role_key" | "part_keys">, state: FormState, signers: readonly SignerLike[] = []): SignerFormView {
  const parts = partsShown(form, signer);
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
  // another role's sensitive answer is never sent to this person: a rule of theirs may still ask whether there is one
  const secret = sensitiveKeysOf(form);
  for (const k of foreignKeys) if (state.map[k]) answers[k] = secret.has(k) ? presenceOnly(state.map[k]) : redacted(state.map[k]);

  const unconfirmed = [...ownKeys].filter((k) => state.map[k] && state.source[k] === "contact");
  return {
    definition: { version: 1, parts, fields: form.fields.filter((f) => ownKeys.has(f.key) || foreignKeys.has(f.key)) },
    partKeys,
    answers,
    unconfirmed,
    progress: roleProgress(form, signer.role_key, state.map, state.savedAt).filter((p) => own.has(p.key)),
    ready: readyFor(form, signer, state, signers),
  };
}

/**
 * May this person's sign step (or Submit, for a filler) open? Every required answer of the parts they hold is in,
 * and, for a signer, no part they handed over is still with a delegate.
 */
export function readyFor(form: FormDefinition, signer: Pick<SignerLike, "id" | "role_key" | "part_keys">, state: FormState, signers: readonly SignerLike[] = []): boolean {
  if (missingFor(form, signer, state.map).length > 0) return false;
  return isDelegate(signer) || openDelegations(signers, signer.id).length === 0;
}

export interface Standing {
  progress: PartProgress[];
  ready: boolean;
  unconfirmed: string[];
}

/** Where one person stands: progress of the parts they see, whether the sign step may open, and the answers still to be confirmed. */
export function standing(form: FormDefinition, signer: Pick<SignerLike, "id" | "role_key" | "part_keys">, state: FormState, signers: readonly SignerLike[] = []): Standing {
  const shown = new Set(partsShown(form, signer).map((p) => p.key));
  const own = ownDataFieldsFor(form, signer, signers);
  return {
    progress: roleProgress(form, signer.role_key, state.map, state.savedAt).filter((p) => shown.has(p.key)),
    ready: readyFor(form, signer, state, signers),
    unconfirmed: [...own.keys()].filter((k) => state.map[k] && state.source[k] === "contact"),
  };
}

// ---- audit --------------------------------------------------------------------------------------------

/** `part_completed` when a part becomes done and `part_reopened` when a done part stops being done. No values are logged. */
export async function recordPartChanges(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, form: FormDefinition, before: FormState, after: FormState): Promise<void> {
  const was = new Map(roleProgress(form, signer.role_key, before.map, before.savedAt).map((p) => [p.key, p.state]));
  const now = new Map(roleProgress(form, signer.role_key, after.map, after.savedAt).map((p) => [p.key, p.state]));
  for (const part of partsShown(form, signer)) {
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

/**
 * The parts a signer has not finished, in the form's order. With `signer` and `signers` the parts handed to a delegate
 * are not the signer's to finish (a reminder names only what the person can do), and a delegate is named only the
 * parts they hold.
 */
export function unfinishedParts(form: FormDefinition, roleKey: string, state: FormState, who?: { signer: Pick<SignerLike, "role_key" | "part_keys">; signers: readonly SignerLike[] }): FormPart[] {
  const progress = new Map(roleProgress(form, roleKey, state.map, state.savedAt).map((p) => [p.key, p.state]));
  const mine = who ? new Set(partsAnswered(form, who.signer, who.signers).map((p) => p.key)) : null;
  return partsForRole(form, roleKey, state.map).filter((p) => progress.get(p.key) !== "done" && (!mine || mine.has(p.key)));
}
