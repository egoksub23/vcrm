// ============================================================
// The signer's side: what a person sees and does with their link. No login: the link's token is
// looked up by its hash, and a code (when the document asks for one) is checked before anything of the
// document is shown. Every state change goes through the database functions of migration 158.
// ============================================================

import { consentFor } from "../consent";
import { boundPlacements, checkDataAnswer, fieldVisible, fitProblems, type DataAnswerInput, type DataField, type FormDefinition, type FormValue, type SignerFormView } from "../forms";
import { delegationsOf, forwardsLeft, isDelegate, openDelegations, partsAnswered, type Delegation } from "../forward";
import type { RejectedAnswer, SaveAnswersResult } from "../forms/api-types";
import type { Issue } from "../rules";
import { checkCode, CODE_SENDS_PER_HOUR, CODE_TTL_MS, generateCode, hashCode, hashToken, isPlausibleToken, type CodeCheck } from "../tokens";
import { deliverCode, deliverOutcome, deliverInvitation, type Delivery } from "../notify";
import type { PlacedField } from "../pdf/types";
import { SENDER_ROLE, checkAnswer, fieldsForRole, missingRequired, type AnswerInput, type StoredAnswer } from "../rules";
import { certificateFileName, signedFileName } from "../file-names";
import { getFile } from "../storage";
import { isFormMode, type Invitation, type SignDocumentRow, type SignEnvelopeRow, type SignMode, type SignSettingsRow, type SignSignerRow } from "../types";
import { planEnvelopeZip, planZip, zipStream } from "./export";
import { docFacts } from "./send";
import { emitSignEvent } from "./outbound";
import { loadSenderAndWorkspace, loadSettings, logEvent, type SignCtx } from "./context";
import { deliverEnvelopeInvitations, notifyEnvelopeEnded } from "./envelope-delivery";
import { loadEnvelope, loadEnvelopeDocuments } from "./envelope-data";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf, formState, loadAnswerRows, loadFormState, missingFor, ownDataFieldsFor, recordPartChanges, recordSaved, roleHasParts, signerFormView, standing, unsoundFor, type FormState } from "./form-state";
import { sealAnswer } from "./sensitive";
import { prefillAnswers, writeBackToContact } from "./writeback";

/** One document of a person of an envelope, with that person's row on it. */
export interface PartyMember {
  signer: SignSignerRow;
  doc: SignDocumentRow;
}

/** A person of an envelope: the envelope and every document they are a signer of (their own rows only), in the envelope's order. */
export interface Party {
  envelope: SignEnvelopeRow;
  members: PartyMember[];
}

export interface Lookup {
  /** The person's row on the document the page is about (the one the link belongs to, unless a document of the envelope was asked for). */
  signer: SignSignerRow;
  doc: SignDocumentRow;
  secret: { signer_id: string; code_hash: string | null; code_expires_at: string | null; code_attempts: number };
  /** The row the link belongs to (an envelope: the person's first document). The code, its session cookie and its tries are this row's. */
  tokenSigner: SignSignerRow;
  /** Migration 171: the person's documents when the link is for an envelope; null for a document on its own. */
  party: Party | null;
}

/**
 * The person's documents of an envelope, found through the link's own row: only the rows that carry its party id, only on documents of
 * the same envelope. A document the person is not a signer of is never in the answer, and neither is anyone else's row. Null when it
 * cannot be read (the link then shows nothing rather than half an envelope).
 */
