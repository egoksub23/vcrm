// ============================================================
// Doc Sign administration screens (Settings, add-ons, the template library): which message says what went
// wrong for each stable failure code a route answers with (`SignApiError.code`). The messages are
// `Sign.admin.errors.<code>`; a code the screens have never seen reads as `errors.generic`, never as a raw code.
// ============================================================

export const ADMIN_ERROR_CODES = [
  // add-ons
  "addon_not_available",
  "addon_not_found",
  "addon_source_missing",
  // an uploaded file
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
  "image_unreadable",
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
  // templates
  "template_not_found",
  "template_has_no_version",
  "template_not_ready",
  "category_not_found",
  "bad_name",
  "invalid_layout",
  // the edge
  "network",
  "signed_out",
  "forbidden",
  "rate_limited",
  "body_too_large",
  "bad_json",
  "database_error",
  "request_failed",
] as const;

const KNOWN: ReadonlySet<string> = new Set(ADMIN_ERROR_CODES);

/** The message key under `Sign.admin` for a failure code. */
export function adminErrorKey(code: string | null | undefined): string {
  return code && KNOWN.has(code) ? `errors.${code}` : "errors.generic";
}
