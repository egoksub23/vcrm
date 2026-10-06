// ============================================================
// The signer's side: what a person sees and does with their link. No login: the link's token is
// looked up by its hash, and a code (when the document asks for one) is checked before anything of the
// document is shown. Every state change goes through the database functions of migration 158.
// ============================================================

import { consentFor } from "../consent";
import { boundPlacements, checkDataAnswer, fieldVisible, fitProblems, missingFormRequired, unsoundAnswers, type DataAnswerInput, type DataField, type FormDefinition, type FormValue, type SignerFormView } from "../forms";
import type { RejectedAnswer, SaveAnswersResult } from "../forms/api-types";
import type { Issue } from "../rules";
import { checkCode, CODE_SENDS_PER_HOUR, CODE_TTL_MS, generateCode, hashCode, hashToken, isPlausibleToken, type CodeCheck } from "../tokens";
import { deliverCode, deliverOutcome, deliverInvitation, type Delivery } from "../notify";
import type { PlacedField } from "../pdf/types";
import { checkAnswer, fieldsForRole, missingRequired, type AnswerInput, type StoredAnswer } from "../rules";
import { getFile } from "../storage";
import type { Invitation, SignDocumentRow, SignSettingsRow, SignSignerRow } from "../types";
import { docFacts } from "./send";
import { loadSenderAndWorkspace, loadSettings, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf, formState, loadAnswerRows, loadFormState, ownDataFields, recordPartChanges, recordSaved, rolePartsOf, roleHasParts, signerFormView, standing, type FormState } from "./form-state";
import { prefillAnswers, writeBackToContact } from "./writeback";

export interface Lookup {
  signer: SignSignerRow;
  doc: SignDocumentRow;
  secret: { signer_id: string; code_hash: string | null; code_expires_at: string | null; code_attempts: number };
}

/** Find the signer a link belongs to. Null for anything that is not a live link. */
export async function lookupByToken(admin: SignCtx["admin"], token: unknown): Promise<Lookup | null> {
  if (!isPlausibleToken(token)) return null;
  const s = await admin.from("sign_signer_secrets").select("signer_id, code_hash, code_expires_at, code_attempts").eq("token_hash", hashToken(token)).maybeSingle();
  if (s.error || !s.data) return null;
  const secret = s.data as Lookup["secret"];
  const sg = await admin.from("sign_signers").select("*").eq("id", secret.signer_id).maybeSingle();
  if (sg.error || !sg.data) return null;
  const signer = sg.data as SignSignerRow;
  const d = await admin.from("sign_documents").select("*").eq("id", signer.document_id).eq("account_id", signer.account_id).maybeSingle();
  if (d.error || !d.data) return null;
  return { signer, doc: d.data as SignDocumentRow, secret };
}

/** A context for acting as the signer's workspace (no signed-in person). */
export function signerCtx(base: Omit<SignCtx, "accountId" | "userId">, lookup: Lookup): SignCtx {
  return { ...base, accountId: lookup.signer.account_id, userId: null };
}

// ---- what the page shows -------------------------------------------------------------------

/** The state a signer's page is in. `active` is the only one in which anything can be done. */
export type PageState = "active" | "signed" | "sealing" | "completed" | "declined" | "expired" | "voided" | "failed" | "not_invited";

export function pageState(doc: SignDocumentRow, signer: SignSignerRow): PageState {
  switch (doc.status) {
    case "completed":
      return "completed";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "voided":
      return "voided";
    case "failed":
      return signer.status === "signed" ? "signed" : "failed";
    case "sealing":
      return "sealing";
    case "sent":
    case "in_progress":
      if (signer.status === "signed") return "signed";
      if (signer.status === "declined") return "declined";
      if (signer.status === "pending") return "not_invited";
      return "active";
    default:
      return "not_invited";
  }
}

export interface OtherSigner {
  name: string;
  roleKey: string;
  kind: "signer" | "filler";
  status: SignSignerRow["status"];
  orderNo: number;
  signedAt: string | null;
}

