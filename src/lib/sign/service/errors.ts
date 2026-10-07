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
  // retention (migration 165): a signed document is kept until its date, and the date only moves later
  sign_document_retained: { code: "document_retained", status: 409, message: "This signed document is kept until its retention date and cannot be deleted before then." },
  sign_document_cannot_be_deleted: { code: "document_cannot_be_deleted", status: 409, message: "Only a draft can be deleted. Void a document that was sent." },
  sign_retention_cannot_shorten: { code: "retention_cannot_shorten", status: 409, message: "The retention date of a document can be extended, never shortened." },
  // forwarding and steps (migration 166)
  forward_not_allowed: { code: "forward_not_allowed", status: 403, message: "Forwarding is not switched on for this document." },
  delegate_cannot_forward: { code: "delegate_cannot_forward", status: 403, message: "A part that was handed to you cannot be passed on again." },
  forward_limit: { code: "forward_limit", status: 400, message: "This can only be handed on a couple of times. Ask the sender instead." },
  forward_details: { code: "forward_details", status: 400, message: "Enter a full name and a valid email." },
  forward_same_person: { code: "forward_same_person", status: 400, message: "That is your own address. Enter the person you are handing this to." },
  forward_already_signer: { code: "forward_already_signer", status: 400, message: "That person is already on this document." },
  forward_part_unknown: { code: "forward_part_unknown", status: 400, message: "That part is not yours to forward." },
  part_already_forwarded: { code: "part_already_forwarded", status: 409, message: "That part was already handed to someone." },
  part_not_forwarded: { code: "part_not_forwarded", status: 409, message: "That part is not with anyone else." },
  part_already_completed: { code: "part_already_completed", status: 409, message: "That part has been completed, so it cannot be taken back." },
  delegation_open: { code: "delegation_open", status: 409, message: "A part you forwarded is not finished yet. Wait for it, or take it back." },
  step_not_movable: { code: "step_not_movable", status: 409, message: "That person can only be moved to a step that has not begun." },
  // test documents and attached records (migration 170)
  sign_document_test_is_fixed: { code: "test_is_fixed", status: 409, message: "Whether a document is a test cannot change once it is sent." },
  sign_document_ticket_not_in_workspace: { code: "link_not_found", status: 400, message: "That ticket was not found." },
  sign_document_deal_not_in_workspace: { code: "link_not_found", status: 400, message: "That deal was not found." },
  // envelopes (migration 171)
  envelope_not_found: { code: "envelope_not_found", status: 404, message: "That document collection was not found." },
  envelope_not_draft: { code: "envelope_not_draft", status: 409, message: "This document collection was already sent." },
  envelope_not_sent: { code: "envelope_not_sent", status: 409, message: "This document collection has not been sent." },
  envelope_needs_2_to_6_documents: { code: "envelope_size", status: 400, message: "A document collection has two to six documents." },
  envelope_documents_mismatch: { code: "envelope_documents", status: 409, message: "The documents of this collection changed. Open it again." },
  // the order of a draft collection (migration 174)
  envelope_order_mismatch: { code: "envelope_documents", status: 409, message: "The documents of this collection changed. Open it again." },
  envelope_options_differ: { code: "envelope_options", status: 400, message: "Every document of a document collection must use the same signing order and code." },
  envelope_person_without_party: { code: "envelope_people", status: 400, message: "Every person of a document collection must be on its signing list." },
  envelope_person_twice_on_a_document: { code: "envelope_person_twice", status: 400, message: "A person can have only one role on each document of a document collection." },
  envelope_person_steps_differ: { code: "envelope_people", status: 400, message: "A person must be in the same step on every document." },
  envelope_person_anchor_wrong: { code: "envelope_people", status: 400, message: "The signing list of this collection is not sound. Save it again." },
  envelope_partly_completed: { code: "envelope_partly_completed", status: 409, message: "A document of this collection was already signed by everyone, so the collection cannot be cancelled." },
  envelope_person_has_signed: { code: "envelope_person_has_signed", status: 409, message: "This person has already signed a document of the collection, so they cannot be replaced." },
  document_in_envelope: { code: "document_in_envelope", status: 409, message: "This document is part of a document collection. Do this on the collection." },
  sign_envelope_no_forwarding: { code: "envelope_no_forwarding", status: 409, message: "Documents of a document collection cannot be forwarded." },
  sign_envelope_no_test: { code: "envelope_no_test", status: 409, message: "A test document cannot be part of a document collection." },
  sign_envelope_is_frozen: { code: "envelope_frozen", status: 409, message: "A document collection that was sent cannot be edited." },
  sign_document_envelope_is_fixed: { code: "envelope_fixed", status: 409, message: "A document cannot be moved out of its collection." },
  sign_envelope_not_open_for_documents: { code: "envelope_not_draft", status: 409, message: "This document collection was already sent." },
  // people who receive a copy (migration 175)
  sign_copy_not_open: { code: "copy_not_open", status: 409, message: "People can receive a copy until the document is completed. This one is not open any more." },
  sign_copy_limit: { code: "copy_limit", status: 400, message: "Up to 10 people can receive a copy." },
  sign_copy_belongs_to_collection: { code: "document_in_envelope", status: 409, message: "This document is part of a document collection. People who receive a copy are added to the collection." },
  sign_copy_recipient_is_fixed: { code: "copy_fixed", status: 409, message: "A person who receives a copy is removed and added again, never changed." },
  sign_copy_recipients_uq: { code: "copy_duplicate", status: 400, message: "That person already receives a copy." },
  // the unique (account_id, reference) of sign_documents: only a caller that chose its own reference (the public API) can hit it
  sign_documents_reference: { code: "reference_in_use", status: 409, message: "That reference is already used by another document." },
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
