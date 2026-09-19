import { parseCsv, toCsv, unguardCsvCell } from '@/lib/csv';

/**
 * Tag / conversation-label CSV import & export (Settings → Tags and
 * Settings → Conversation labels). Pure: parsing, validation and the
 * create/update plan live here so they're unit-tested; the components
 * only fetch, call these, and write the result.
 *
 * File format — a header row with `name` (required), `description` and
 * `color` (`#rrggbb`, `#rgb` or a preset name such as "red"). Headerless
 * files are accepted too: column 1 is the name, 2 the description, 3 the
 * colour. Re-importing an export is safe — rows are matched to existing
 * entries by name (case-insensitive) and updated in place.
 */

/** Which of the two lists a Settings page manages. */
export type TagKind = 'tag' | 'label';

export const TAG_NAME_MAX = 60;
export const TAG_DESCRIPTION_MAX = 240;
export const MAX_IMPORT_ROWS = 2000;
export const DEFAULT_TAG_COLOR = '#3b82f6';

/** Preset swatches. `name` doubles as the i18n key under `colors.*`. */
export const TAG_COLOR_PRESETS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
] as const;

/**
 * Accept `#rgb` / `#rrggbb` (with or without the `#`) or a preset name;
 * return a lowercase `#rrggbb`, or null when it isn't a usable colour.
 */
export function normalizeHexColor(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim().toLowerCase();
  if (!raw) return null;
  const preset = TAG_COLOR_PRESETS.find((p) => p.name === raw);
  if (preset) return preset.value;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return `#${hex}`;
}

export interface ParsedTagRow {
  /** 1-based line number in the file, for error messages. */
  line: number;
  name: string;
  description: string | null;
  /** Normalised `#rrggbb`, or null when the file gave none / an unusable one. */
  color: string | null;
  /** True when a colour was given but couldn't be read (default is used). */
  colorInvalid: boolean;
}

export type TagCsvIssueReason =
  | 'missing_name'
  | 'name_too_long'
  | 'description_too_long'
  | 'duplicate_in_file';

export interface TagCsvIssue {
  line: number;
  reason: TagCsvIssueReason;
  /** The offending name, when there is one — shown next to the reason. */
  name?: string;
}

export interface ParseTagCsvResult {
  rows: ParsedTagRow[];
  /** Rows that were skipped, with why. */
  issues: TagCsvIssue[];
  /** True when the file had more than {@link MAX_IMPORT_ROWS} data rows. */
  tooManyRows: boolean;
}

const NAME_HEADERS = ['name', 'label', 'tag', 'category', 'conversation category'];
const DESCRIPTION_HEADERS = ['description', 'desc'];
const COLOR_HEADERS = ['color', 'colour', 'hex'];

function findColumn(headers: string[], aliases: string[]): number {
  return headers.findIndex((h) => aliases.includes(h));
}

export function parseTagCsv(text: string): ParseTagCsvResult {
  const table = parseCsv(text);
  const empty: ParseTagCsvResult = { rows: [], issues: [], tooManyRows: false };
  if (table.length === 0) return empty;

  const headers = table[0].map((h) => unguardCsvCell(h).trim().toLowerCase());
  let nameIdx = findColumn(headers, NAME_HEADERS);
  let descIdx = findColumn(headers, DESCRIPTION_HEADERS);
  let colorIdx = findColumn(headers, COLOR_HEADERS);
  let firstDataRow = 1;
  if (nameIdx === -1) {
    // Headerless: the first row is data.
    nameIdx = 0;
    descIdx = 1;
    colorIdx = 2;
    firstDataRow = 0;
  }

  const dataRows = table.slice(firstDataRow);
  const tooManyRows = dataRows.length > MAX_IMPORT_ROWS;
  const rows: ParsedTagRow[] = [];
  const issues: TagCsvIssue[] = [];
  const seen = new Set<string>();

  dataRows.slice(0, MAX_IMPORT_ROWS).forEach((cells, i) => {
    const line = firstDataRow + i + 1;
    const cell = (idx: number) =>
      idx >= 0 && idx < cells.length ? unguardCsvCell(cells[idx]).trim() : '';

    const name = cell(nameIdx);
    if (!name) {
      issues.push({ line, reason: 'missing_name' });
      return;
    }
    if (name.length > TAG_NAME_MAX) {
      issues.push({ line, reason: 'name_too_long', name });
      return;
    }
    const description = cell(descIdx);
    if (description.length > TAG_DESCRIPTION_MAX) {
      issues.push({ line, reason: 'description_too_long', name });
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      issues.push({ line, reason: 'duplicate_in_file', name });
      return;
    }
    seen.add(key);

    const rawColor = cell(colorIdx);
    const color = normalizeHexColor(rawColor);
    rows.push({
      line,
      name,
      description: description || null,
      color,
      colorInvalid: rawColor !== '' && color === null,
    });
  });

  return { rows, issues, tooManyRows };
}

