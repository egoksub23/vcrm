// The database functions of migration 171, in TypeScript, for the services' tests (FakeDb does not run SQL). It mirrors what the functions
// do (the same checks, in the same order, with the same answers) so a test can run an envelope from the first invitation to the
// completion message through the real services. The functions themselves are proved by supabase/ci/verify-171-sign-envelopes.sql; this is
// only the stand-in that lets the orchestration around them be tested. Imported only by tests.

import { randomUUID } from "node:crypto";

import { deriveEnvelopeStatus } from "../envelopes";
import { hashToken } from "../tokens";
import type { DocumentStatus } from "../types";
import type { FakeDb } from "./fake-db";

type Row = Record<string, unknown>;
type Out = { data: unknown; error: { message: string } | null };

const fail = (message: string): Out => ({ data: null, error: { message } });
const ok = (data: unknown): Out => ({ data, error: null });

export interface EnvelopeRpcOptions {
  /** The next link token (64 hex characters). */
  newToken: () => string;
  /** The time the database says it is. */
  now: () => string;
}

/** Install the handlers on a FakeDb. Returns the tokens issued, by signer id (the last one for each). */
export function installEnvelopeRpcs(db: FakeDb, o: EnvelopeRpcOptions) {
  const tokens = new Map<string, string>();
  const docs = () => db.rows("sign_documents");
  const signers = () => db.rows("sign_signers");
  const doc = (id: unknown) => docs().find((d) => d.id === id);
  const signer = (id: unknown) => signers().find((s) => s.id === id);
  const envOf = (id: unknown) => db.rows("sign_envelopes").find((e) => e.id === id);
  const docsOfEnv = (id: unknown) => docs().filter((d) => d.envelope_id === id).sort((a, b) => (a.envelope_position as number) - (b.envelope_position as number));
  const rowsOfParty = (party: unknown) => signers().filter((s) => s.party_id === party);
  const log = (documentId: unknown, type: string, detail: Row = {}) => db.rpcCalls.push({ name: "sign_log", args: { p_document: documentId, p_type: type, p_detail: detail } });

  const refresh = (envelopeId: unknown) => {
    const e = envOf(envelopeId);
    if (e) e.status = deriveEnvelopeStatus(docsOfEnv(envelopeId).map((d) => d.status as DocumentStatus));
  };
  const setDoc = (d: Row, status: string) => {
    d.status = status;
    if (d.envelope_id) refresh(d.envelope_id);
  };

  const issue = (signerId: string): string => {
    const token = o.newToken();
    tokens.set(signerId, token);
    const secrets = (db.tables.sign_signer_secrets ??= []);
    const existing = secrets.find((s) => s.signer_id === signerId);
    const row = { signer_id: signerId, account_id: signer(signerId)!.account_id, token_hash: hashToken(token), code_hash: null, code_expires_at: null, code_attempts: 0 };
    if (existing) Object.assign(existing, row);
    else secrets.push({ id: randomUUID(), ...row });
    return token;
  };
  const brief = (s: Row, token: string | null, extra: Row = {}) => ({ signer_id: s.id, token, name: s.full_name, email: s.email, phone: s.phone ?? null, channel: s.channel ?? "email", role_key: s.role_key, kind: s.kind ?? "signer", order_no: s.order_no, ...extra });

  /** The same step on every open document, in order: one brief per person (the anchor's), a person's other rows are invited without a link. */
  const inviteStep = (envelopeId: string, step: number, ordered: boolean): Row[] => {
    const out: Row[] = [];
    for (const d of docsOfEnv(envelopeId).filter((x) => x.status === "sent" || x.status === "in_progress")) {
      for (const s of signers().filter((x) => x.document_id === d.id && x.status === "pending" && (!ordered || x.order_no === step))) {
        s.status = "sent";
        s.invited_at = o.now();
        log(d.id, "invited", { step });
        if (s.party_id && s.party_id !== s.id) continue;
        out.push(brief(s, issue(s.id as string), { envelope_id: envelopeId }));
      }
    }
    return out;
  };

  db.rpcHandlers.sign_send_envelope = async (a) => {
    const e = envOf(a.p_envelope);
    if (!e) return fail("envelope_not_found");
    if (e.status !== "draft") return fail("envelope_not_draft");
    const mine = docsOfEnv(e.id);
    const bodies = (a.p_docs as { document_id: string; base_path: string; base_sha256: string; page_count: number }[]) ?? [];
    if (mine.length < 2 || mine.length > 6) return fail("envelope_needs_2_to_6_documents");
    if (bodies.length !== mine.length || mine.some((d) => !bodies.find((b) => b.document_id === d.id))) return fail("envelope_documents_mismatch");
    if (mine.some((d) => d.sign_in_order !== e.sign_in_order || d.code_required !== e.code_required)) return fail("envelope_options_differ");
    const rows = signers().filter((s) => mine.some((d) => d.id === s.document_id));
    if (rows.some((s) => !s.party_id)) return fail("envelope_person_without_party");
    for (const d of mine) {
      const b = bodies.find((x) => x.document_id === d.id)!;
      if (!rows.some((s) => s.document_id === d.id)) return fail("document_has_no_signer");
      Object.assign(d, { status: "sent", base_path: b.base_path, base_sha256: b.base_sha256, page_count: b.page_count, expires_at: a.p_expires_at, sent_at: o.now() });
      log(d.id, "sent", { envelope: e.reference });
      log(d.id, "envelope_sent", { envelope_id: e.id });
    }
    Object.assign(e, { sent_at: o.now(), expires_at: a.p_expires_at });
    refresh(e.id);
    const ordered = e.sign_in_order === true;
    const step = ordered ? Math.min(...rows.map((s) => s.order_no as number)) : 1;
    return ok({ reference: e.reference, account_id: e.account_id, envelope_id: e.id, step, documents: mine.map((d) => ({ document_id: d.id, reference: d.reference, position: d.envelope_position })), invited: inviteStep(e.id as string, step, ordered) });
  };

  // migration 174: the new order of ALL the documents of a draft collection, in one step
  db.rpcHandlers.sign_envelope_set_order = async (a) => {
    const e = envOf(a.p_envelope);
    if (!e) return fail("envelope_not_found");
    if (e.status !== "draft") return fail("envelope_not_draft");
    const mine = docsOfEnv(e.id);
    if (mine.some((d) => d.status !== "draft")) return fail("envelope_not_draft");
    const ids = (a.p_ids as string[] | null) ?? [];
    if (ids.length !== mine.length || new Set(ids).size !== ids.length || ids.some((id) => !mine.find((d) => d.id === id))) return fail("envelope_order_mismatch");
    let moved = 0;
    ids.forEach((id, i) => {
      const d = doc(id)!;
      if (d.envelope_position !== i + 1) moved++;
      d.envelope_position = i + 1;
    });
    return ok({ count: mine.length, moved });
  };

  db.rpcHandlers.sign_envelope_mark_viewed = async (a) => {
    const anchor = signer(a.p_anchor);
    if (!anchor?.party_id) return ok(false);
    let any = false;
    for (const s of rowsOfParty(anchor.party_id)) {
      const d = doc(s.document_id)!;
      if (s.status === "sent" && (d.status === "sent" || d.status === "in_progress")) {
        Object.assign(s, { status: "viewed", viewed_at: o.now() });
        log(d.id, "viewed");
        any = true;
      }
    }
    return ok(any);
  };

  db.rpcHandlers.sign_envelope_record_consent = async (a) => {
    const anchor = signer(a.p_anchor);
    if (!anchor?.party_id) return fail("signer_not_open");
    const at = o.now();
    let open = false;
    let did = false;
    for (const s of rowsOfParty(anchor.party_id)) {
      const d = doc(s.document_id)!;
      if (!(d.status === "sent" || d.status === "in_progress") || !(s.status === "sent" || s.status === "viewed")) continue;
      open = true;
      if (s.consented_at) continue;
      Object.assign(s, { consented_at: at, consent_version: a.p_version, locale: a.p_locale ?? s.locale });
      log(d.id, "consented", { version: a.p_version, envelope_id: d.envelope_id });
      did = true;
    }
    return open ? ok(did) : fail("signer_not_open");
  };

  db.rpcHandlers.sign_complete_signer = async (a) => {
    const s = signer(a.p_signer);
    if (!s) return fail("signer_not_found");
    const d = doc(s.document_id)!;
    if (d.status !== "sent" && d.status !== "in_progress") return fail("document_not_open");
    if (s.status === "signed") return fail("already_signed");
    if (s.status !== "sent" && s.status !== "viewed") return fail("signer_not_open");
    if (!s.consented_at) return fail("consent_required");
    Object.assign(s, { status: "signed", signed_at: o.now(), consent_version: a.p_consent ?? s.consent_version });
    if (d.status === "sent") setDoc(d, "in_progress");
    log(d.id, "signed");
    let sealing = false;
    if (!signers().some((x) => x.document_id === d.id && x.status !== "signed")) {
      setDoc(d, "sealing");
      Object.assign(d, { sealing_started_at: null, sealing_attempts: 0 });
      sealing = true;
      log(d.id, "all_signed");
      if (!d.envelope_id) return ok({ sealing: true, invited: [], account_id: d.account_id, reference: d.reference });
    }
    let invited: Row[] = [];
    if (d.envelope_id && d.sign_in_order) {
      const all = signers().filter((x) => docsOfEnv(d.envelope_id).some((y) => y.id === x.document_id));
      if (!all.some((x) => x.order_no === s.order_no && x.status !== "signed")) {
        const next = all.filter((x) => (x.order_no as number) > (s.order_no as number)).map((x) => x.order_no as number);
        if (next.length > 0) invited = inviteStep(d.envelope_id as string, Math.min(...next), true);
      }
    }
    return ok({ sealing, invited, account_id: d.account_id, reference: d.reference, ...(d.envelope_id ? { envelope_id: d.envelope_id } : {}) });
  };

  db.rpcHandlers.sign_envelope_rotate_token = async (a) => {
    const anchor = signer(a.p_anchor);
    if (!anchor?.party_id || anchor.id !== anchor.party_id) return fail("signer_not_open");
    const open = rowsOfParty(anchor.party_id).filter((s) => (s.status === "sent" || s.status === "viewed") && ["sent", "in_progress"].includes(doc(s.document_id)!.status as string));
    if (open.length === 0) return fail("signer_not_open");
    for (const s of open) log(s.document_id, a.p_reason as string);
    return ok(brief(anchor, issue(anchor.id as string), { envelope_id: doc(anchor.document_id)!.envelope_id }));
  };

  db.rpcHandlers.sign_envelope_change_recipient = async (a) => {
    const anchor = signer(a.p_anchor);
    if (!anchor?.party_id || anchor.id !== anchor.party_id) return fail("signer_not_open");
    const mine = rowsOfParty(anchor.party_id);
    if (mine.some((s) => s.status === "signed" || s.status === "declined")) return fail("envelope_person_has_signed");
    const open = mine.filter((s) => ["sent", "in_progress"].includes(doc(s.document_id)!.status as string));
    if (open.length === 0) return fail("signer_not_open");
    for (const s of open) {
      const was = s.status;
      Object.assign(s, { full_name: String(a.p_name).trim(), email: String(a.p_email).trim(), phone: a.p_phone || null, channel: a.p_channel ?? s.channel, status: was === "pending" ? "pending" : "sent", viewed_at: null, ...(was === "pending" ? {} : { consented_at: null, consent_version: null }) });
      log(s.document_id, "recipient_changed");
    }
    return ok(brief(anchor, anchor.status === "pending" ? null : issue(anchor.id as string), { envelope_id: doc(anchor.document_id)!.envelope_id }));
  };

  db.rpcHandlers.sign_envelope_decline = async (a) => {
    const anchor = signer(a.p_anchor);
    if (!anchor?.party_id) return fail("document_not_open");
    const env = doc(anchor.document_id)!.envelope_id;
    const mine = rowsOfParty(anchor.party_id);
    if (!mine.some((s) => (s.status === "sent" || s.status === "viewed") && ["sent", "in_progress"].includes(doc(s.document_id)!.status as string))) return fail("document_not_open");
    const declined: unknown[] = [];
    for (const d of docsOfEnv(env).filter((x) => x.status === "sent" || x.status === "in_progress")) {
      const s = mine.find((x) => x.document_id === d.id);
      if (s && (s.status === "sent" || s.status === "viewed")) Object.assign(s, { status: "declined", declined_at: o.now(), decline_reason: a.p_reason });
      setDoc(d, "declined");
      log(d.id, s ? "declined" : "envelope_declined");
      declined.push(d.id);
    }
    return ok({ account_id: anchor.account_id, envelope_id: env, documents: declined });
  };

  db.rpcHandlers.sign_void_envelope = async (a) => {
    const e = envOf(a.p_envelope);
    if (!e) return fail("envelope_not_found");
    if (e.status === "draft") return fail("envelope_not_sent");
    const mine = docsOfEnv(e.id);
    if (!mine.some((d) => d.status === "sent" || d.status === "in_progress")) return fail("document_already_final");
    if (mine.some((d) => ["sealing", "completed", "failed"].includes(d.status as string))) return fail("envelope_partly_completed");
    for (const d of mine.filter((x) => x.status === "sent" || x.status === "in_progress")) {
      setDoc(d, "voided");
      d.void_reason = a.p_reason;
      log(d.id, "voided");
    }
    e.void_reason = a.p_reason;
    return ok({ account_id: e.account_id, envelope_id: e.id });
  };

  db.rpcHandlers.sign_claim_sealing = async () => ok(docs().filter((d) => d.status === "sealing").map((d) => ({ document_id: d.id, account_id: d.account_id })));
  db.rpcHandlers.sign_fail_sealing = async () => ok(null);
  db.rpcHandlers.sign_finish_sealing = async (a) => {
    const d = doc(a.p_document);
    if (!d || d.status !== "sealing") return fail("document_not_sealing");
    Object.assign(d, { final_path: a.p_final_path, final_sha256: a.p_final_sha256, certificate_path: a.p_certificate_path ?? null, certificate_sha256: a.p_certificate_sha256 ?? null, completed_at: o.now(), retain_until: "2033-10-06T08:00:00Z" });
    setDoc(d, "completed");
    return ok({ account_id: d.account_id, reference: d.reference });
  };

  db.rpcHandlers.sign_envelope_settle = async (a) => {
    const e = envOf(a.p_envelope);
    if (!e) return fail("envelope_not_found");
    if (e.completed_at) return ok({ completed: false, already: true });
    const mine = docsOfEnv(e.id);
    if (mine.length === 0 || mine.some((d) => d.status !== "completed")) return ok({ completed: false });
    e.completed_at = o.now();
    refresh(e.id);
    for (const d of mine) log(d.id, "envelope_completed", { envelope_id: e.id });
    return ok({ completed: true, account_id: e.account_id, reference: e.reference, envelope_id: e.id });
  };

  db.rpcHandlers.sign_envelope_claim_end = async (a) => {
    const e = envOf(a.p_envelope);
    if (!e || e.end_notified_at) return ok(false);
    e.end_notified_at = o.now();
    return ok(true);
  };

  db.rpcHandlers.sign_expire_due = async () => {
    const out: Row[] = [];
    for (const d of docs().filter((x) => (x.status === "sent" || x.status === "in_progress") && x.expires_at && String(x.expires_at) < o.now())) {
      setDoc(d, "expired");
      out.push({ document_id: d.id, account_id: d.account_id, reference: d.reference });
    }
    return ok(out);
  };

  return { tokens };
}
