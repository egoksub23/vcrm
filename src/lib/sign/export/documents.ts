// ============================================================
// Doc Sign: the documents list as a CSV file (GET /api/sign/documents/export). Pure: which documents the
// filters ask for, and the lines of the file. The route reads the pages and streams them.
//
// The filters are the list's own (status group, category, search, contact) plus a date range on the day a
// document was made. The columns: reference, title, category, status, contact, signers, created, sent,
// completed, expires, mode (`sign` for an agreement, `form` for a form without a signature: migration 169; added last so a
// reader that counts columns is not moved). Cells that start with = + - @ are guarded by toCsv against spreadsheet formulas.
// ============================================================

import { toCsv } from "@/lib/csv";

import { GROUP_STATUSES, STATUS_GROUPS, sanitizeSearch, type StatusGroup } from "../client/list-filters";

/** The most documents one file holds. */
export const EXPORT_MAX_ROWS = 50_000;
/** Documents read from the database per round trip while streaming (it answers at most 1000). */
export const EXPORT_PAGE_SIZE = 500;

export const EXPORT_HEADER = ["reference", "title", "category", "status", "contact", "signers", "created", "sent", "completed", "expires", "mode"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ExportFilters {
  group: StatusGroup;
  /** "all", "none" or a category id. */
  category: string;
  search: string;
  /** `YYYY-MM-DD`: documents made on or after this day (in the workspace's time zone). */
  from: string | null;
  /** `YYYY-MM-DD`: documents made on or before this day. */
  to: string | null;
  contactId: string | null;
}

const validDate = (v: string | null): string | null => {
  const m = v ? DATE_RE.exec(v) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? v : null;
};

/** The filters in a request's query string. Anything not understood is left out rather than guessed. */
export function parseExportFilters(params: URLSearchParams): ExportFilters {
  const status = params.get("status") ?? "all";
  const category = params.get("category") ?? "all";
  const contact = params.get("contact");
  return {
    group: (STATUS_GROUPS as readonly string[]).includes(status) ? (status as StatusGroup) : "all",
    category: category === "none" || UUID_RE.test(category) ? category : "all",
    search: sanitizeSearch(params.get("q") ?? ""),
    from: validDate(params.get("from")),
    to: validDate(params.get("to")),
    contactId: contact && UUID_RE.test(contact) ? contact : null,
  };
}

/** The query string for a set of filters (what the list's Export button sends). Empty filters are omitted. */
export function exportQuery(f: Partial<ExportFilters>): string {
  const p = new URLSearchParams();
  if (f.group && f.group !== "all") p.set("status", f.group);
  if (f.category && f.category !== "all") p.set("category", f.category);
  const q = sanitizeSearch(f.search ?? "");
  if (q) p.set("q", q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.contactId) p.set("contact", f.contactId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---- days in the workspace's time zone ---------------------------------------------------------

function offsetMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The instant a calendar day starts in a time zone (UTC when the zone is not known), as an ISO time. Null for a bad date. */
export function startOfDayIso(date: string, timeZone: string): string | null {
  if (!validDate(date)) return null;
  const m = DATE_RE.exec(date)!;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let zone = timeZone;
  try {
    offsetMinutes(guess, zone);
  } catch {
    zone = "UTC";
  }
  let instant = guess - offsetMinutes(guess, zone) * 60_000;
  // the offset can differ at the start of the day (a clock change): once more from the first answer
  instant = guess - offsetMinutes(instant, zone) * 60_000;
  return new Date(instant).toISOString();
}

/** The day after a `YYYY-MM-DD` date. */
export function nextDay(date: string): string {
  const m = DATE_RE.exec(date)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}

/** The created-at bounds of the date range: from the start of `from` up to (not including) the day after `to`. */
export function createdRange(f: Pick<ExportFilters, "from" | "to">, timeZone: string): { gte: string | null; lt: string | null } {
  return {
    gte: f.from ? startOfDayIso(f.from, timeZone) : null,
    lt: f.to ? startOfDayIso(nextDay(f.to), timeZone) : null,
  };
}

// ---- the query ------------------------------------------------------------------------------------

/** The part of a PostgREST filter builder the export uses; every method returns the builder. */
interface Filterable {
  in(column: string, values: readonly string[]): Filterable;
  is(column: string, value: null): Filterable;
  eq(column: string, value: string): Filterable;
  or(filters: string): Filterable;
  gte(column: string, value: string): Filterable;
  lt(column: string, value: string): Filterable;
}

/** Narrow a documents query to the filters. `clause` is the search's `or(...)` filter (title, reference, or a matching signer's document). */
export function applyExportFilters<T>(query: T, f: ExportFilters, clause: string | null, range: { gte: string | null; lt: string | null }): T {
  let q = query as unknown as Filterable;
  const statuses = GROUP_STATUSES[f.group];
  if (statuses) q = q.in("status", statuses);
  if (f.category === "none") q = q.is("category_id", null);
  else if (f.category !== "all") q = q.eq("category_id", f.category);
  if (f.contactId) q = q.eq("contact_id", f.contactId);
  if (range.gte) q = q.gte("created_at", range.gte);
  if (range.lt) q = q.lt("created_at", range.lt);
  if (clause) q = q.or(clause);
  return q as unknown as T;
}

// ---- the lines -------------------------------------------------------------------------------------

export interface ExportDocRow {
  reference: string | null;
  title: string;
  status: string;
  category_id: string | null;
  created_at: string | null;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  contacts: { name: string | null } | null;
  sign_signers: { full_name: string; order_no: number }[] | null;
  /** Migration 169. Absent (an older row) is an agreement. */
  mode?: string | null;
}

export function exportHeaderLine(): string {
  return toCsv([[...EXPORT_HEADER]]);
}

const iso = (v: string | null): string => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};

/** CRLF-terminated lines for a page of documents. `categoryNames` maps a category id to its name. */
export function exportLines(rows: readonly ExportDocRow[], categoryNames: ReadonlyMap<string, string>): string {
  if (rows.length === 0) return "";
  return toCsv(
    rows.map((r) => [
      r.reference ?? "",
      r.title,
      r.category_id ? (categoryNames.get(r.category_id) ?? "") : "",
      r.status,
      r.contacts?.name ?? "",
      [...(r.sign_signers ?? [])]
        .sort((a, b) => a.order_no - b.order_no || a.full_name.localeCompare(b.full_name))
        .map((s) => s.full_name)
        .join("; "),
      iso(r.created_at),
      iso(r.sent_at),
      iso(r.completed_at),
      iso(r.expires_at),
      r.mode === "form" ? "form" : "sign",
    ]),
  );
}

/** The file name of an export: the date it was made. */
export const exportFileName = (now: Date): string => `signing-documents-${now.toISOString().slice(0, 10)}.csv`;
