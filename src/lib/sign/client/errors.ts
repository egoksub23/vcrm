// ============================================================
// Doc Sign, browser side: which message says what went wrong, for the stable error codes the routes answer
// with (see `SignApiError.code`) and for the problems `sendProblems` finds on a draft.
//
// Both return a key under the `Sign.send` namespace, `errors.<code>` or `problems.<code>`, falling back to a
// generic one so a code the screen has never seen is still a sentence, never a raw code.
// ============================================================

import type { SignIssue } from "./api";

/** Every failure code the sender's screens word on their own; anything else reads as "errors.generic". */
export const KNOWN_ERROR_CODES = [
  // upload and conversion
  "upload_empty",
  "upload_too_large",
  "upload_unsupported",
  "upload_name_mismatch",
  "upload_macros",
  "upload_zip_bomb",
  "upload_encrypted_word",
  "upload_failed",
  "no_file",
  "bad_upload",
  "pdf_invalid",
  "pdf_encrypted",
  "pdf_too_many_pages",
  "pdf_empty",
  "pdf_too_large",
  "conversion_timeout",
  "conversion_failed",
  "conversion_too_long",
  "converter_not_configured",
  "converter_unavailable",
  "bad_image",
  // starting from a template, links
  "template_required",
  "template_not_found",
  "template_not_active",
  "template_has_no_version",
  "template_not_ready",
  "category_not_found",
  "contact_not_found",
  // attaching a ticket or a deal (F-51)
  "ticket_not_found",
  "deal_not_found",
  "ticket_contact_mismatch",
  "deal_contact_mismatch",
  // a test sent from a template (F-10) and a replaced file (F-77)
  "test_email_not_yours",
  "test_no_roles",
  "test_no_address",
  "same_file",
  "document_has_no_file",
  // changing a draft
  "document_not_found",
  "document_not_draft",
  "document_frozen",
  "bad_title",
  "bad_message",
  "bad_locale",
  "expiry_in_the_past",
  "invalid_layout",
  "too_many_signers",
  "signer_name",
  "signer_email",
  "signer_phone",
  "signer_role",
  "bad_signers",
  // sending
  "not_ready",
  "no_signer",
  "sign_limit_reached",
  // envelopes (migration 171)
  "envelope_not_found",
  "envelope_not_draft",
  "envelope_not_sent",
  "envelope_size",
  "envelope_documents",
  "envelope_options",
  "envelope_people",
  "envelope_person_twice",
  "envelope_not_ready",
  "envelope_too_big",
  "envelope_duplicate_template",
  // document collections: several files at once, and adding, removing and reordering the documents of a draft
  "too_many_files",
  "uploads_too_large",
  "bad_order",
  "envelope_full",
  "envelope_minimum",
  "envelope_not_deletable",
  "envelope_frozen",
  "envelope_fixed",
  "envelope_no_forwarding",
  "envelope_no_test",
  "document_in_envelope",
  "document_retained",
  // people who receive a copy (migration 175)
  "copy_name",
  "copy_email",
  "copy_duplicate",
  "copy_is_signer",
  "copy_limit",
  "copy_not_open",
  "copy_fixed",
  "copy_recipient_not_found",
  // private documents (migration 176)
  "private_not_allowed",
  "private_fixed",
  "private_cannot_join",
  "bad_private",
  // the edge
  "save_failed",
  "network",
  "signed_out",
  "forbidden",
  "rate_limited",
  "body_too_large",
  "bad_json",
  "database_error",
] as const;

const KNOWN: ReadonlySet<string> = new Set(KNOWN_ERROR_CODES);

/** The message key (under `Sign.send`) for a failure code. */
export function errorKey(code: string | null | undefined): string {
  return code && KNOWN.has(code) ? `errors.${code}` : "errors.generic";
}

// ---- problems with a draft -------------------------------------------------------------------

/** Where in the draft workspace a problem is put right. */
export type DraftStep = "fields" | "people" | "options" | "review";

/** Problems only the browser knows about (the draft's own options as typed), fixed in the options step. */
const OPTION_PROBLEMS = new Set(["title_required", "message_long", "expiry_past", "reminders_bad"]);
const PEOPLE_PROBLEMS = new Set(["no_signer", "no_person", "too_many_signers", "signer_name", "signer_email", "signer_phone", "signer_role", "signer_order", "order_not_unique", "same_person_twice", "role_without_person", "part_without_person"]);

/** Problems of a document with a form (phase 1B). Their words are in `Sign.progress.problems`, not `Sign.send.problems`. */
const FORM_PROBLEMS: ReadonlySet<string> = new Set(["part_without_person"]);

/** The messages written for `sendProblems` codes. Layout codes from validateFields/validateRoles share one message. */
const PROBLEM_MESSAGES: ReadonlySet<string> = new Set([
  "no_file",
  "no_signer",
  // a form without a signature (migration 169)
  "no_person",
  "form_mode_needs_a_form",
  "form_mode_signature",
  "form_mode_placement",
  "form_mode_signer_role",
  "too_many_signers",
  "signer_name",
  "signer_email",
  "signer_phone",
  "signer_role",
  "signer_order",
  "role_without_person",
  "part_without_person",
  "signer_without_signature",
  "order_not_unique",
  "same_person_twice",
  "no_roles",
  "title_required",
  "message_long",
  "expiry_past",
  "reminders_bad",
]);

export function problemKey(code: string): string {
  return PROBLEM_MESSAGES.has(code) ? `problems.${code}` : "problems.layout";
}

/** The messages namespace `problemKey(code)` is in: the problems of a form are worded with the rest of the form's words. */
export function problemNamespace(code: string): "Sign.send" | "Sign.progress" {
  return FORM_PROBLEMS.has(code) ? "Sign.progress" : "Sign.send";
}

/** Which step fixes a problem. Layout problems, a missing signature and a missing role are fixed in the fields editor. */
export function problemStep(code: string): DraftStep {
  if (OPTION_PROBLEMS.has(code)) return "options";
  return PEOPLE_PROBLEMS.has(code) ? "people" : "fields";
}

/** The same problem found twice (here and by the server) shows once. */
export function dedupeIssues(issues: readonly SignIssue[]): SignIssue[] {
  const seen = new Set<string>();
  const out: SignIssue[] = [];
  for (const i of issues) {
    const k = `${i.code}|${i.field ?? ""}|${i.role ?? ""}|${i.detail ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}