export interface SigningView {
  state: PageState;
  /** The code is needed (and not yet entered) before any of the document is shown. */
  needsCode: boolean;
  /** The signer has not yet agreed to sign electronically. */
  needsConsent: boolean;
  consent: { text: string; version: string };
  document: {
    title: string;
    reference: string | null;
    pageCount: number | null;
    locale: SignDocumentRow["locale"];
    expiresAt: string | null;
    message: string | null;
    signInOrder: boolean;
    codeRequired: boolean;
  };
  workspace: { name: string; logoUrl: string | null };
  signer: { name: string; roleKey: string; kind: "signer" | "filler"; status: SignSignerRow["status"] };
  /** Present once the code (if any) is entered and the document can be shown. */
  content: null | {
    fields: PlacedField[];
    /** What this signer has entered so far. */
    answers: Record<string, StoredAnswer>;
    /** What earlier signers entered, to show on the page (read only). */
    othersAnswers: Record<string, StoredAnswer>;
    others: OtherSigner[];
    /** Required fields of this signer not yet answered. */
    missing: string[];
    /** Forms: this signer's parts, answers and progress; null for a document that is only fields on the page. */
    form?: SignerFormView | null;
  };
}

async function loadAllSigners(ctx: SignCtx, documentId: string): Promise<SignSignerRow[]> {
  const { data, error } = await ctx.admin.from("sign_signers").select("*").eq("document_id", documentId).eq("account_id", ctx.accountId).order("order_no").order("created_at");
  if (error) raiseDatabaseError(error, "load signers");
  return (data ?? []) as SignSignerRow[];
}

/** The consent wording that applies to a document: its category's own text over the workspace's. */
async function consentTexts(ctx: SignCtx, doc: SignDocumentRow, settings: SignSettingsRow): Promise<Record<string, string>> {
  if (!doc.category_id) return settings.consent_texts ?? {};
  const { data } = await ctx.admin.from("sign_categories").select("consent_text").eq("id", doc.category_id).eq("account_id", ctx.accountId).maybeSingle();
  const own = (data as { consent_text?: Record<string, string> | null } | null)?.consent_text;
  return { ...(settings.consent_texts ?? {}), ...(own && typeof own === "object" ? own : {}) };
}

export async function buildView(ctx: SignCtx, lookup: Lookup, sessionOk: boolean): Promise<SigningView> {
  const { doc, signer } = lookup;
  const [settings, info] = await Promise.all([loadSettings(ctx), loadSenderAndWorkspace(ctx, doc.created_by)]);
  const state = pageState(doc, signer);
  const consent = consentFor(await consentTexts(ctx, doc, settings), signer.locale ?? doc.locale);
  const needsCode = doc.code_required && !sessionOk && (state === "active" || state === "signed");
  const base: SigningView = {
    state,
    needsCode,
    needsConsent: state === "active" && !signer.consented_at,
    consent: { text: consent.text, version: consent.version },
    document: {
      title: doc.title,
      reference: doc.reference,
      pageCount: doc.page_count,
      locale: signer.locale ?? doc.locale,
      expiresAt: doc.expires_at,
      message: doc.message,
      signInOrder: doc.sign_in_order,
      codeRequired: doc.code_required,
    },
    workspace: { name: info.workspaceName, logoUrl: info.logoUrl },
    signer: { name: signer.full_name, roleKey: signer.role_key, kind: signer.kind, status: signer.status },
    content: null,
  };
  if (needsCode || state === "not_invited") return base;

  const form = formOf(doc);
  const dataKeys = new Set(form ? form.fields.map((f) => f.key) : []);
  const [rows, signers] = await Promise.all([loadAnswerRows(ctx, doc.id), loadAllSigners(ctx, doc.id)]);
  // the first time a signer with a form is shown it, their unanswered fields start from the contact and the defaults
  if (form && roleHasParts(form, signer.role_key) && state === "active" && !signer.viewed_at) {
    rows.push(...(await prefillAnswers(ctx, doc, signer, form, formState(form, signers, rows))));
  }

  const mine: Record<string, StoredAnswer> = {};
  const others: Record<string, StoredAnswer> = {};
  const signedIds = new Set(signers.filter((s) => s.status === "signed").map((s) => s.id));
  for (const a of rows) {
    if (!a.value || dataKeys.has(a.field_key)) continue; // a form's answers go through `form`, never as placed-field answers
    const value = a.value as StoredAnswer;
    if (a.signer_id === signer.id) mine[a.field_key] = value;
    else if (signedIds.has(a.signer_id)) others[a.field_key] = value;
  }
  const answered = new Set(Object.keys(mine));
  base.content = {
    fields: doc.fields_snapshot,
    answers: mine,
    othersAnswers: others,
    others: signers.filter((s) => s.id !== signer.id).map((s) => ({ name: s.full_name, roleKey: s.role_key, kind: s.kind, status: s.status, orderNo: s.order_no, signedAt: s.signed_at })),
    missing: missingRequired(doc.fields_snapshot, signer.role_key, answered).map((f) => f.key),
    form: form && roleHasParts(form, signer.role_key) ? signerFormView(form, signer, formState(form, signers, rows)) : null,
  };
  return base;
}

