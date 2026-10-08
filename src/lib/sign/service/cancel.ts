// ============================================================
// Cancelling a COMPLETED document, or a whole document collection (migration 181). The owner's rule, in four lines:
//
//   WHO       the person who made the document (created_by) and the workspace's admins and owners, who must also be able to see it (a private document is
//             "not found" to anyone else, as everywhere: loadDocument / loadEnvelope). A key, an automation and the system never cancel: a person does.
//             This is a check of its own, not `sign.void`, and adds no capability (see cancel.ts).
//   WHAT      a stamp (when, who, why) on the document, or on the collection and ALL its documents in one transaction. The record is untouched: the
//             status stays "completed", and the signed file, the certificate, the answers, the signers and the hash-chained history are as they were,
//             with one more event ("cancelled", carrying the reason) on every document affected. There is no undo.
//   A DOCUMENT OF A COLLECTION is not cancelled alone: the document route answers 409 `belongs_to_collection` and names the collection, whose route
//             cancels the collection with every document in it. (One consistent behaviour, and no document of a collection is ever left standing by an
//             action that looked as if it touched one.)
//   NOTIFY    when asked (off unless the person ticks it), ONE email each to the signers, the people who receive a copy and the sender, through the
//             workspace's own sender; never a signing link or a file. The notice is claimed once in the database before anything is sent, so a repeat or a
//             race never sends it twice; a message that could not be delivered is recorded (counts and reasons, never an address) and never undoes the
//             cancellation.
//
// After the change is committed the `cancelled` event goes to the webhooks and the automations (one for each document).
// ============================================================

import { CANCEL_REASON_MAX, CANCEL_REASON_MIN, cancelReasonProblem, cleanCancelReason, type CancelRequest, type CancelResult } from "../cancel";
import { isDelegate } from "../forward";
import { deliverCancelNotice, type Workspace } from "../notify";
import { isFormMode, type SignDocumentRow, type SignLocale, type SignSignerRow } from "../types";
import { loadDocument, loadSenderAndWorkspace, loadSettings, loadSigners, logEvent, type SignCtx } from "./context";
import { listCopyRecipients } from "./copy-recipients";
import { loadEnvelope, loadEnvelopeDocuments, loadEnvelopeSigners } from "./envelope-data";
import { peopleOf } from "./envelope-delivery";
import { SignError, raiseDatabaseError } from "./errors";
import { emitSignEvent } from "./outbound";
import { callerOf, isAdminOf } from "./privacy";

/**
 * May this caller cancel this row? The person who made it, or an admin or owner of the workspace. A key and the system are never a person (they cannot be
 * the creator and are not an admin), so they are refused. The caller has already seen the row (loadDocument / loadEnvelope refused it otherwise).
 */
export async function mayCancel(ctx: SignCtx, row: { created_by?: string | null }): Promise<boolean> {
  const caller = callerOf(ctx);
  if (caller.kind !== "person") return false;
  if (row.created_by && row.created_by === caller.userId) return true;
  return isAdminOf(ctx, caller.userId);
}

async function assertMayCancel(ctx: SignCtx, row: { created_by?: string | null }): Promise<void> {
  if (!(await mayCancel(ctx, row))) {
    throw new SignError("cancel_not_allowed", "Only the person who sent this, or an admin, can cancel it.", 403);
  }
}

/** The reason, checked as the database checks it (3 to 500 characters once trimmed). */
function checkReason(raw: unknown): string {
  const reason = cleanCancelReason(raw);
  if (cancelReasonProblem(reason) !== null) {
    throw new SignError("cancel_reason_invalid", `Give a reason of ${CANCEL_REASON_MIN} to ${CANCEL_REASON_MAX} characters.`, 400);
  }
  return reason;
}

/** What the request carried, made safe: a reason (text) and whether to notify (only a real `true` counts). */
export function parseCancelRequest(body: { reason?: unknown; notify?: unknown }): CancelRequest {
  return { reason: cleanCancelReason(body.reason), notify: body.notify === true };
}

// ---- the notice -------------------------------------------------------------------------------------

interface Recipient {
  name: string;
  email: string;
  locale: SignLocale;
}

