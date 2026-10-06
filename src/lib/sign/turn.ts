// ============================================================
// Doc Sign: whose turn it is on a document. Pure (no I/O, no Node), so the server (the "Awaiting my signature" list and
// the refusals of opening a turn) and the browser (the "Sign now" button) decide it the same way.
// ============================================================

export type TurnState = "open" | "not_your_turn" | "already_signed" | "declined" | "document_closed";

/**
 * Where a person stands on a document. A person is "open" when the document can still be signed and they have been
 * invited and have not finished. With signing order a later step stays "pending" (they have no link yet) until the
 * earlier step finishes, so "invited and not finished" is exactly "their step has begun".
 */
export function turnState(doc: { status: string; expires_at: string | null }, signer: { status: string }, now: Date): TurnState {
  if (signer.status === "signed") return "already_signed";
  if (signer.status === "declined") return "declined";
  const open = doc.status === "sent" || doc.status === "in_progress";
  const expired = !!doc.expires_at && new Date(doc.expires_at).getTime() <= now.getTime();
  if (!open || expired) return "document_closed";
  if (signer.status === "pending") return "not_your_turn";
  return "open";
}

/** The place on a document where the signed-in person can sign right now, or null. A person in two roles gets the first step. */
export function myOpenPlace<S extends { status: string; internal_user_id: string | null; order_no: number }>(
  doc: { status: string; expires_at: string | null },
  signers: readonly S[],
  userId: string | null | undefined,
  now: Date,
): S | null {
  if (!userId) return null;
  const mine = signers.filter((s) => s.internal_user_id === userId && turnState(doc, s, now) === "open");
  return mine.sort((a, b) => a.order_no - b.order_no)[0] ?? null;
}
