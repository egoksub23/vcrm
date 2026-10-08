// The database functions of migration 181, in TypeScript, for the services' tests (FakeDb does not run SQL). It mirrors what sign_cancel_document,
// sign_cancel_envelope and sign_cancel_claim_notice do (the same checks, in the same order, with the same errors and the same answers) so a test can
// run a cancellation through the real service. The functions themselves are proved by supabase/ci/verify-181-sign-cancel-completed.sql, run against
// PostgreSQL; this is only the stand-in that lets the orchestration around them be tested. Imported only by tests.

import type { FakeDb } from "./fake-db";

type Row = Record<string, unknown>;
type Out = { data: unknown; error: { message: string } | null };

const fail = (message: string): Out => ({ data: null, error: { message } });
const ok = (data: unknown): Out => ({ data, error: null });

/** The characters of a text the way the database counts them (a character outside the basic plane is one). */
const chars = (s: string): number => Array.from(s).length;

export function installCancelRpcs(db: FakeDb, o: { now: () => string }): void {
  const docs = () => db.rows("sign_documents");
  const log = (documentId: unknown, type: string, actor: unknown, detail: Row) => db.rpcCalls.push({ name: "sign_log", args: { p_document: documentId, p_type: type, p_actor_type: "user", p_user: actor, p_detail: detail } });
  const reasonOf = (raw: unknown): string | null => {
    const r = String(raw ?? "").trim();
    return chars(r) >= 3 && chars(r) <= 500 ? r : null;
  };

  db.rpcHandlers.sign_cancel_document = async (a) => {
    const d = docs().find((x) => x.id === a.p_document);
    if (!d) return fail("document_not_found");
    if (d.envelope_id) return fail("document_in_envelope");
    if (d.status !== "completed") return fail("document_not_completed");
    if (d.cancelled_at) return fail("document_already_cancelled");
    const reason = reasonOf(a.p_reason);
    if (!reason) return fail("cancel_reason_invalid");
    const at = o.now();
    Object.assign(d, { cancelled_at: at, cancelled_by: a.p_actor ?? null, cancel_reason: reason });
    log(d.id, "cancelled", a.p_actor, { reason });
    return ok({ account_id: d.account_id, reference: d.reference, document_id: d.id, cancelled_at: at });
  };

  db.rpcHandlers.sign_cancel_envelope = async (a) => {
    const e = db.rows("sign_envelopes").find((x) => x.id === a.p_envelope);
    if (!e) return fail("envelope_not_found");
    if (e.status !== "completed") return fail("envelope_not_completed");
    if (e.cancelled_at) return fail("envelope_already_cancelled");
    const reason = reasonOf(a.p_reason);
    if (!reason) return fail("cancel_reason_invalid");
    const mine = docs().filter((x) => x.envelope_id === e.id).sort((x, y) => (x.envelope_position as number) - (y.envelope_position as number));
    if (mine.length === 0 || mine.some((x) => x.status !== "completed" || x.cancelled_at)) return fail("envelope_not_completed");
    const at = o.now();
    Object.assign(e, { cancelled_at: at, cancelled_by: a.p_actor ?? null, cancel_reason: reason });
    for (const d of mine) {
      Object.assign(d, { cancelled_at: at, cancelled_by: a.p_actor ?? null, cancel_reason: reason });
      log(d.id, "cancelled", a.p_actor, { reason, envelope_id: e.id, reference: e.reference, position: d.envelope_position, count: mine.length });
    }
    return ok({ account_id: e.account_id, reference: e.reference, envelope_id: e.id, documents: mine.map((d) => d.id), cancelled_at: at });
  };

  db.rpcHandlers.sign_cancel_claim_notice = async (a) => {
    if ((a.p_document == null) === (a.p_envelope == null)) return fail("cancel_notice_needs_one_target");
    const row = a.p_document != null ? docs().find((x) => x.id === a.p_document) : db.rows("sign_envelopes").find((x) => x.id === a.p_envelope);
    if (!row || !row.cancelled_at || row.cancel_notified_at) return ok(false);
    row.cancel_notified_at = o.now();
    return ok(true);
  };
}