// ---- first look, code, consent ----------------------------------------------------------------

/** Record that the signer opened their link (once). */
export async function markViewed(ctx: SignCtx, lookup: Lookup, ip: string | null, device: string | null): Promise<void> {
  if (pageState(lookup.doc, lookup.signer) !== "active") return;
  await ctx.admin.rpc("sign_mark_viewed", { p_signer: lookup.signer.id, p_ip: ip, p_device: device });
}

export type CodeSendResult = { ok: true; delivery: Delivery } | { ok: false; reason: "not_needed" | "rate_limited" };

/** Make a code and send it by email to the address the document was sent to. */
export async function sendCode(ctx: SignCtx, lookup: Lookup, rateLimit: (key: string, limit: number, windowMs: number) => Promise<boolean>): Promise<CodeSendResult> {
  const { doc, signer } = lookup;
  const state = pageState(doc, signer);
  // a code is also asked for when a finished document is opened, to download the signed copy
  if (!doc.code_required || (state !== "active" && state !== "signed" && state !== "completed")) return { ok: false, reason: "not_needed" };
  if (!(await rateLimit(`sign:code:${signer.id}`, CODE_SENDS_PER_HOUR, 3600_000))) return { ok: false, reason: "rate_limited" };
  const code = generateCode();
  const { error } = await ctx.admin
    .from("sign_signer_secrets")
    .update({ code_hash: hashCode(code, signer.id), code_expires_at: new Date(ctx.now().getTime() + CODE_TTL_MS).toISOString(), code_attempts: 0 })
    .eq("signer_id", signer.id)
    .eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "store code");
  const info = await loadSenderAndWorkspace(ctx, doc.created_by);
  const settings = await loadSettings(ctx);
  const delivery = await deliverCode(ctx.deps, docFacts(doc, ctx), { name: info.workspaceName, senderName: info.senderName, settings, timeZone: info.timeZone }, signer.email, code);
  await logEvent(ctx, doc.id, "code_sent", { actor: "system", signerId: signer.id, detail: { status: delivery.status } });
  return { ok: true, delivery };
}

/** Check an entered code. The try is counted in the database before the comparison, so guesses cannot race. */
export async function verifyCode(ctx: SignCtx, lookup: Lookup, entered: string, ip: string | null, device: string | null): Promise<CodeCheck> {
  const { signer } = lookup;
  const { data, error } = await ctx.admin.rpc("sign_code_attempt", { p_signer: signer.id });
  if (error || !data) raiseDatabaseError(error, "code attempt");
  const result = checkCode(data as { code_hash: string | null; code_expires_at: string | null; code_attempts: number }, entered, signer.id, ctx.now());
  if (result.ok) {
    // single use
    await ctx.admin.from("sign_signer_secrets").update({ code_hash: null, code_expires_at: null, code_attempts: 0 }).eq("signer_id", signer.id).eq("account_id", ctx.accountId);
    await logEvent(ctx, lookup.doc.id, "code_verified", { actor: "signer", signerId: signer.id, ip, device });
  } else {
    await logEvent(ctx, lookup.doc.id, "code_failed", { actor: "signer", signerId: signer.id, ip, device, detail: { reason: result.reason } });
  }
  return result;
}

export async function recordConsent(ctx: SignCtx, lookup: Lookup, locale: string | null, ip: string | null, device: string | null): Promise<void> {
  const settings = await loadSettings(ctx);
  const consent = consentFor(await consentTexts(ctx, lookup.doc, settings), lookup.signer.locale ?? lookup.doc.locale);
  const { error } = await ctx.admin.rpc("sign_record_consent", { p_signer: lookup.signer.id, p_version: consent.version, p_locale: locale, p_ip: ip, p_device: device });
  if (error) raiseDatabaseError(error, "record consent");
}

