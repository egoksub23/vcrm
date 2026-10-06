// ============================================================
// Envelopes (migration 171): the person's "Finish". The person has been through their documents on one page, answers autosaved on
// each; Finish completes every document that is still theirs to do, IN ORDER, each through the same `completeSigning` a document on its
// own uses (so every rule, the signature, the write-back to the contact, the next step and sealing are exactly as for one document).
//
// It is resumable and idempotent. A document that is already signed is skipped; a document that cannot be completed (an answer that
// does not fit, a document that was closed meanwhile) stops the run with that document named: the documents before it stay signed,
// the page shows what remains, and Finish can be pressed again. Nothing is signed twice, and nothing after the failure is touched.
// ============================================================

import type { SignCtx } from "./context";
import { SignError } from "./errors";
import { pageState, pickDocument, completeSigning, type AnyAnswerInput, type Lookup } from "./signing";

export interface EnvelopeFinishResult {
  /** The documents completed by this call, in order. */
  completed: string[];
  /** Documents of the person that are still not done (empty when the whole sitting is finished). */
  remaining: string[];
  /** At least one document is now being sealed. */
  sealing: boolean;
}

/** Tag the problems of a failed document with the document, so the page can take the person there. */
function onDocument(err: unknown, documentId: string): never {
  if (err instanceof SignError) {
    const issues = (err.issues && err.issues.length > 0 ? err.issues : [{ code: err.code }]).map((i) => ({ ...i, document: documentId }));
    throw new SignError(err.code, err.message, err.status, issues);
  }
  throw err;
}

/**
 * Complete each document of the person that is still to do, in the envelope's order. `answers` may carry last answers by document id
 * (saved first, with the document's own rules); the page normally has nothing to add because it saved as the person went.
 */
export async function finishEnvelope(
  ctx: SignCtx,
  lookup: Lookup,
  answers: Record<string, Record<string, AnyAnswerInput>>,
  meta: { ip: string | null; device: string | null; locale: string | null },
): Promise<EnvelopeFinishResult> {
  const party = lookup.party;
  if (!party) throw new SignError("not_an_envelope", "This link is not for an envelope.", 400);
  const todo = party.members.filter((m) => pageState(m.doc, m.signer) === "active");
  const completed: string[] = [];
  let sealing = false;
  for (const m of todo) {
    const own = pickDocument(lookup, m.doc.id);
    if (!own) continue; // cannot happen: the member came from the party
    try {
      const result = await completeSigning(ctx, own, answers[m.doc.id] ?? {}, meta);
      completed.push(m.doc.id);
      if (result.sealing) sealing = true;
    } catch (err) {
      onDocument(err, m.doc.id);
    }
  }
  const done = new Set(completed);
  const remaining = party.members.filter((m) => pageState(m.doc, m.signer) === "active" && !done.has(m.doc.id)).map((m) => m.doc.id);
  return { completed, remaining, sealing };
}
