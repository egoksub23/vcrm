// ============================================================
// Doc Sign bulk send: the result file of a batch, one line per person, so the sender can see (and re-send) what
// did not go. Cells that start with = + - @ are guarded by toCsv against spreadsheet formulas.
// ============================================================

import { toCsv } from "@/lib/csv";

import type { BulkRowState } from "./types";

export const RESULT_HEADER = ["row", "name", "email", "phone", "result", "reference", "document_id", "error_code", "error_message"] as const;

export interface ResultRow {
  rowNo: number;
  name: string;
  email: string;
  phone: string | null;
  state: BulkRowState;
  reference: string | null;
  documentId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** The header line, CRLF-terminated. */
export function resultHeaderLine(): string {
  return toCsv([[...RESULT_HEADER]]);
}

/** CRLF-terminated lines for some rows. A person still waiting reads "pending". */
export function resultLines(rows: readonly ResultRow[]): string {
  if (rows.length === 0) return "";
  return toCsv(rows.map((r) => [String(r.rowNo), r.name, r.email, r.phone ?? "", r.state, r.reference ?? "", r.documentId ?? "", r.errorCode ?? "", r.errorMessage ?? ""]));
}

/** The file name of a batch's results: the template's name made plain, and the date. */
export function resultFileName(templateName: string, createdAt: string): string {
  const slug = templateName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `bulk-send-${slug || "documents"}-${createdAt.slice(0, 10)}.csv`;
}

/** The sentence for a problem found in a row, in English, for the result file and the log (the screens word the code themselves). */
export function problemText(code: string, detail?: string): string {
  switch (code) {
    case "name_missing":
      return "The name is missing.";
    case "name_too_long":
      return "The name is longer than 160 characters.";
    case "email_missing":
      return "The email address is missing.";
    case "email_invalid":
      return "The email address is not valid.";
    case "email_duplicate":
      return `The same email address is on row ${detail ?? "above"}.`;
    case "phone_invalid":
      return "A phone number with its country code is needed to send a WhatsApp message.";
    case "merge_missing":
      return `A value the template needs is missing: ${detail ?? ""}.`;
    case "merge_too_long":
      return `A value is too long: ${detail ?? ""}.`;
    case "contact_invalid":
      return "The contact id is not valid.";
    case "contact_not_found":
      return "That contact was not found in this workspace.";
    case "same_person_twice":
      return "This person is also one of the fixed people, and signing order is on.";
    default:
      return "This row has a problem.";
  }
}

/** A problem as stored in a row's error_code: `code` or `code:detail`. */
export const encodeProblem = (p: { code: string; detail?: string }): string => (p.detail ? `${p.code}:${p.detail}` : p.code).slice(0, 60);

/** The code and detail of a stored error_code. */
export function decodeProblem(stored: string | null): { code: string; detail?: string } | null {
  if (!stored) return null;
  const i = stored.indexOf(":");
  return i < 0 ? { code: stored } : { code: stored.slice(0, i), detail: stored.slice(i + 1) };
}
