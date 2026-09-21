import { toCsv } from '@/lib/csv';

/**
 * Contacts export (GET /api/contacts/export). The columns are the ones the
 * importer reads (phone, name, email, company, tags) plus created_at, which
 * the importer ignores, so an exported file can be imported back.
 *
 * Cells that start with = + - @ get a leading apostrophe from toCsv (formula
 * injection guard). The importer strips apostrophes, so the round trip is
 * lossless for phones like +44 7911 123456.
 */
export const CONTACT_EXPORT_HEADER = [
  'phone',
  'name',
  'email',
  'company',
  'tags',
  'created_at',
] as const;

/** Rows read from the database per round trip while streaming. */
export const CONTACT_EXPORT_PAGE_SIZE = 500;
/** Safety ceiling for one file; well above any realistic account. */
export const CONTACT_EXPORT_MAX_ROWS = 200_000;
/** Tag names inside the tags cell. The importer splits on , or ; */
export const CONTACT_EXPORT_TAG_SEPARATOR = '; ';

export interface ContactExportRow {
  phone: string | null;
  name: string | null;
  email: string | null;
  company: string | null;
  created_at: string | null;
  contact_tags?: { tag_id: string }[] | null;
}

export function contactExportHeaderLine(): string {
  return toCsv([[...CONTACT_EXPORT_HEADER]]);
}

/** CRLF-terminated CSV lines for a page of contacts. `tagNames` maps tag id to name. */
export function contactExportLines(
  rows: readonly ContactExportRow[],
  tagNames: ReadonlyMap<string, string>
): string {
  if (rows.length === 0) return '';
  return toCsv(
    rows.map((row) => {
      const names = (row.contact_tags ?? [])
        .map((ct) => tagNames.get(ct.tag_id))
        .filter((n): n is string => Boolean(n))
        .sort((a, b) => a.localeCompare(b));
      return [
        row.phone ?? '',
        row.name ?? '',
        row.email ?? '',
        row.company ?? '',
        names.join(CONTACT_EXPORT_TAG_SEPARATOR),
        row.created_at ?? '',
      ];
    })
  );
}

/**
 * Makes a search term safe inside a PostgREST `or(...)` filter: drops the
 * characters that carry meaning there (commas, parentheses, quotes, `*`, `%`,
 * backslash). Keeps letters, digits, spaces and the punctuation a phone,
 * email or name uses.
 */
export function sanitizeContactSearch(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[,()"'*%\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses `tag_ids=a,b,c`; drops anything that is not a UUID; max 50. */
export function parseTagIdsParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (UUID.test(id)) seen.add(id.toLowerCase());
    if (seen.size >= 50) break;
  }
  return [...seen];
}