async function loadParty(admin: SignCtx["admin"], signer: SignSignerRow, doc: SignDocumentRow): Promise<Party | null> {
  if (!signer.party_id || !doc.envelope_id) return null;
  // only a person's own anchor row has a link, and the party id is that row's own id: a row that names another row's party is not a link
  if (signer.party_id !== signer.id) return null;
  const rows = await admin.from("sign_signers").select("*").eq("party_id", signer.party_id).eq("account_id", signer.account_id);
  if (rows.error || !rows.data) return null;
  const mine = rows.data as SignSignerRow[];
  const docs = await admin.from("sign_documents").select("*").in("id", mine.map((r) => r.document_id)).eq("account_id", signer.account_id).eq("envelope_id", doc.envelope_id);
  const env = await admin.from("sign_envelopes").select("*").eq("id", doc.envelope_id).eq("account_id", signer.account_id).maybeSingle();
  if (docs.error || !docs.data || env.error || !env.data) return null;
  const byDoc = new Map((docs.data as SignDocumentRow[]).map((d) => [d.id, d]));
  const members = mine
    .flatMap((r) => (byDoc.has(r.document_id) ? [{ signer: r, doc: byDoc.get(r.document_id)! }] : []))
    .sort((a, b) => (a.doc.envelope_position ?? 0) - (b.doc.envelope_position ?? 0));
  if (!members.some((m) => m.signer.id === signer.id)) return null;
  return { envelope: env.data as SignEnvelopeRow, members };
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
  const doc = d.data as SignDocumentRow;
  if (!signer.party_id) return { signer, doc, secret, tokenSigner: signer, party: null };
  const party = await loadParty(admin, signer, doc);
  return party ? { signer, doc, secret, tokenSigner: signer, party } : null;
}

/**
 * The same link, about another document of the same envelope: the person's own row on it. Null when the link is not an envelope's or
 * the person is not a signer of that document, so a document id taken from anywhere else never reaches anyone's rows.
 */
export function pickDocument(lookup: Lookup, documentId: string): Lookup | null {
  const member = lookup.party?.members.find((m) => m.doc.id === documentId);
  return member ? { ...lookup, signer: member.signer, doc: member.doc } : null;
}

/** Does any document of this link ask for the code? (An envelope's documents all say the same; the cookie belongs to the link's own row.) */
export const codeRequiredFor = (lookup: Pick<Lookup, "doc" | "party">): boolean => (lookup.party ? lookup.party.members.some((m) => m.doc.code_required) : lookup.doc.code_required);

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

/** What a signer may do about forwarding (migration 166); present only while the sender allows it and the person can still act. */
export interface ForwardingView {
  /** The whole turn may be handed to someone else. */
  canTurn: boolean;
  /** A part of the form may be handed to someone else. */
  canPart: boolean;
  /** How many more forwards this position may make. */
  remaining: number;
}

/** One document of the person's envelope, as the page lists it. */
export interface EnvelopeDocView {
  id: string;
  position: number;
  title: string;
  reference: string | null;
  pageCount: number | null;
  mode: SignMode;
  /** What the page would be for this person on that document (`active` is the ones still to do). */
  state: PageState;
  /** Migration 178: the document is complete and its certificate is a file of its own (offered as a download beside the signed file). */
  hasCertificate?: boolean;
}

/** Migration 171: the person's whole sitting. Present when the link is for an envelope. */
export interface EnvelopeView {
  title: string;
  reference: string | null;
  /** How many documents the person is on. */
  count: number;
  /** The document this view is about. */
  current: string;
  /** What the person's sitting is as a whole (`active` while anything is still to do). */
  state: PageState;
  /** Empty until the code (if one is asked for) is entered: nothing of the envelope but its title and count is shown before. */
  documents: EnvelopeDocView[];
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
    /** A form without a signature: the page says "submit", shows no document and asks nobody to sign (migration 169). Absent is `sign`. */
    mode?: SignMode;
    /** Sent from a template to try it out (F-10): the page says TEST. Absent for a real document. */
    test?: boolean;
    /** Migration 178: the document is complete and its certificate is a file of its own (offered as a download beside the signed file). Absent when it is inside the signed file. */
    hasCertificate?: boolean;
  };
  /** Migration 171: this link is for an envelope; the document above is the one asked for, and this lists them all. */
  envelope?: EnvelopeView;
  workspace: { name: string; logoUrl: string | null };
  signer: { name: string; roleKey: string; kind: "signer" | "filler"; status: SignSignerRow["status"] };
  /** This person was handed parts of someone else's form (they complete those parts, never sign, and see nothing else). */
  delegate?: boolean;
  /** The name of the person who handed this turn or these parts over, to say who asked. */
  forwardedFrom?: string | null;
  forwarding?: ForwardingView | null;
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
    /** Forms: the parts this signer handed to someone, and whether each is complete. */
    delegations?: Delegation[];
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

