// ============================================================
// Sealing that did not finish: the sender's "Try again".
//
// A document whose people have all signed is sealed by the job (service/seal.ts), which tries up to five times, five minutes apart, and then marks
// the document `failed` (the reason stays on it as `seal_error`, and in its history as `seal_attempt_failed`). Nothing about the signatures is
// lost: the answers are all stored. So the sender must be able to ask for another go once whatever stopped it is put right (a certificate, a
// missing file on the server, a full disk), without anyone editing the database. Asking resets the document to a fresh sealing (no lease, no
// attempts used, the old reason cleared from the document: it stays in the history); the job, or the attempt made right after, then seals it. It is recorded in the document's history, with who asked.
//
// A document that is still being tried (sealing, with an error recorded) can be asked again too: it skips the wait for the next try.
// Nothing else can be retried: a document that is not stuck says so (409) and is left alone.
// ============================================================

import { loadDocument, logEvent, type SignCtx } from "./context";
import { raiseDatabaseError, SignError } from "./errors";
import { loadEnvelope, loadEnvelopeDocuments } from "./envelope-data";
import type { SignDocumentRow } from "../types";

/** A document that stopped before its signed copy was made: marked failed, or still being tried with an error on it. */
export const sealingIsStuck = (doc: Pick<SignDocumentRow, "status" | "seal_error">): boolean => doc.status === "failed" || (doc.status === "sealing" && !!doc.seal_error?.trim());

async function reset(ctx: SignCtx, doc: SignDocumentRow): Promise<void> {
  const { data, error } = await ctx.admin
    .from("sign_documents")
    .update({ status: "sealing", sealing_started_at: null, sealing_attempts: 0, seal_error: null })
    .eq("id", doc.id)
    .eq("account_id", ctx.accountId)
    .in("status", ["failed", "sealing"])
    .select("id");
  if (error) raiseDatabaseError(error, "retry sealing");
  // the document moved on (it was sealed in the meantime): nothing to do, and nothing to say
  if (!data || data.length === 0) return;
  await logEvent(ctx, doc.id, "seal_retried", { actor: "user", userId: ctx.userId, detail: { was: doc.status, ...(doc.seal_error ? { error: doc.seal_error.slice(0, 200) } : {}) } });
}

/** Ask for another try at sealing one document. 409 `seal_not_stuck` when it is not stuck. */
export async function retrySealing(ctx: SignCtx, documentId: string): Promise<{ retried: string[] }> {
  const doc = await loadDocument(ctx, documentId);
  if (!sealingIsStuck(doc)) throw new SignError("seal_not_stuck", "This document is not waiting for its signed copy to be made again.", 409);
  await reset(ctx, doc);
  return { retried: [doc.id] };
}

/** Ask for another try at every document of a collection that stopped before its signed copy was made. 409 `seal_not_stuck` when none did. */
export async function retryEnvelopeSealing(ctx: SignCtx, envelopeId: string): Promise<{ retried: string[] }> {
  await loadEnvelope(ctx, envelopeId);
  const stuck = (await loadEnvelopeDocuments(ctx, envelopeId)).filter(sealingIsStuck);
  if (stuck.length === 0) throw new SignError("seal_not_stuck", "No document of this collection is waiting for its signed copy to be made again.", 409);
  for (const doc of stuck) await reset(ctx, doc);
  return { retried: stuck.map((d) => d.id) };
}
