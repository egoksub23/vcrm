// ============================================================
// Doc Sign bulk send: reading the list of people and checking each one. Pure (no I/O), so every rule is tested.
//
//   parseBulkCsv   CSV text to rows. A header row is required (`full_name`, `email`, optionally `phone`,
//                  `contact_id`, and one column for each value the template fills in). UTF-8 with or without a
//                  BOM, quoted cells with commas and line breaks, at most 500 people and 1 MB.
//   checkRows      each person: a name, a usable address that appears once, every value the template needs.
//
// A cell the contacts export guarded against spreadsheet formulas (a leading apostrophe) is read back as it was.
// ============================================================

import { parseCsv, unguardCsvCell } from "@/lib/csv";

import { normalizePhone } from "../rules";
import type { SignChannel } from "../types";
import { BULK_MAX_BYTES, BULK_MAX_ROWS, BULK_MAX_VALUE, type BulkPreviewRow, type BulkProblem } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** The columns with a meaning of their own, and the other names each answers to (compared in lower case, spaces as underscores). */
const STANDARD: Record<string, readonly string[]> = {
  full_name: ["full_name", "name", "fullname"],
  email: ["email", "e_mail", "email_address"],
  phone: ["phone", "mobile", "phone_number", "tel", "telephone"],
  contact_id: ["contact_id", "contactid"],
};

const norm = (h: string): string => h.trim().toLowerCase().replace(/[\s\-]+/g, "_");

function standardOf(header: string): string | null {
  const n = norm(header);
  for (const [canonical, names] of Object.entries(STANDARD)) if (names.includes(n)) return canonical;
  return null;
}

/** One cell as stored: formula guard undone, control characters dropped, line breaks and tabs as spaces, trimmed. */
export function cleanCell(raw: string): string {
  return unguardCsvCell(raw).normalize("NFC").replace(CONTROL_RE, "").replace(/[\r\n\t]+/g, " ").trim();
}

export interface RawBulkRow {
  /** The person's position in the list (the first person is 1; the header row is not counted). */
  rowNo: number;
  /** Keyed by `full_name`, `email`, `phone`, `contact_id`, or the template's merge key. */
  cells: Record<string, string>;
}

