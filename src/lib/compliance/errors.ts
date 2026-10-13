// ============================================================
// Compliance requests: errors. A code the screens word in four languages and a status. Nothing the database, the network or a stack trace said is
// passed on: `fromDatabase` reads only the code the migration's RAISE EXCEPTION carries.
// ============================================================

import type { ErrorCode } from "./types";

export class ComplianceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly issues?: { field?: string; code: string }[];
  constructor(code: ErrorCode, message: string, status: number, issues?: { field?: string; code: string }[]) {
    super(message);
    this.name = "ComplianceError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

export const STATUS_OF: Record<ErrorCode, number> = {
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  invalid_transition: 409,
  maker_checker: 403,
  note_required: 400,
  identity_incomplete: 400,
  identity_not_passed: 409,
  recommendation_required: 400,
  dues_outstanding: 409,
  checklist_incomplete: 409,
  not_ready_to_execute: 409,
  frozen: 409,
  closed: 409,
  pause_not_allowed: 409,
  not_paused: 409,
  already_paused: 409,
  no_clock: 409,
  unsupported_file: 400,
  file_too_large: 413,
  too_many_files: 400,
  link_other_workspace: 400,
  type_unavailable: 409,
  assignee_cannot_see_requests: 400,
  validation_failed: 400,
  reveal_unavailable: 409,
  encryption_unavailable: 503,
  audit_failed: 503,
  storage_failed: 502,
  customer_reason_required: 400,
  category_required: 400,
  duplicate_open: 409,
  form_link_not_allowed: 409,
  form_link_submitted: 409,
  server_error: 500,
};

const err = (code: ErrorCode): ComplianceError => new ComplianceError(code, MESSAGES[code] ?? code, STATUS_OF[code]);

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  forbidden: "You do not have permission to do that.",
  not_found: "That request was not found.",
  invalid_transition: "The request cannot move that way from where it is.",
  maker_checker: "The person who recorded the identity check cannot sign this request off.",
  note_required: "A note is required.",
  frozen: "This request can no longer be edited.",
  closed: "This request is closed.",
  form_link_not_allowed: "A closure form cannot be sent for this request.",
  form_link_submitted: "The closure form for this request has already been filled in.",
  server_error: "Something went wrong.",
};

/** The database's `compliance_*` exception codes (migration 183) and what they mean here. Longest names first so a prefix never wins. */
const DB_CODES: [string, ErrorCode][] = [
  ["compliance_identity_method_other_required", "identity_incomplete"],
  ["compliance_identity_method_required", "identity_incomplete"],
  ["compliance_identity_outcome_required", "identity_incomplete"],
  ["compliance_identity_not_passed", "identity_not_passed"],
  ["compliance_recommendation_required", "recommendation_required"],
  ["compliance_assignee_cannot_see_requests", "assignee_cannot_see_requests"],
  ["compliance_link_other_workspace", "link_other_workspace"],
  ["compliance_checklist_incomplete", "checklist_incomplete"],
  ["compliance_not_ready_to_execute", "not_ready_to_execute"],
  ["compliance_pause_not_allowed", "pause_not_allowed"],
  ["compliance_invalid_transition", "invalid_transition"],
  ["compliance_dues_outstanding", "dues_outstanding"],
  ["compliance_already_paused", "already_paused"],
  ["compliance_type_unavailable", "type_unavailable"],
  ["compliance_maker_checker", "maker_checker"],
  ["compliance_note_required", "note_required"],
  ["compliance_note_too_long", "validation_failed"],
  ["compliance_form_link_submitted", "form_link_submitted"],
  // the guard on the links table: no route should ever trip it with a value of its own (a bug or a direct write)
  ["compliance_form_link_change_refused", "forbidden"],
  ["compliance_form_link_fixed_fields", "invalid_request"],
  ["compliance_form_link_not_allowed", "form_link_not_allowed"],
  ["compliance_form_link_not_found", "not_found"],
  // the customer's own submission: a link that cannot be used any more is, to everyone, just not found
  ["compliance_form_link_invalid", "not_found"],
  ["compliance_request_not_found", "not_found"],
  ["compliance_step_not_found", "not_found"],
  ["compliance_not_allowed", "forbidden"],
  ["compliance_not_paused", "not_paused"],
  ["compliance_no_clock", "no_clock"],
  ["compliance_no_standing_for_type", "invalid_request"],
  ["compliance_standing_required", "invalid_request"],
  ["compliance_received_at_out_of_range", "validation_failed"],
  ["compliance_unknown_field", "invalid_request"],
  ["compliance_bad_patch", "invalid_request"],
  ["compliance_bad_category", "invalid_request"],
  ["compliance_bad_clock_action", "invalid_request"],
  ["compliance_frozen", "frozen"],
  ["compliance_closed", "closed"],
  ["compliance_request_under_retention", "forbidden"],
  // guards no route should ever trip with a value of its own (a bug or a direct write): refused, in a word
  ["compliance_checklist_change_refused", "forbidden"],
  ["compliance_request_change_refused", "forbidden"],
  ["compliance_request_events", "forbidden"],
  ["compliance_checklist_item_is_fixed", "invalid_request"],
  ["compliance_request_fixed_fields", "invalid_request"],
  ["compliance_system_type_is_fixed", "invalid_request"],
  ["compliance_type_key_is_fixed", "invalid_request"],
  ["compliance_must_start_received", "invalid_request"],
];

/** The names of the database exceptions this module maps (a test checks every `compliance_*` the migrations can raise is in it). */
export const DB_CODE_LIST: readonly string[] = DB_CODES.map(([needle]) => needle);

/** A ComplianceError for a database error (a Supabase error object or an Error), reading only the migration's `compliance_*` code. */
export function fromDatabase(e: { message?: string; code?: string } | null | undefined): ComplianceError {
  const msg = e?.message ?? "";
  for (const [needle, code] of DB_CODES) if (msg.includes(needle)) return err(code);
  if (e?.code === "42501") return err("forbidden");
  if (e?.code === "23503") return err("invalid_request");
  if (e?.code === "22P02") return err("invalid_request");
  // the one-open-request-per-email index (migration 184); any other unique violation is not something a person can fix
  if (e?.code === "23505" && msg.includes("compliance_requests_form_open_email")) return err("duplicate_open");
  return err("server_error");
}

export { err as complianceError };
