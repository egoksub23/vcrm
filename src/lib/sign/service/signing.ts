// ============================================================
// The signer's side: what a person sees and does with their link. No login: the link's token is
// looked up by its hash, and a code (when the document asks for one) is checked before anything of the
// document is shown. Every state change goes through the database functions of migration 158.
// ============================================================

import { consentFor } from "../consent";
import { checkCode, CODE_SENDS_PER_HOUR, CODE_TTL_MS, generateCode, hashCode, hashToken, isPlausibleToken, type CodeCheck } from "../tokens";
import { deliverCode, deliverOutcome, deliverInvitation, type Delivery } from "../notify";
import type { PlacedField } from "../pdf/types";
import { checkAnswer, fieldsForRole, missingRequired, type AnswerInput, type StoredAnswer } from "../rules";
import { getFile } from "../storage";
import type { Invitation, SignDocumentRow, SignSettingsRow, SignSignerRow } from "../types";
import { docFacts } from "./send";
import { loadSenderAndWorkspace, loadSettings, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

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
  workspace: { name: string };
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
  };
}

async function loadAnswers(ctx: SignCtx, documentId: string): Promise<{ signer_id: string; field_key: string; value: StoredAnswer | null }[]> {
  const { data, error } = await ctx.admin.from("sign_answers").select("signer_id, field_key, value").eq("document_id", documentId).eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "load answers");
  return (data ?? []) as { signer_id: string; field_key: string; value: StoredAnswer | null }[];
}

async function loadAllSigners(ctx: SignCtx, documentId: string): Promise<SignSignerRow[]> {
  const { data, error } = await ctx.admin.from("sign_signers").select("*").eq("document_id", documentId).eq("account_id", ctx.accountId).order("order_no").order("created_at");
  if (error) raiseDatabaseError(error, "load signers");
  return (data ?? []) as SignSignerRow[];
}

export async function buildView(ctx: SignCtx, lookup: Lookup, sessionOk: boolean): Promise<SigningView> {
  const { doc, signer } = lookup;
  const [settings, info] = await Promise.all([loadSettings(ctx), loadSenderAndWorkspace(ctx, doc.created_by)]);
  const state = pageState(doc, signer);
  const consent = consentFor(settings.consent_texts, signer.locale ?? doc.locale);
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
    workspace: { name: info.workspaceName },
    signer: { name: signer.full_name, roleKey: signer.role_key, kind: signer.kind, status: signer.status },
    content: null,
  };
  if (needsCode || state === "not_invited") return base;

  const [answers, signers] = await Promise.all([loadAnswers(ctx, doc.id), loadAllSigners(ctx, doc.id)]);
  const mine: Record<string, StoredAnswer> = {};
  const others: Record<string, StoredAnswer> = {};
  const signedIds = new Set(signers.filter((s) => s.status === "signed").map((s) => s.id));
  for (const a of answers) {
    if (!a.value) continue;
    if (a.signer_id === signer.id) mine[a.field_key] = a.value;
    else if (signedIds.has(a.signer_id)) others[a.field_key] = a.value;
  }
  const answered = new Set(Object.keys(mine));
  base.content = {
    fields: doc.fields_snapshot,
    answers: mine,
    othersAnswers: others,
    others: signers.filter((s) => s.id !== signer.id).map((s) => ({ name: s.full_name, roleKey: s.role_key, kind: s.kind, status: s.status, orderNo: s.order_no, signedAt: s.signed_at })),
    missing: missingRequired(doc.fields_snapshot, signer.role_key, answered).map((f) => f.key),
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
  if (!doc.code_required || pageState(doc, signer) !== "active" && pageState(doc, signer) !== "signed") return { ok: false, reason: "not_needed" };
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
  const consent = consentFor(settings.consent_texts, lookup.signer.locale ?? lookup.doc.locale);
  const { error } = await ctx.admin.rpc("sign_record_consent", { p_signer: lookup.signer.id, p_version: consent.version, p_locale: locale, p_ip: ip, p_device: device });
  if (error) raiseDatabaseError(error, "record consent");
}

// ---- answers --------------------------------------------------------------------------------------

function assertOpen(lookup: Lookup): void {
  if (pageState(lookup.doc, lookup.signer) !== "active") throw new SignError("signer_not_open", "This document can no longer be completed.", 409);
}

/** The fields this signer may answer, by key. */
function answerableFields(doc: SignDocumentRow, signer: SignSignerRow): Map<string, PlacedField> {
  return new Map(fieldsForRole(doc.fields_snapshot, signer.role_key).map((f) => [f.key, f]));
}