// ---- answers --------------------------------------------------------------------------------------

export function assertOpen(lookup: Lookup): void {
  if (pageState(lookup.doc, lookup.signer) !== "active") throw new SignError("signer_not_open", "This document can no longer be completed.", 409);
}

export function assertConsented(lookup: Lookup): void {
  if (!lookup.signer.consented_at) throw new SignError("consent_required", "Agree to sign electronically first.", 409);
}

/** The fields this signer may answer, by key. */
function answerableFields(doc: SignDocumentRow, signer: SignSignerRow): Map<string, PlacedField> {
  return new Map(fieldsForRole(doc.fields_snapshot, signer.role_key).map((f) => [f.key, f]));
}

/** What a browser may send for one key: a placed field's answer or a form data field's. */
export type AnyAnswerInput = AnswerInput & DataAnswerInput;

interface PendingData {
  key: string;
  field: DataField;
  value: FormValue | null;
}

/**
 * Save entered values (autosave). Each is validated for its field; an empty value clears the answer.
 * Keys are the placed fields of the signer's role and, for a document with a form, the data fields of the
 * parts of their role (checked by the shared module, and only while shown). Returns the keys that were
 * rejected, with the reason, so the screen can mark them. `confirmParts` re-saves a part's answers that came
 * from the contact as the signer's own.
 */
export async function saveAnswers(ctx: SignCtx, lookup: Lookup, input: Record<string, AnyAnswerInput>, opts: { confirmParts?: readonly string[] } = {}): Promise<SaveAnswersResult> {
  assertOpen(lookup);
  assertConsented(lookup);
  const { doc, signer } = lookup;
  const form = formOf(doc);
  const fields = answerableFields(doc, signer);
  const own = form ? ownDataFields(form, signer.role_key) : new Map<string, DataField>();
  const dataKeys = new Set(form ? form.fields.map((f) => f.key) : []);
  const before = form ? (await loadFormState(ctx, doc, form)).state : null;

  const saved: string[] = [];
  const rejected: RejectedAnswer[] = [];
  const upserts: Record<string, unknown>[] = [];
  const clears: string[] = [];
  const pending: PendingData[] = [];
  const row = (key: string, value: unknown) => ({ account_id: ctx.accountId, document_id: doc.id, signer_id: signer.id, field_key: key, value, source: "signer", saved_at: ctx.now().toISOString() });

  for (const [key, raw] of Object.entries(input).slice(0, 400)) {
    const field = fields.get(key);
    if (field) {
      const r = checkAnswer(field, raw);
      if (!r.ok) {
        rejected.push({ field: key, code: r.code });
        continue;
      }
      if (r.value === null) clears.push(key);
      else upserts.push(row(key, r.value));
      saved.push(key);
      continue;
    }
    const data = form && dataKeys.has(key) ? own.get(key) : undefined;
    if (!data) {
      rejected.push({ field: key, code: "not_your_field" });
      continue;
    }
    if (data.locked) {
      rejected.push({ field: key, code: "locked" });
      continue;
    }
    const r = checkDataAnswer(data, raw);
    if (!r.ok) {
      rejected.push({ field: key, code: r.code, ...(r.detail ? { detail: r.detail } : {}) });
      continue;
    }
    pending.push({ key, field: data, value: r.value });
  }

  // A data field is only answerable while it is shown, judged by the answers as they will be once this batch is saved.
  if (form && before) {
    let live = pending;
    for (;;) {
      const next: Record<string, FormValue> = { ...before.map };
      for (const p of live) {
        if (p.value === null) delete next[p.key];
        else next[p.key] = p.value;
      }
      const hidden = live.filter((p) => p.value !== null && !fieldVisible(form, p.field, next));
      if (hidden.length === 0) break;
      for (const p of hidden) rejected.push({ field: p.key, code: "not_shown" });
      live = live.filter((p) => !hidden.includes(p));
    }
    for (const p of live) {
      if (p.value === null) clears.push(p.key);
      else upserts.push(row(p.key, p.value));
      saved.push(p.key);
    }
  }

  if (upserts.length) {
    const { error } = await ctx.admin.from("sign_answers").upsert(upserts, { onConflict: "document_id,signer_id,field_key" });
    if (error) raiseDatabaseError(error, "save answers");
  }
  if (clears.length) {
    const { error } = await ctx.admin.from("sign_answers").delete().eq("document_id", doc.id).eq("signer_id", signer.id).in("field_key", clears);
    if (error) raiseDatabaseError(error, "clear answers");
  }

  let confirmed = 0;
  if (form) {
    for (const partKey of (opts.confirmParts ?? []).slice(0, 20)) {
      if (!rolePartsOf(form, signer.role_key).some((p) => p.key === partKey)) {
        rejected.push({ field: String(partKey), code: "not_your_part" });
        continue;
      }
      const keys = form.fields.filter((f) => f.part === partKey).map((f) => f.key);
      const { error } = await ctx.admin.from("sign_answers").update({ source: "signer" }).eq("document_id", doc.id).eq("signer_id", signer.id).eq("source", "contact").in("field_key", keys);
      if (error) raiseDatabaseError(error, "confirm part");
      confirmed++;
    }
  }

  if (saved.length || confirmed) await recordSaved(ctx, doc, signer, saved.length);
  if (!form || !before) return { saved, rejected };
  const after = (await loadFormState(ctx, doc, form)).state;
  await recordPartChanges(ctx, doc, signer, form, before, after);
  return { saved, rejected, ...standing(form, signer.role_key, after) };
}