/**
 * What the person agrees to: the wording of their link. For a document on its own that is its own (its category's text over the
 * workspace's); for an envelope it is the FIRST document's, in the person's language, whichever document is on the screen, so the
 * version recorded on every document is the same words. A form without a signature says "submit" only when every document is one.
 */
export async function consentOf(ctx: SignCtx, lookup: Lookup, settings: SignSettingsRow) {
  const lead = lookup.party ? lookup.party.members[0].doc : lookup.doc;
  const mode: SignMode = lookup.party ? (lookup.party.members.every((m) => isFormMode(m.doc)) ? "form" : "sign") : lookup.doc.mode;
  return consentFor(await consentTexts(ctx, lead, settings), lookup.tokenSigner.locale ?? lookup.signer.locale ?? lead.locale, mode);
}

/** What the person's sitting is as a whole, from the state of each document for them. */
export function envelopeState(states: readonly PageState[]): PageState {
  for (const bad of ["declined", "voided", "expired", "failed"] as const) if (states.includes(bad)) return bad;
  if (states.includes("active")) return "active";
  if (states.length > 0 && states.every((s) => s === "not_invited")) return "not_invited";
  if (states.length > 0 && states.every((s) => s === "completed")) return "completed";
  if (states.includes("not_invited")) return "not_invited";
  // A document the person has signed that is not being sealed yet is waiting for somebody ELSE: the sitting is waiting, and must never read
  // "everyone has signed" because another document of the collection (one only this person is on) happens to be sealing already.
  if (states.includes("signed")) return "signed";
  if (states.includes("sealing")) return "sealing";
  return "signed";
}

function envelopeView(lookup: Lookup, current: PartyMember, withDocuments: boolean): EnvelopeView {
  const party = lookup.party!;
  const documents: EnvelopeDocView[] = party.members.map((m) => ({
    id: m.doc.id,
    position: m.doc.envelope_position ?? 0,
    title: m.doc.title,
    reference: m.doc.reference,
    pageCount: m.doc.page_count,
    mode: isFormMode(m.doc) ? "form" : "sign",
    state: pageState(m.doc, m.signer),
    ...(m.doc.status === "completed" && m.doc.certificate_path ? { hasCertificate: true } : {}),
  }));
  return {
    title: party.envelope.title,
    reference: party.envelope.reference,
    count: party.members.length,
    current: current.doc.id,
    state: envelopeState(documents.map((d) => d.state)),
    documents: withDocuments ? documents : [],
  };
}

/**
 * The placed fields a person's page is given: their own (their role), the sender's (static text, merge and form-printing places), and the places of
 * other people that have been ANSWERED (those people have signed; their answers are drawn read only). A place that belongs to someone else and
 * has no answer yet is not part of this person's page at all: it is not theirs to see, and the server would refuse an answer for it anyway.
 */
export function fieldsShownTo(fields: readonly PlacedField[], signer: Pick<SignSignerRow, "role_key">, answeredByOthers: ReadonlySet<string>): PlacedField[] {
  return fields.filter((f) => f.role === signer.role_key || f.role === SENDER_ROLE || !!f.merge || f.data !== undefined || answeredByOthers.has(f.key));
}

