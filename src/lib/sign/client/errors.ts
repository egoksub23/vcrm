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
const PEOPLE_PROBLEMS = new Set(["no_signer", "too_many_signers", "signer_name", "signer_email", "signer_phone", "signer_role", "signer_order", "order_not_unique", "same_person_twice", "role_without_person"]);

/** The messages written for `sendProblems` codes. Layout codes from validateFields/validateRoles share one message. */
const PROBLEM_MESSAGES: ReadonlySet<string> = new Set([
  "no_file",
  "no_signer",
  "too_many_signers",
  "signer_name",
  "signer_email",
  "signer_phone",
  "signer_role",
  "signer_order",
  "role_without_person",
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