// ---- finishing ------------------------------------------------------------------------------------

export interface CompleteResult {
  sealing: boolean;
  /** Who was invited next (only for documents with signing order), with delivery results. */
  invited: { name: string; delivery: Delivery }[];
}

/**
 * The answers of a form that cannot be printed where the document puts them. A signer is held to every answer
 * (the document is theirs to sign as printed); a filler only to their own, since they are the only one who
 * can shorten them.
 */
export async function fitIssues(ctx: SignCtx, doc: SignDocumentRow, form: FormDefinition, state: FormState, only?: ReadonlySet<string>): Promise<Issue[]> {
  if (!doc.base_path || boundPlacements(doc.fields_snapshot).length === 0) return [];
  const base = await getFile(ctx.admin, doc.base_path, ctx.accountId);
  const problems = await fitProblems(base, doc.fields_snapshot, form, state.map, doc.locale);
  return problems.filter((p) => !only || only.has(p.field)).map((p) => ({ code: "answer_does_not_fit", field: p.field, detail: p.placement }));
}

/**
 * Finish: the last answers are saved, every required field must be answered, then the database marks
 * the signer done and decides what comes next (the next step, or sealing). For a document with a form the
 * server decides again, from the stored answers alone, that the signer's parts are complete and sound and
 * that what is printed on the page fits; a browser's idea of "ready" is never trusted. Once the signature is
 * recorded, the answers the signer confirmed are written back to the contact.
 */