export async function buildView(ctx: SignCtx, lookup: Lookup, sessionOk: boolean): Promise<SigningView> {
  const { doc, signer } = lookup;
  const [settings, info] = await Promise.all([loadSettings(ctx), loadSenderAndWorkspace(ctx, doc.created_by)]);
  const state = pageState(doc, signer);
  const consent = await consentOf(ctx, lookup, settings);
  const needsCode = codeRequiredFor(lookup) && !sessionOk && (state === "active" || state === "signed");
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
      mode: isFormMode(doc) ? "form" : "sign",
      ...(doc.test ? { test: true } : {}),
      ...(doc.status === "completed" && doc.certificate_path ? { hasCertificate: true } : {}),
    },
    workspace: { name: info.workspaceName, logoUrl: info.logoUrl },
    signer: { name: signer.full_name, roleKey: signer.role_key, kind: signer.kind, status: signer.status },
    content: null,
  };
  if (lookup.party) {
    const current = lookup.party.members.find((m) => m.doc.id === doc.id) ?? lookup.party.members[0];
    // the envelope's title and count may be shown before the code; the list of its documents only after
    base.envelope = envelopeView(lookup, current, !needsCode);
    // the person's sitting is what the page is for: it is active while any document is still to do, whichever one is on the screen
    base.needsConsent = base.envelope.state === "active" && lookup.party.members.some((m) => pageState(m.doc, m.signer) === "active" && !m.signer.consented_at);
  }
  if (needsCode || state === "not_invited") return base;

  const form = formOf(doc);
  const dataKeys = new Set(form ? form.fields.map((f) => f.key) : []);
  const [rows, signers] = await Promise.all([loadAnswerRows(ctx, doc.id), loadAllSigners(ctx, doc.id)]);
  const delegate = isDelegate(signer);
  base.delegate = delegate;
  const history = signer.forward_history ?? [];
  base.forwardedFrom = delegate ? (signers.find((x) => x.id === signer.delegated_by)?.full_name ?? null) : (history[history.length - 1]?.name ?? null);
  const left = forwardsLeft(signer);
  base.forwarding = state === "active" && doc.allow_forwarding && !delegate && left > 0 ? { canTurn: true, canPart: !!form && partsAnswered(form, signer, signers).length > 0, remaining: left } : null;
  // the first time a signer with a form is shown it, their unanswered fields start from the contact and the defaults (never a delegate: the contact's details are not theirs to see)
  if (form && !delegate && roleHasParts(form, signer.role_key) && state === "active" && !signer.viewed_at) {
    rows.push(...(await prefillAnswers(ctx, doc, signer, form, formState(form, signers, rows))));
  }
  // a delegate is shown the parts they were handed and nothing else of the document: no pages, no placed fields, nobody else
  if (delegate) {
    base.content = { fields: [], answers: {}, othersAnswers: {}, others: [], missing: [], form: form ? signerFormView(form, signer, formState(form, signers, rows), signers) : null, delegations: [] };
    return base;
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
    fields: fieldsShownTo(doc.fields_snapshot, signer, new Set(Object.keys(others))),
    answers: mine,
    othersAnswers: others,
    // a delegate is the business of the person who handed them a part, not a person of the document
    others: signers.filter((s) => s.id !== signer.id && !isDelegate(s)).map((s) => ({ name: s.full_name, roleKey: s.role_key, kind: s.kind, status: s.status, orderNo: s.order_no, signedAt: s.signed_at })),
    missing: missingRequired(doc.fields_snapshot, signer.role_key, answered).map((f) => f.key),
    form: form && roleHasParts(form, signer.role_key) ? signerFormView(form, signer, formState(form, signers, rows), signers) : null,
    delegations: delegationsOf(signers, signer.id),
  };
  return base;
}

// ---- first look, code, consent ----------------------------------------------------------------