export interface ExportableTag {
  name: string;
  description?: string | null;
  color: string;
}

export function tagsToCsv(tags: ExportableTag[]): string {
  return toCsv([
    ['name', 'description', 'color'],
    ...tags.map((t) => [t.name, t.description ?? '', t.color]),
  ]);
}

/** A small example file offered as "Download template". */
export function tagsCsvTemplate(kind: TagKind): string {
  const rows =
    kind === 'label'
      ? [
          ['Billing question', 'Invoices, charges and payment problems', '#f59e0b'],
          ['Refund request', 'Customer asks for money back', '#ef4444'],
          ['Technical issue', '', '#3b82f6'],
        ]
      : [
          ['VIP', 'High-value customer', '#8b5cf6'],
          ['Newsletter', '', '#10b981'],
        ];
  return toCsv([['name', 'description', 'color'], ...rows]);
}

export interface ExistingTag {
  id: string;
  name: string;
  description: string | null;
  color: string;
  for_contacts: boolean;
  for_conversations: boolean;
}

export interface TagImportPatch {
  description?: string;
  color?: string;
  for_contacts?: true;
  for_conversations?: true;
}

export interface TagImportPlan {
  create: {
    name: string;
    description: string | null;
    color: string;
    for_contacts: boolean;
    for_conversations: boolean;
  }[];
  update: { id: string; name: string; patch: TagImportPatch }[];
  /** Rows that match an existing entry and change nothing. */
  unchanged: number;
  /** Updates that only switch the entry on for this list (it existed for the other one). */
  linkedFromOtherList: number;
}

/**
 * Decide what an import does. Rows match existing entries by name,
 * case-insensitively. A blank description/colour in the file never
 * erases what's stored. An entry that exists only in the *other* list is
 * switched on for this one rather than duplicated (names are unique per
 * account).
 */
export function planTagImport(
  existing: ExistingTag[],
  rows: ParsedTagRow[],
  kind: TagKind,
): TagImportPlan {
  const byName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t]));
  const flag = kind === 'tag' ? 'for_contacts' : 'for_conversations';
  const plan: TagImportPlan = { create: [], update: [], unchanged: 0, linkedFromOtherList: 0 };

  for (const row of rows) {
    const found = byName.get(row.name.toLowerCase());
    if (!found) {
      plan.create.push({
        name: row.name,
        description: row.description,
        color: row.color ?? DEFAULT_TAG_COLOR,
        for_contacts: kind === 'tag',
        for_conversations: kind === 'label',
      });
      continue;
    }
    const patch: TagImportPatch = {};
    if (row.description !== null && row.description !== (found.description ?? '')) {
      patch.description = row.description;
    }
    if (row.color !== null && row.color !== found.color.toLowerCase()) {
      patch.color = row.color;
    }
    const linking = !found[flag];
    if (linking) patch[flag] = true;

    if (Object.keys(patch).length === 0) {
      plan.unchanged++;
    } else {
      plan.update.push({ id: found.id, name: found.name, patch });
      if (linking) plan.linkedFromOtherList++;
    }
  }
  return plan;
}