export async function completeSigning(
  ctx: SignCtx,
  lookup: Lookup,
  input: Record<string, AnyAnswerInput>,
  meta: { ip: string | null; device: string | null; locale: string | null },
): Promise<CompleteResult> {
  assertOpen(lookup);
  assertConsented(lookup);
  const { doc, signer } = lookup;
  const { rejected } = await saveAnswers(ctx, lookup, input);
  if (rejected.length) throw new SignError("invalid_answers", "Some answers are not valid.", 400, rejected.map((r) => ({ code: r.code, field: r.field, ...(r.detail ? { detail: r.detail } : {}) })));

  const form = formOf(doc);
  const rows = await loadAnswerRows(ctx, doc.id);
  const answered = new Set(rows.filter((a) => a.signer_id === signer.id && a.value).map((a) => a.field_key));
  const missing: Issue[] = missingRequired(doc.fields_snapshot, signer.role_key, answered).map((f) => ({ code: "missing_required", field: f.key }));
  let state: FormState | null = null;
  if (form) {
    state = formState(form, await loadAllSigners(ctx, doc.id), rows);
    missing.push(...missingFormRequired(form, signer.role_key, state.map).map((f) => ({ code: "missing_required", field: f.key })));
  }
  if (missing.length) throw new SignError("missing_required", "Some required fields are not filled in.", 400, missing);

  if (form && state) {
    const unsound = unsoundAnswers(form, signer.role_key, state.map);
    if (unsound.length) throw new SignError("invalid_answers", "Some answers are not valid.", 400, unsound.map((u) => ({ code: u.code, field: u.field })));
    const own = signer.kind === "signer" ? undefined : new Set(ownDataFields(form, signer.role_key).keys());
    const unfit = await fitIssues(ctx, doc, form, state, own);
    if (unfit.length) throw new SignError("answer_does_not_fit", "Some answers are too long for the place they are printed.", 400, unfit);
  }

  const settings = await loadSettings(ctx);
  const consent = consentFor(await consentTexts(ctx, doc, settings), signer.locale ?? doc.locale);
  const { data, error } = await ctx.admin.rpc("sign_complete_signer", {
    p_signer: signer.id,
    p_ip: meta.ip,
    p_device: meta.device,
    p_locale: meta.locale,
    p_consent: consent.version,
  });
  if (error || !data) raiseDatabaseError(error, "complete signer");
  const out = data as { sealing: boolean; invited: Invitation[] };

  // The signature stands; the contact is updated afterwards and a failure there never undoes it.
  if (form && state) await writeBackToContact(ctx, doc, signer, form, state);

  const info = await loadSenderAndWorkspace(ctx, doc.created_by);
  const w = { name: info.workspaceName, senderName: info.senderName, settings, timeZone: info.timeZone };
  const facts = docFacts(doc, ctx);
  const invited: CompleteResult["invited"] = [];
  for (const inv of out.invited ?? []) {
    const delivery = await deliverInvitation(ctx.admin, ctx.deps, ctx.origin, facts, w, inv, { fill: inv.kind === "filler" });
    if (delivery.status !== "sent") {
      await logEvent(ctx, doc.id, "delivery_failed", { actor: "system", signerId: inv.signer_id, detail: { channel: delivery.channel, status: delivery.status, reason: delivery.detail ?? null } });
    }
    invited.push({ name: inv.name, delivery });
  }
  return { sealing: !!out.sealing, invited };
}

export async function declineSigning(ctx: SignCtx, lookup: Lookup, reason: string | null, meta: { ip: string | null; device: string | null }): Promise<void> {
  assertOpen(lookup);
  const { error } = await ctx.admin.rpc("sign_decline_signer", { p_signer: lookup.signer.id, p_reason: reason, p_ip: meta.ip, p_device: meta.device });
  if (error) raiseDatabaseError(error, "decline");
  // Tell the sender, and the others who had been invited and had not finished.
  const info = await loadSenderAndWorkspace(ctx, lookup.doc.created_by);
  const settings = await loadSettings(ctx);
  const w = { name: info.workspaceName, senderName: info.senderName, settings, timeZone: info.timeZone };
  const facts = docFacts(lookup.doc, ctx);
  const outcome = { kind: "declined" as const, by: lookup.signer.full_name, reason };
  if (info.senderEmail) await deliverOutcome(ctx.deps, facts, w, { name: info.senderName, email: info.senderEmail, channel: "email", locale: lookup.doc.locale }, outcome);
  const all = await loadAllSigners(ctx, lookup.doc.id);
  for (const s of all.filter((x) => x.id !== lookup.signer.id && x.invited_at && x.status !== "signed")) {
    await deliverOutcome(ctx.deps, facts, w, { name: s.full_name, email: s.email, channel: s.channel, locale: lookup.doc.locale }, outcome);
  }
}

// ---- the file -------------------------------------------------------------------------------------

/** The bytes a signer may see: the document as sent while it is open, the sealed copy once it is complete. */
export async function fileForSigner(ctx: SignCtx, lookup: Lookup, sessionOk: boolean): Promise<{ bytes: Uint8Array; filename: string; kind: "base" | "final" } | null> {
  const state = pageState(lookup.doc, lookup.signer);
  if (lookup.doc.code_required && !sessionOk && (state === "active" || state === "signed" || state === "completed")) return null;
  if (state === "completed" && lookup.doc.final_path) {
    const bytes = await getFile(ctx.admin, lookup.doc.final_path, ctx.accountId);
    return { bytes, filename: `${lookup.doc.reference ?? "document"}-signed.pdf`, kind: "final" };
  }
  if ((state === "active" || state === "signed" || state === "sealing") && lookup.doc.base_path) {
    const bytes = await getFile(ctx.admin, lookup.doc.base_path, ctx.accountId);
    return { bytes, filename: `${lookup.doc.reference ?? "document"}.pdf`, kind: "base" };
  }
  return null;
}

export type { SignSettingsRow };
