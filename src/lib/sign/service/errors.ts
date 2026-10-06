// ============================================================
// Errors the Doc Sign services raise. Each carries a stable `code` (the screen words it in the
// user's language), the HTTP status a route should answer with, and, for a document that cannot be
// sent yet, the list of problems.
// ============================================================

import type { Issue } from "../rules";

export class SignError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues?: Issue[];

  constructor(code: string, message: string, status = 400, issues?: Issue[]) {
    super(message);
    this.name = "SignError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

/** Postgres error codes the ceremony functions use, and what they mean to a caller. */
const DB_CODES: Record<string, { code: string; status: number; message: string }> = {
  document_not_found: { code: "document_not_found", status: 404, message: "That document was not found." },
  document_not_draft: { code: "document_not_draft", status: 409, message: "This document was already sent." },
  document_has_no_signer: { code: "no_signer", status: 400, message: "Add at least one person who signs." },
  expiry_in_the_past: { code: "expiry_in_the_past", status: 400, message: "The expiry date is in the past." },
  document_not_open: { code: "document_not_open", status: 409, message: "This document can no longer be signed." },
  already_signed: { code: "already_signed", status: 409, message: "You have already signed this document." },
  signer_not_open: { code: "signer_not_open", status: 409, message: "This person can no longer sign this document." },
  document_already_final: { code: "document_already_final", status: 409, message: "This document has already finished." },
  document_not_sealing: { code: "document_not_sealing", status: 409, message: "This document is not being sealed." },
  invalid_sign_status_move: { code: "invalid_status_move", status: 409, message: "That change is not allowed in the document's current state." },
  sign_document_is_frozen: { code: "document_frozen", status: 409, message: "A document that was sent cannot be edited." },
};

/** Turn an error from the database (a function that raised, or a trigger) into a SignError when it is one we expect. */
export function fromDatabaseError(err: { message?: string; details?: string; hint?: string } | null | undefined): SignError | null {
  const text = `${err?.message ?? ""} ${err?.details ?? ""}`;
  for (const [needle, v] of Object.entries(DB_CODES)) {
    if (text.includes(needle)) return new SignError(v.code, v.message, v.status);
  }
  return null;
}

/** Throw the right error for a failed database call. Unknown failures become a plain 500 without the database's words. */
export function raiseDatabaseError(err: { message?: string; details?: string } | null | undefined, context: string): never {
  const known = fromDatabaseError(err);
  if (known) throw known;
  console.error(`[sign] ${context}:`, err?.message);
  throw new SignError("database_error", "Something went wrong. Please try again.", 500);
}