/** Record that the signer opened their link (once). */
export async function markViewed(ctx: SignCtx, lookup: Lookup, ip: string | null, device: string | null): Promise<void> {
  if (lookup.party) {
    // an envelope: the first look marks every document of the person that was sent, once, in one step
    const waiting = lookup.party.members.filter((m) => pageState(m.doc, m.signer) === "active" && m.signer.status === "sent");
    if (waiting.length === 0) return;
    const { data } = await ctx.admin.rpc("sign_envelope_mark_viewed", { p_anchor: lookup.tokenSigner.id, p_ip: ip, p_device: device });
    if (data === true) for (const m of waiting) await emitSignEvent(ctx, m.doc, "viewed", { signerId: m.signer.id });
    return;
  }
  if (pageState(lookup.doc, lookup.signer) !== "active") return;
  const { data } = await ctx.admin.rpc("sign_mark_viewed", { p_signer: lookup.signer.id, p_ip: ip, p_device: device });
  // the database answers true only the first time this person opens the link
  if (data === true) await emitSignEvent(ctx, lookup.doc, "viewed", { signerId: lookup.signer.id });
}

export type CodeSendResult = { ok: true; delivery: Delivery } | { ok: false; reason: "not_needed" | "rate_limited" };

/** Make a code and send it by email to the address the document was sent to. */
export async function sendCode(ctx: SignCtx, lookup: Lookup, rateLimit: (key: string, limit: number, windowMs: number) => Promise<boolean>): Promise<CodeSendResult> {
  // the code belongs to the link's own row (an envelope: the person's first document), whichever document is on the screen
  const { doc } = lookup;
  const signer = lookup.tokenSigner;
  // a code is also asked for when a finished document is opened, to download the signed copy
  const askable = (lookup.party ? lookup.party.members.map((m) => pageState(m.doc, m.signer)) : [pageState(doc, signer)]).some((s) => s === "active" || s === "signed" || s === "completed");
  if (!codeRequiredFor(lookup) || !askable) return { ok: false, reason: "not_needed" };
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
  await logEvent(ctx, signer.document_id, "code_sent", { actor: "system", signerId: signer.id, detail: { status: delivery.status } });
  return { ok: true, delivery };
}

/** Check an entered code. The try is counted in the database before the comparison, so guesses cannot race. */
export async function verifyCode(ctx: SignCtx, lookup: Lookup, entered: string, ip: string | null, device: string | null): Promise<CodeCheck> {
  const signer = lookup.tokenSigner;
  const { data, error } = await ctx.admin.rpc("sign_code_attempt", { p_signer: signer.id });
  if (error || !data) raiseDatabaseError(error, "code attempt");
  const result = checkCode(data as { code_hash: string | null; code_expires_at: string | null; code_attempts: number }, entered, signer.id, ctx.now());
  if (result.ok) {
    // single use
    await ctx.admin.from("sign_signer_secrets").update({ code_hash: null, code_expires_at: null, code_attempts: 0 }).eq("signer_id", signer.id).eq("account_id", ctx.accountId);
    await logEvent(ctx, signer.document_id, "code_verified", { actor: "signer", signerId: signer.id, ip, device });
  } else {
    await logEvent(ctx, signer.document_id, "code_failed", { actor: "signer", signerId: signer.id, ip, device, detail: { reason: result.reason } });
  }
  return result;
}

