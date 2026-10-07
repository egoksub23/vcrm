// ============================================================
// The scheduled work of Doc Sign, run every minute by /api/sign/jobs-cron: seal documents that are
// fully signed, expire documents past their date, send due reminders, and send the documents of bulk batches. Each part is bounded and
// fair: a small batch per run, oldest first, so one workspace's backlog cannot starve another's.
// ============================================================

import { dueReminders } from "../defaults";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { loadSigners, type SignCtx } from "./context";
import { runBulk } from "./bulk";
import { runCertificateWatch } from "./certificate-watch";
import { loadEnvelope, loadEnvelopeDocuments } from "./envelope-data";
import { notifyEnvelopeEnded } from "./envelope-delivery";
import { remindEnvelopePerson } from "./envelopes";
import { notifyExpired } from "./outcome";
import { emitSignEvent } from "./outbound";
import { remindSigner } from "./send";
import { runSealingWithin } from "./seal";

type Base = Omit<SignCtx, "accountId" | "userId">;

export async function runExpiry(base: Base, limit = 50): Promise<{ expired: number }> {
  const { data, error } = await base.admin.rpc("sign_expire_due", { p_limit: limit });
  if (error) {
    console.error("[sign] expiry run failed:", error.message);
    return { expired: 0 };
  }
  const rows = (data ?? []) as { document_id: string; account_id: string }[];
  for (const r of rows) {
    const ctx: SignCtx = { ...base, accountId: r.account_id, userId: null };
    const doc = await base.admin.from("sign_documents").select("*").eq("id", r.document_id).eq("account_id", r.account_id).maybeSingle();
    if (!doc.data) continue;
    await emitSignEvent(ctx, doc.data as SignDocumentRow, "expired"); // the automation trigger and the webhook; never throws
    const envelopeId = (doc.data as SignDocumentRow).envelope_id;
    if (envelopeId) {
      // an envelope tells its people ONCE that it expired, not once for each of its documents: the first document to expire claims the message
      const claimed = await base.admin.rpc("sign_envelope_claim_end", { p_envelope: envelopeId });
      if (claimed.data === true) {
        try {
          const [env, docs] = await Promise.all([loadEnvelope(ctx, envelopeId), loadEnvelopeDocuments(ctx, envelopeId)]);
          await notifyEnvelopeEnded(ctx, env, docs, { kind: "expired" });
        } catch (err) {
          console.error("[sign] could not tell the people the envelope expired:", envelopeId, err instanceof Error ? err.message : err);
        }
      }
      continue;
    }
    await notifyExpired(ctx, doc.data as SignDocumentRow, await loadSigners(ctx, r.document_id));
  }
  return { expired: rows.length };
}

export async function runReminders(base: Base, limit = 100): Promise<{ checked: number; reminded: number }> {
  const { data, error } = await base.admin
    .from("sign_signers")
    .select("*, doc:sign_documents!inner(id, account_id, status, reminder_days, envelope_id)")
    .in("status", ["sent", "viewed"])
    .not("invited_at", "is", null)
    .in("doc.status", ["sent", "in_progress"])
    .order("invited_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[sign] reminder run failed:", error.message);
    return { checked: 0, reminded: 0 };
  }
  const rows = (data ?? []) as (SignSignerRow & { doc: { id: string; account_id: string; reminder_days: number[] | null; envelope_id: string | null } })[];
  const now = base.now();
  let reminded = 0;
  // a person of an envelope is one person with one link, however many documents they have left: reminded once, by their anchor row
  const parties = new Set<string>();
  for (const r of rows) {
    if (r.party_id) {
      if (parties.has(r.party_id)) continue;
      parties.add(r.party_id);
    }
    const due = dueReminders([r], r.doc.reminder_days ?? [], now);
    if (due.length === 0) continue;
    try {
      if (r.party_id && r.doc.envelope_id) await remindEnvelopePerson({ ...base, accountId: r.doc.account_id, userId: null }, r.doc.envelope_id, r.party_id);
      else await remindSigner({ ...base, accountId: r.doc.account_id, userId: null }, r.doc.id, r.id);
      reminded++;
    } catch (err) {
      console.error("[sign] reminder failed for", r.id, err instanceof Error ? err.message : err);
    }
  }
  return { checked: rows.length, reminded };
}

/** A run in which documents were tried and not one could be sealed: the job is failing, not quiet (the route records it as an error so the console and `curl -f` say so). */
export const sealingIsFailing = (body: Record<string, number | string>): boolean => Number(body.seal_retry ?? 0) > 0 && Number(body.sealed ?? 0) === 0;

export async function runAll(base: Base): Promise<Record<string, number | string>> {
  const seal = await runSealingWithin(base);
  const expiry = await runExpiry(base);
  const reminders = await runReminders(base);
  // a certificate that is about to end is told to the administrators in good time (30, 14, 7 days, and when it has ended)
  const certs = await runCertificateWatch(base);
  // bulk send goes last and works within a time budget, so a long batch never holds the sealing and reminders up
  const bulk = await runBulk(base).catch((err) => {
    console.error("[sign] bulk run failed:", err instanceof Error ? err.message : err);
    return { claimed: 0, sent: 0, failed: 0, released: 0 };
  });
  return {
    claimed: seal.claimed,
    sealed: seal.completed,
    seal_retry: seal.retry,
    // why a document did not seal this time (the first one; the document itself and its history carry each reason): the heartbeat shows it
    ...(seal.errors && seal.errors.length > 0 ? { seal_error: seal.errors[0].slice(0, 200) } : {}),
    expired: expiry.expired,
    reminders_checked: reminders.checked,
    reminded: reminders.reminded,
    certs_notified: certs.notified,
    bulk_claimed: bulk.claimed,
    bulk_sent: bulk.sent,
    bulk_failed: bulk.failed,
    bulk_released: bulk.released,
  };
}
