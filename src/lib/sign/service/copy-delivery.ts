// ============================================================
// Telling the people who RECEIVE A COPY (migration 175): when a document, or the last document of a collection, is sealed, each of them gets
// ONE message with the signed PDF(s) attached. This is called from the same two places that mail the signers (service/outcome.ts for a
// document on its own, service/envelope-delivery.ts for a collection), so the copies go out in the same step and only once.
//
// ONCE: a person is CLAIMED before they are mailed. The claim is one UPDATE that sets notified_at on the rows where it is still null and
// hands back exactly the rows it changed, so two runs of the completion step at the same moment (or a repeat of it) cannot both get a row.
// A message that could not be delivered is recorded as an event and the claim is given back, so the screens keep saying "Not sent yet" for that
// person (nothing retries it by itself, as for the signers' completion mail); a message that was sent keeps its mark. Never throws: a message
// that cannot be delivered is not a reason to fail the completion.
// ============================================================

import { deliverCopy, deliverEnvelopeCopy, verifyLink, type DocFacts, type EnvelopeFacts, type MailFile, type SignedMailFile, type Workspace } from "../notify";
import type { SignCopyRecipientRow, SignDocumentRow } from "../types";
import { logEvent, type SignCtx } from "./context";
import type { CopyTarget } from "./copy-recipients";

/** Take the people of the target who have not been sent the copy yet, marking them as sent. Only the rows this call changed come back. */
async function claim(ctx: SignCtx, target: CopyTarget): Promise<SignCopyRecipientRow[]> {
  let q = ctx.admin.from("sign_copy_recipients").update({ notified_at: ctx.now().toISOString() }).eq("account_id", ctx.accountId).is("notified_at", null);
  q = "envelopeId" in target ? q.eq("envelope_id", target.envelopeId) : q.eq("document_id", target.documentId);
  const { data, error } = await q.select("*");
  if (error) {
    console.error("[sign] could not claim the copy recipients:", error.message);
    return [];
  }
  return ((data ?? []) as SignCopyRecipientRow[]).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** Give the claim back (the message did not go), so a later run can try this person again. */
async function release(ctx: SignCtx, id: string): Promise<void> {
  const { error } = await ctx.admin.from("sign_copy_recipients").update({ notified_at: null }).eq("id", id).eq("account_id", ctx.accountId);
  if (error) console.error("[sign] could not give back the claim on a copy recipient:", error.message);
}

/**
 * The signed copy of a document on its own, to each person who receives one, once. `told` are the addresses (lower case) that were just sent the
 * signed copy as a signer or as the sender: a person on both lists is not sent it twice (their copy row is still marked as sent).
 */
export async function sendDocumentCopies(ctx: SignCtx, doc: SignDocumentRow, facts: DocFacts, w: Workspace, pdf: SignedMailFile, told: ReadonlySet<string> = new Set()): Promise<void> {
  try {
    const people = await claim(ctx, { documentId: doc.id });
    for (const p of people) {
      if (told.has(p.email.trim().toLowerCase())) continue;
      const d = await deliverCopy(ctx.deps, facts, w, { name: p.full_name, email: p.email }, pdf, verifyLink(ctx.origin, doc.id));
      if (d.status !== "sent") {
        await release(ctx, p.id);
        await logEvent(ctx, doc.id, "delivery_failed", { actor: "system", detail: { kind: "copy", status: d.status, reason: d.detail ?? null } });
      }
    }
  } catch (err) {
    console.error("[sign] could not send the copies:", doc.id, err instanceof Error ? err.message : err);
  }
}

/** A signed file of a collection: its bytes and name, and which document it is (for the page that checks it when it is too large to attach). `certificate`: its certificate when that is a file of its own (migration 178). */
export interface CopyFile {
  bytes: Uint8Array;
  filename: string;
  documentId?: string;
  certificate?: MailFile | null;
}

/** The signed copies of every document of a collection, in ONE message to each person who receives a copy, once (`told`: as for a document). */
export async function sendEnvelopeCopies(ctx: SignCtx, envelopeId: string, docs: readonly SignDocumentRow[], facts: EnvelopeFacts, w: Workspace, files: readonly CopyFile[], told: ReadonlySet<string> = new Set()): Promise<void> {
  try {
    const people = await claim(ctx, { envelopeId });
    if (people.length === 0) return;
    const titleOf = new Map(docs.map((d) => [d.id, d.title]));
    const pdfs = files.map((f) => ({ bytes: f.bytes, filename: f.filename, ...(f.certificate ? { certificate: f.certificate } : {}), title: (f.documentId && titleOf.get(f.documentId)) || f.filename, verifyUrl: verifyLink(ctx.origin, f.documentId ?? docs[0]?.id ?? "") }));
    for (const p of people) {
      if (told.has(p.email.trim().toLowerCase())) continue;
      const d = await deliverEnvelopeCopy(ctx.deps, facts, w, { name: p.full_name, email: p.email }, pdfs);
      if (d.status !== "sent") {
        await release(ctx, p.id);
        const home = docs[0]?.id;
        if (home) await logEvent(ctx, home, "delivery_failed", { actor: "system", detail: { kind: "copy", status: d.status, reason: d.detail ?? null } });
      }
    }
  } catch (err) {
    console.error("[sign] could not send the copies of the collection:", envelopeId, err instanceof Error ? err.message : err);
  }
}