export async function recordConsent(ctx: SignCtx, lookup: Lookup, locale: string | null, ip: string | null, device: string | null): Promise<void> {
  const settings = await loadSettings(ctx);
  const consent = await consentOf(ctx, lookup, settings);
  // an envelope: once, on every document the person still has to do, in one step (the same words, language and time on each)
  const { error } = lookup.party
    ? await ctx.admin.rpc("sign_envelope_record_consent", { p_anchor: lookup.tokenSigner.id, p_version: consent.version, p_locale: locale, p_ip: ip, p_device: device })
    : await ctx.admin.rpc("sign_record_consent", { p_signer: lookup.signer.id, p_version: consent.version, p_locale: locale, p_ip: ip, p_device: device });
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
  // a delegate fills parts of the form, never the places on the page
  if (isDelegate(signer)) return new Map();
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
  const dataKeys = new Set(form ? form.fields.map((f) => f.key) : []);
  const loaded = form ? await loadFormState(ctx, doc, form) : null;
  const before = loaded?.state ?? null;
  // what this person answers themselves: not a part they handed to someone, and for a delegate only the parts they hold
  const own = form && loaded ? ownDataFieldsFor(form, signer, loaded.signers) : new Map<string, DataField>();

  const saved: string[] = [];
  const rejected: RejectedAnswer[] = [];
  const upserts: Record<string, unknown>[] = [];
  const clears: string[] = [];
  const pending: PendingData[] = [];
  // a sensitive data field is stored only as ciphertext (sensitive.ts)
  const row = (key: string, value: unknown, field?: DataField) => ({ account_id: ctx.accountId, document_id: doc.id, signer_id: signer.id, field_key: key, ...sealAnswer(field, value, { documentId: doc.id, fieldKey: key }), source: isDelegate(signer) ? "forwarded" : "signer", saved_at: ctx.now().toISOString() });

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
      else upserts.push(row(p.key, p.value, p.field));
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
      if (!partsAnswered(form, signer, loaded?.signers ?? []).some((p) => p.key === partKey)) {
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
  const afterLoaded = await loadFormState(ctx, doc, form);
  await recordPartChanges(ctx, doc, signer, form, before, afterLoaded.state);
  return { saved, rejected, ...standing(form, signer, afterLoaded.state, afterLoaded.signers) };
}

// ---- finishing ------------------------------------------------------------------------------------

export interface CompleteResult {
  sealing: boolean;
  /** Who was invited next (only for documents with signing order), with delivery results. */
  invited: { name: string; delivery: Delivery }[];
  /** Asked for with `check`: everything was checked and nothing was changed (an envelope's "next document"). */
  checked?: true;
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
  opts: { check?: boolean } = {},
): Promise<CompleteResult> {
  assertOpen(lookup);
  assertConsented(lookup);
  const { doc, signer } = lookup;
  const { rejected } = await saveAnswers(ctx, lookup, input);
  if (rejected.length) throw new SignError("invalid_answers", "Some answers are not valid.", 400, rejected.map((r) => ({ code: r.code, field: r.field, ...(r.detail ? { detail: r.detail } : {}) })));

  const form = formOf(doc);
  const rows = await loadAnswerRows(ctx, doc.id);
  const answered = new Set(rows.filter((a) => a.signer_id === signer.id && a.value).map((a) => a.field_key));
  // a delegate has no place on the page to fill
  const missing: Issue[] = isDelegate(signer) ? [] : missingRequired(doc.fields_snapshot, signer.role_key, answered).map((f) => ({ code: "missing_required", field: f.key }));
  let state: FormState | null = null;
  const everyone = await loadAllSigners(ctx, doc.id);
  // a part handed to someone must come back (or be taken back) first; the database holds the same line
  if (!isDelegate(signer) && openDelegations(everyone, signer.id).length > 0) throw new SignError("delegation_open", "A part you forwarded is not finished yet. Wait for it, or take it back.", 409);
  if (form) {
    state = formState(form, everyone, rows);
    missing.push(...missingFor(form, signer, state.map).map((f) => ({ code: "missing_required", field: f.key })));
  }
  if (missing.length) throw new SignError("missing_required", "Some required fields are not filled in.", 400, missing);

  if (form && state) {
    const unsound = unsoundFor(form, signer, state.map);
    if (unsound.length) throw new SignError("invalid_answers", "Some answers are not valid.", 400, unsound.map((u) => ({ code: u.code, field: u.field })));
    const own = signer.kind === "signer" ? undefined : new Set(ownDataFieldsFor(form, signer, everyone).keys());
    const unfit = await fitIssues(ctx, doc, form, state, own);
    if (unfit.length) throw new SignError("answer_does_not_fit", "Some answers are too long for the place they are printed.", 400, unfit);
  }

  // `check`: the person only asked whether this document is ready (an envelope's "next document"); every rule above has held, nothing is changed
  if (opts.check) return { sealing: false, invited: [], checked: true };

  const settings = await loadSettings(ctx);
  const consent = await consentOf(ctx, lookup, settings);
  const { data, error } = await ctx.admin.rpc("sign_complete_signer", {
    p_signer: signer.id,
    p_ip: meta.ip,
    p_device: meta.device,
    p_locale: meta.locale,
    p_consent: consent.version,
  });
  if (error || !data) raiseDatabaseError(error, "complete signer");
  const out = data as { sealing: boolean; invited: Invitation[]; envelope_id?: string };

  // The signature stands; the contact is updated afterwards and a failure there never undoes it. A delegate's answers
  // are never written to the contact (it is the signer who confirms them, and an answer typed by someone else is not).
  if (form && state && !isDelegate(signer)) await writeBackToContact(ctx, doc, signer, form, state);

  const info = await loadSenderAndWorkspace(ctx, doc.created_by);
  const w = { name: info.workspaceName, senderName: info.senderName, settings, timeZone: info.timeZone };
  const facts = docFacts(doc, ctx);
  const invited: CompleteResult["invited"] = [];
  // an envelope's next step: ONE message for each person, naming their documents (the database gave one invitation per person)
  const forEnvelope = (out.invited ?? []).filter((i) => !!i.envelope_id);
  if (forEnvelope.length > 0 && out.envelope_id) {
    const [env, docs] = await Promise.all([loadEnvelope(ctx, out.envelope_id), loadEnvelopeDocuments(ctx, out.envelope_id)]);
    for (const r of await deliverEnvelopeInvitations(ctx, env, docs, forEnvelope)) invited.push({ name: r.name, delivery: r.delivery });
  }
  for (const inv of (out.invited ?? []).filter((i) => !i.envelope_id)) {
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
  if (lookup.party) return declineEnvelope(ctx, lookup, reason, meta);
  // a person handed a part of someone else's form cannot end the whole document; the signer who gave it can take it back
  if (isDelegate(lookup.signer)) throw new SignError("delegate_cannot_decline", "This was handed to you to fill in. Tell the person who sent it to you if you cannot.", 409);
  const { error } = await ctx.admin.rpc("sign_decline_signer", { p_signer: lookup.signer.id, p_reason: reason, p_ip: meta.ip, p_device: meta.device });
  if (error) raiseDatabaseError(error, "decline");
  await emitSignEvent(ctx, lookup.doc, "declined", { signerId: lookup.signer.id }); // the automation trigger and the webhook; never throws
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

/**
 * A person declines an envelope: every document that is not yet fully signed is declined in one step (a document that is sealing or
 * completed is left as it is). The sender and the people who were invited and had not finished are told ONCE, not once per document.
 */
async function declineEnvelope(ctx: SignCtx, lookup: Lookup, reason: string | null, meta: { ip: string | null; device: string | null }): Promise<void> {
  const party = lookup.party!;
  const { data, error } = await ctx.admin.rpc("sign_envelope_decline", { p_anchor: lookup.tokenSigner.id, p_reason: reason, p_ip: meta.ip, p_device: meta.device });
  if (error) raiseDatabaseError(error, "decline envelope");
  const declined = new Set(((data ?? {}) as { documents?: string[] }).documents ?? []);
  const [env, docs] = await Promise.all([loadEnvelope(ctx, party.envelope.id), loadEnvelopeDocuments(ctx, party.envelope.id)]);
  for (const d of docs.filter((x) => declined.has(x.id))) await emitSignEvent(ctx, d, "declined", { signerId: party.members.find((m) => m.doc.id === d.id)?.signer.id ?? null }); // never throws
  await notifyEnvelopeEnded(ctx, env, docs, { kind: "declined", by: lookup.signer.full_name, reason }, { except: [lookup.tokenSigner.id] });
}

// ---- the file -------------------------------------------------------------------------------------

/**
 * May this person be handed files at all? A delegate sees their part and nothing else of the document, not the pages and not the signed copy; and when
 * the document asks for a code, the signed files (like the pages) wait for it.
 */
function mayHaveFiles(lookup: Lookup, sessionOk: boolean): boolean {
  if (isDelegate(lookup.signer)) return false;
  const state = pageState(lookup.doc, lookup.signer);
  return !(codeRequiredFor(lookup) && !sessionOk && (state === "active" || state === "signed" || state === "completed"));
}

/** The bytes a signer may see: the document as sent while it is open, the sealed copy once it is complete. */
export async function fileForSigner(ctx: SignCtx, lookup: Lookup, sessionOk: boolean): Promise<{ bytes: Uint8Array; filename: string; kind: "base" | "final" } | null> {
  if (!mayHaveFiles(lookup, sessionOk)) return null;
  const state = pageState(lookup.doc, lookup.signer);
  if (state === "completed" && lookup.doc.final_path) {
    const bytes = await getFile(ctx.admin, lookup.doc.final_path, ctx.accountId);
    return { bytes, filename: signedFileName(lookup.doc), kind: "final" };
  }
  // a form without a signature has no document to read: its base file is only a stand-in, so there is nothing to hand out until the record exists
  if (isFormMode(lookup.doc)) return null;
  if ((state === "active" || state === "signed" || state === "sealing") && lookup.doc.base_path) {
    const bytes = await getFile(ctx.admin, lookup.doc.base_path, ctx.accountId);
    return { bytes, filename: `${lookup.doc.reference ?? "document"}.pdf`, kind: "base" };
  }
  return null;
}

/**
 * The certificate of a completed document, for the person who signed it (migration 178): the file of its own, under the same rules as the signed copy
 * (a code first, never a delegate). Null when there is nothing to hand out: the document is not complete, or its certificate is inside the signed PDF.
 */
export async function certificateForSigner(ctx: SignCtx, lookup: Lookup, sessionOk: boolean): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (!mayHaveFiles(lookup, sessionOk)) return null;
  const { doc } = lookup;
  if (pageState(doc, lookup.signer) !== "completed" || !doc.certificate_path) return null;
  const bytes = await getFile(ctx.admin, doc.certificate_path, ctx.accountId);
  return { bytes, filename: certificateFileName(doc) };
}

/**
 * Everything of a completed document in one zip, for the person who signed it: the signed document and its certificate; for a link that is a document
 * collection's, every completed document of THEIRS with its certificate and a small summary of those documents (a person never gets a document they are
 * not on). Null when there is nothing to hand out. The same rules as the signed copy; the download is not recorded, as the signed copy's never was.
 */
export async function zipForSigner(ctx: SignCtx, lookup: Lookup, sessionOk: boolean): Promise<{ stream: ReadableStream<Uint8Array>; filename: string } | null> {
  if (!mayHaveFiles(lookup, sessionOk)) return null;
  try {
    if (lookup.party) {
      const mine = new Set(lookup.party.members.filter((m) => m.doc.status === "completed").map((m) => m.doc.id));
      if (mine.size === 0) return null;
      const { plan, extras, fileName } = await planEnvelopeZip(ctx, lookup.party.envelope.id, { only: mine });
      return { stream: zipStream(ctx, plan, { extras, log: false }), filename: fileName };
    }
    if (pageState(lookup.doc, lookup.signer) !== "completed") return null;
    const plan = await planZip(ctx, [lookup.doc.id]);
    return { stream: zipStream(ctx, plan, { log: false }), filename: `${lookup.doc.reference ?? "document"}.zip` };
  } catch (err) {
    // "nothing to download" is an answer of "no file", like any other file the person has none of
    if (err instanceof SignError && err.code === "nothing_to_download") return null;
    throw err;
  }
}

export type { SignSettingsRow };