/** Each address once (case ignored), the first listing winning: a signer who is also the sender or on the copy list is emailed once. */
export function uniqueRecipients(list: readonly Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of list) {
    const key = r.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

const asRecipient = (s: SignSignerRow, fallback: SignLocale): Recipient => ({ name: s.full_name, email: s.email, locale: s.locale ?? fallback });

/**
 * Tell the people, once. `home` is the document a failed delivery is recorded on; `all` are the documents that get the "notice sent" line. Returns how
 * many were emailed and how many could not be, or null when the notice had already been claimed (another call sent it). Never throws.
 */
async function sendNotice(
  ctx: SignCtx,
  target: { documentId: string } | { envelopeId: string },
  facts: { title: string; reference: string | null; locale: SignLocale; mode: "sign" | "form"; count: number; cancelledAt: Date; reason: string; createdBy: string | null },
  people: readonly Recipient[],
  docIds: readonly string[],
): Promise<{ sent: number; failed: number } | null> {
  try {
    const claimed = await ctx.admin.rpc("sign_cancel_claim_notice", "documentId" in target ? { p_document: target.documentId } : { p_envelope: target.envelopeId });
    if (claimed.error) {
      console.error("[sign] could not claim the cancel notice:", claimed.error.message);
      return null;
    }
    if (claimed.data !== true) return null;
    const [info, settings] = await Promise.all([loadSenderAndWorkspace(ctx, facts.createdBy), loadSettings(ctx)]);
    const w: Workspace = { name: info.workspaceName, senderName: info.senderName, timeZone: info.timeZone, settings };
    const all = uniqueRecipients([...people, ...(info.senderEmail ? [{ name: info.senderName, email: info.senderEmail, locale: facts.locale }] : [])]);
    let sent = 0;
    let failed = 0;
    for (const p of all) {
      const d = await deliverCancelNotice(ctx.deps, ctx.accountId, w, p, {
        locale: p.locale,
        title: facts.title,
        reference: facts.reference,
        cancelledAt: facts.cancelledAt,
        reason: facts.reason,
        count: facts.count,
        mode: facts.mode,
        timeZone: info.timeZone,
      });
      if (d.status === "sent") sent++;
      else {
        failed++;
        // the reason the mail server gave, never the address
        await logEvent(ctx, docIds[0], "delivery_failed", { actor: "system", detail: { kind: "cancel", status: d.status, reason: d.detail ?? null } });
      }
    }
    for (const id of docIds) await logEvent(ctx, id, "cancel_notice_sent", { actor: "system", detail: { sent, failed } });
    return { sent, failed };
  } catch (err) {
    console.error("[sign] could not send the cancel notice:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---- a document on its own --------------------------------------------------------------------------

/**
 * Cancel a completed document that is on its own. 404 when it is not found or not visible to the caller, 403 when the caller is neither its creator nor
 * an admin, 409 `belongs_to_collection` for a document of a collection (cancel the collection), 409 when it is not completed or already cancelled,
 * 400 when the reason is not 3 to 500 characters.
 */
export async function cancelDocument(ctx: SignCtx, documentId: string, input: CancelRequest): Promise<CancelResult> {
  const doc = await loadDocument(ctx, documentId);
  await assertMayCancel(ctx, doc);
  if (doc.envelope_id) {
    throw new SignError("belongs_to_collection", "This document is part of a document collection. Cancel the collection instead: that cancels every document in it.", 409, [{ code: "belongs_to_collection", detail: doc.envelope_id }]);
  }
  if (doc.status !== "completed") throw new SignError("document_not_completed", "Only a completed document can be cancelled.", 409);
  if (doc.cancelled_at) throw new SignError("document_already_cancelled", "This document was already cancelled.", 409);
  const reason = checkReason(input.reason);

  const { data, error } = await ctx.admin.rpc("sign_cancel_document", { p_document: documentId, p_reason: reason, p_actor: ctx.userId });
  if (error || !data) raiseDatabaseError(error, "cancel document");
  const cancelledAt = (data as { cancelled_at?: string }).cancelled_at ?? ctx.now().toISOString();
  const cancelled: SignDocumentRow = { ...doc, cancelled_at: cancelledAt, cancelled_by: ctx.userId, cancel_reason: reason };
  await emitSignEvent(ctx, cancelled, "cancelled"); // the automation trigger and the webhook; never throws

  let notice: CancelResult["notice"] = null;
  if (input.notify) {
    const signers = await loadSigners(ctx, documentId);
    const copies = await listCopyRecipients(ctx, { documentId });
    const people = uniqueRecipients([...signers.filter((s) => !isDelegate(s)).map((s) => asRecipient(s, doc.locale)), ...copies.map((c) => ({ name: c.full_name, email: c.email, locale: doc.locale }))]);
    notice = await sendNotice(
      ctx,
      { documentId },
      { title: doc.title, reference: doc.reference, locale: doc.locale, mode: isFormMode(doc) ? "form" : "sign", count: 1, cancelledAt: new Date(cancelledAt), reason, createdBy: doc.created_by },
      people,
      [documentId],
    );
  }
  return { cancelled: true, scope: "document", documents: 1, cancelledAt, notice };
}

// ---- a document collection --------------------------------------------------------------------------

/**
 * Cancel a completed document collection: the collection and EVERY document in it, together, in one transaction. The same errors as for a document.
 */
export async function cancelEnvelope(ctx: SignCtx, envelopeId: string, input: CancelRequest): Promise<CancelResult> {
  const env = await loadEnvelope(ctx, envelopeId);
  await assertMayCancel(ctx, env);
  if (env.status !== "completed") throw new SignError("envelope_not_completed", "Only a completed document collection can be cancelled.", 409);
  if (env.cancelled_at) throw new SignError("envelope_already_cancelled", "This document collection was already cancelled.", 409);
  const reason = checkReason(input.reason);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);

  const { data, error } = await ctx.admin.rpc("sign_cancel_envelope", { p_envelope: envelopeId, p_reason: reason, p_actor: ctx.userId });
  if (error || !data) raiseDatabaseError(error, "cancel envelope");
  const cancelledAt = (data as { cancelled_at?: string }).cancelled_at ?? ctx.now().toISOString();
  for (const d of docs) await emitSignEvent(ctx, { ...d, cancelled_at: cancelledAt, cancelled_by: ctx.userId, cancel_reason: reason }, "cancelled"); // never throws

  let notice: CancelResult["notice"] = null;
  if (input.notify) {
    const rows = await loadEnvelopeSigners(ctx, docs.map((d) => d.id));
    const copies = await listCopyRecipients(ctx, { envelopeId });
    const people = uniqueRecipients([...peopleOf(rows, docs).map((s) => asRecipient(s, env.locale)), ...copies.map((c) => ({ name: c.full_name, email: c.email, locale: env.locale }))]);
    notice = await sendNotice(
      ctx,
      { envelopeId },
      { title: env.title, reference: env.reference, locale: env.locale, mode: docs.length > 0 && docs.every((d) => isFormMode(d)) ? "form" : "sign", count: docs.length, cancelledAt: new Date(cancelledAt), reason, createdBy: env.created_by },
      people,
      docs.map((d) => d.id),
    );
  }
  return { cancelled: true, scope: "collection", documents: docs.length, cancelledAt, notice };
}