export interface ParsedBulkFile {
  rows: RawBulkRow[];
  problems: BulkProblem[];
  /** Columns of the file that nothing uses (shown, so a misspelt column name is noticed). */
  ignoredColumns: string[];
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Read CSV text. `mergeKeys` are the values the template fills in, each looked for as a column of the same name. */
export function parseBulkCsv(text: string, mergeKeys: readonly string[]): ParsedBulkFile {
  const problems: BulkProblem[] = [];
  if (utf8Length(text) > BULK_MAX_BYTES) return { rows: [], problems: [{ code: "too_large", detail: String(BULK_MAX_BYTES) }], ignoredColumns: [] };

  const table = parseCsv(text);
  if (table.length === 0 || table.every((r) => r.every((c) => c.trim() === ""))) return { rows: [], problems: [{ code: "empty_file" }], ignoredColumns: [] };

  const header = table[0];
  if (header.every((c) => c.trim() === "")) return { rows: [], problems: [{ code: "no_header" }], ignoredColumns: [] };

  const mergeByName = new Map(mergeKeys.map((k) => [norm(k), k]));
  const columns: (string | null)[] = [];
  const seen = new Set<string>();
  const ignored: string[] = [];
  header.forEach((h, i) => {
    const name = h.replace(/^\uFEFF/, "").trim();
    if (name === "") {
      columns[i] = null;
      return;
    }
    const canonical = standardOf(name) ?? mergeByName.get(norm(name)) ?? null;
    if (canonical === null) {
      ignored.push(name);
      columns[i] = null;
      return;
    }
    if (seen.has(canonical)) problems.push({ code: "duplicate_column", detail: name });
    seen.add(canonical);
    columns[i] = canonical;
  });
  for (const required of ["full_name", "email"]) if (!seen.has(required)) problems.push({ code: "missing_column", detail: required });

  const body = table.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  if (body.length === 0) problems.push({ code: "no_rows" });
  if (body.length > BULK_MAX_ROWS) problems.push({ code: "too_many_rows", detail: String(body.length) });

  const rows: RawBulkRow[] = body.slice(0, BULK_MAX_ROWS).map((r, i) => {
    const cells: Record<string, string> = {};
    columns.forEach((name, c) => {
      // the first of two columns that mean the same wins; the problem is already reported
      if (name !== null && cells[name] === undefined) cells[name] = cleanCell(r[c] ?? "");
    });
    return { rowNo: i + 1, cells };
  });
  return { rows, problems, ignoredColumns: ignored };
}

/** A row from a contact the sender picked. */
export function rawRowFromContact(rowNo: number, c: { id: string; name: string | null; email: string | null; phone: string | null }): RawBulkRow {
  return { rowNo, cells: { full_name: cleanCell(c.name ?? ""), email: cleanCell(c.email ?? ""), phone: cleanCell(c.phone ?? ""), contact_id: c.id } };
}

/** The value a template merge key takes from the person when the file has no column for it. */
function fromPerson(key: string, person: { name: string; email: string; phone: string | null }): string | null {
  switch (norm(key)) {
    case "full_name":
    case "name":
    case "fullname":
      return person.name;
    case "email":
    case "email_address":
      return person.email;
    case "phone":
    case "phone_number":
    case "mobile":
      return person.phone ?? "";
    default:
      return null;
  }
}

/** True when a template merge key is answered by the person themselves (their name, email or phone), so no column is needed. */
export const isPersonKey = (key: string): boolean => fromPerson(key, { name: "", email: "", phone: null }) !== null;

export interface CheckOptions {
  mergeKeys: readonly string[];
  /** How the people of the list are reached: a WhatsApp message needs a number. */
  channel: SignChannel;
  /** Emails of the fixed people, to catch the same person on two roles when signing order is on (lower case). */
  fixedEmails?: readonly string[];
  /** The document will need signing order. */
  signInOrder?: boolean;
}

/** Check every person. The order is the file's order; a repeated address is flagged on its second and later rows. */
export function checkRows(raw: readonly RawBulkRow[], opts: CheckOptions): BulkPreviewRow[] {
  const firstSeen = new Map<string, number>();
  const fixed = new Set((opts.fixedEmails ?? []).map((e) => e.trim().toLowerCase()));
  return raw.map((r) => {
    const problems: BulkProblem[] = [];
    const name = (r.cells.full_name ?? "").trim();
    const email = (r.cells.email ?? "").trim();
    const phoneRaw = (r.cells.phone ?? "").trim();
    const contactId = (r.cells.contact_id ?? "").trim();

    if (name === "") problems.push({ code: "name_missing" });
    else if (name.length > 160) problems.push({ code: "name_too_long" });

    if (email === "") problems.push({ code: "email_missing" });
    else if (!EMAIL_RE.test(email) || email.length > 254) problems.push({ code: "email_invalid" });
    else {
      const key = email.toLowerCase();
      const first = firstSeen.get(key);
      if (first === undefined) firstSeen.set(key, r.rowNo);
      else problems.push({ code: "email_duplicate", detail: String(first) });
      if (opts.signInOrder && fixed.has(key)) problems.push({ code: "same_person_twice" });
    }

    const normalized = normalizePhone(phoneRaw);
    if (opts.channel === "whatsapp" && !normalized) problems.push({ code: "phone_invalid" });
    const phone = normalized ?? (phoneRaw !== "" && phoneRaw.length <= 32 ? phoneRaw : null);

    if (contactId !== "" && !UUID_RE.test(contactId)) problems.push({ code: "contact_invalid" });

    const merge: Record<string, string> = {};
    for (const key of opts.mergeKeys) {
      const own = (r.cells[key] ?? "").trim();
      const value = own !== "" ? own : (fromPerson(key, { name, email, phone })?.trim() ?? "");
      if (value === "") problems.push({ code: "merge_missing", detail: key });
      else if (value.length > BULK_MAX_VALUE) problems.push({ code: "merge_too_long", detail: key });
      else merge[key] = value;
    }

    return { rowNo: r.rowNo, name, email, phone, contactId: contactId !== "" && UUID_RE.test(contactId) ? contactId : null, merge, problems };
  });
}

/** True when a person can be sent a document (no problem at all). */
export const rowIsClean = (r: { problems: readonly BulkProblem[] }): boolean => r.problems.length === 0;