/**
 * Save entered values (autosave). Each is validated for its field; an empty value clears the answer.
 * Returns the keys that were rejected, with the reason, so the screen can mark them.
 */
export async function saveAnswers(ctx: SignCtx, lookup: Lookup, input: Record<string, AnswerInput>): Promise<{ saved: string[]; rejected: { field: string; code: string }[] }> {
  assertOpen(lookup);
  if (!lookup.signer.consented_at) throw new SignError("consent_required", "Agree to sign electronically first.", 409);
  const fields = answerableFields(lookup.doc, lookup.signer);
  const saved: string[] = [];
  const rejected: { field: string; code: string }[] = [];
  const upserts: Record<string, unknown>[] = [];
  const clears: string[] = [];
  for (const [key, raw] of Object.entries(input).slice(0, 400)) {
    const field = fields.get(key);
    if (!field) {
      rejected.push({ field: key, code: "not_your_field" });
      continue;
    }
    const r = checkAnswer(field, raw);
    if (!r.ok) {
      rejected.push({ field: key, code: r.code });
      continue;
    }
    if (r.value === null) clears.push(key);
    else
      upserts.push({
        account_id: ctx.accountId,
        document_id: lookup.doc.id,
        signer_id: lookup.signer.id,
        field_key: key,
        value: r.value,
        source: "signer",
        saved_at: ctx.now().toISOString(),
      });
    saved.push(key);
  }
  if (upserts.length) {
    const { error } = await ctx.admin.from("sign_answers").upsert(upserts, { onConflict: "document_id,signer_id,field_key" });
    if (error) raiseDatabaseError(error, "save answers");
  }
  if (clears.length) {
    const { error } = await ctx.admin.from("sign_answers").delete().eq("document_id", lookup.doc.id).eq("signer_id", lookup.signer.id).in("field_key", clears);
    if (error) raiseDatabaseError(error, "clear answers");
  }
  return { saved, rejected };
}

// ---- finishing ------------------------------------------------------------------------------------

export interface CompleteResult {
  sealing: boolean;
  /** Who was invited next (only for documents with signing order), with delivery results. */
  invited: { name: string; delivery: Delivery }[];
}

/**
 * Finish: the last answers are saved, every required field must be answered, then the database marks
 * the signer done and decides what comes next (the next step, or sealing).
 */
export async function completeSigning(
  ctx: SignCtx,
  lookup: Lookup,
  input: Record<string, AnswerInput>,
  meta: { ip: string | null; device: string | null; locale: string | null },
): Promise<CompleteResult> {
  assertOpen(lookup);
  if (!lookup.signer.consented_at) throw new SignError("consent_required", "Agree to sign electronically first.", 409);
  const { rejected } = await saveAnswers(ctx, lookup, input);
  if (rejected.length) throw new SignError("invalid_answers", "Some answers are not valid.", 400, rejected.map((r) => ({ code: r.code, field: r.field })));

  const answers = await loadAnswers(ctx, lookup.doc.id);
  const answered = new Set(answers.filter((a) => a.signer_id === lookup.signer.id && a.value).map((a) => a.field_key));
  const missing = missingRequired(lookup.doc.fields_snapshot, lookup.signer.role_key, answered);
  if (missing.length) throw new SignError("missing_required", "Some required fields are not filled in.", 400, missing.map((f) => ({ code: "missing_required", field: f.key })));

  const settings = await loadSettings(ctx);
  const consent = consentFor(settings.consent_texts, lookup.signer.locale ?? lookup.doc.locale);
  const { data, error } = await ctx.admin.rpc("sign_complete_signer", {
    p_signer: lookup.signer.id,
    p_ip: meta.ip,
    p_device: meta.device,
    p_locale: meta.locale,
    p_consent: consent.version,
  });
  if (error || !data) raiseDatabaseError(error, "complete signer");
  const out = data as { sealing: boolean; invited: Invitation[] };

  const info = await loadSenderAndWorkspace(ctx, lookup.doc.created_by);
  const w = { name: info.workspaceName, senderName: info.senderName, settings, timeZone: info.timeZone };
  const facts = docFacts(lookup.doc, ctx);
  const invited: CompleteResult["invited"] = [];
  for (const inv of out.invited ?? []) {
    const delivery = await deliverInvitation(ctx.admin, ctx.deps, ctx.origin, facts, w, inv, { fill: inv.kind === "filler" });
    if (delivery.status !== "sent") {
      await logEvent(ctx, lookup.doc.id, "delivery_failed", { actor: "system", signerId: inv.signer_id, detail: { channel: delivery.channel, status: delivery.status, reason: delivery.detail ?? null } });
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
