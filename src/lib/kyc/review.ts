// ============================================================
// KYC review: reading the word the back end uses for a decision ("APPROVED", "REJECTED", or one nobody has seen yet). One function, used by the server
// (to know whether a check can be amended) and by the screen (to filter and to offer the amendment), so the two can never disagree.
// Pure: no imports.
// ============================================================

export type ReviewKind = "approved" | "rejected" | "other";

/** "APPROVED" / "approve" -> approved, "REJECTED" / " reject " -> rejected, any other word -> other. */
export function reviewKind(raw: string | null | undefined): ReviewKind {
  const word = (raw ?? "").trim().toUpperCase();
  if (word.startsWith("APPROV")) return "approved";
  if (word.startsWith("REJECT")) return "rejected";
  return "other";
}
