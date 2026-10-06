// ============================================================
// Option lists as CSV: reading a file an admin uploads (Excel's "CSV UTF-8" or any plain CSV), merging it into a list,
// and writing a list out. The way to load the full MSIC list, or a bank list, without typing it.
//
//   columns   value (or code) and en (or description/label) are required; ms, zh, ko, group and archived are optional.
//             Names are matched without regard to case, spaces or a leading BOM: "Code", "Description",
//             "Description (Malay)", "BM", "Malay" all work. The separator may be a comma, a semicolon or a tab.
//   rows      one item per row. A row with a problem is left out and reported, never half applied; the rest go in.
//   MSIC      the value must be five digits. A code that lost its leading zero in a spreadsheet (1111 for 01111) is
//             padded back, and reported as a warning.
//
// Pure: no I/O. The route reads the file and writes the result; this file decides what a file means.
// ============================================================

import type { L10n } from "../forms/types";
import { LIST_VALUE_RE, MAX_ITEM_LABEL, MAX_LIST_ITEMS, MSIC_CODE_RE, type ImportProblem, type ListItem, type ListKind } from "./types";

// ---- the CSV format itself ---------------------------------------------------------------------------------------

/** Pick the separator from the first line (outside quotes): the one that occurs most among comma, semicolon and tab. */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return [",", ";", "\t"].reduce((best, d) => (counts[d] > counts[best] ? d : best), ",");
}

/** Rows of cells. Handles a BOM, quotes (with "" for a quote), separators and line breaks inside quotes, CRLF, LF and CR. Blank lines are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let touched = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (touched || row.some((c) => c !== "")) rows.push(row);
    row = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      touched = true;
    } else if (ch === delimiter) {
      endCell();
      touched = true;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") endRow();
    else cell += ch;
  }
  if (cell !== "" || row.length > 0 || touched) endRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** One cell as CSV text: quoted when it holds a separator, a quote or a line break; a formula is made harmless. */
export function csvCell(value: string): string {
  let v = value;
  // a spreadsheet would run text that starts like a formula; a leading apostrophe makes it plain text (and is removed on import)
  if (/^[=+\-@]/.test(v) && !/^[+-]?\d/.test(v)) v = `'${v}`;
  return /[",;\r\n\t]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

export const CSV_COLUMNS = ["value", "en", "ms", "zh", "ko", "group", "archived"] as const;

/** A list as a CSV file (UTF-8 with a BOM so that Excel shows Malay, Chinese and Korean correctly). */
export function exportCsv(items: readonly ListItem[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const i of items) {
    lines.push([i.value, i.label.en, i.label.ms ?? "", i.label.zh ?? "", i.label.ko ?? "", i.group ?? "", i.archived ? "yes" : ""].map(csvCell).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ---- reading a file as items ---------------------------------------------------------------------------------------

type Column = "value" | "en" | "ms" | "zh" | "ko" | "group" | "archived";

const ALIASES: Record<Column, readonly string[]> = {
  value: ["value", "code", "key", "id", "kod", "msic", "msic_code"],
  en: ["en", "english", "label_en", "label", "name", "text", "description", "description_en", "desc_en", "english_description", "description_english"],
  ms: ["ms", "bm", "malay", "bahasa", "bahasa_melayu", "label_ms", "label_bm", "description_ms", "description_bm", "desc_bm", "desc_ms", "malay_description", "description_malay", "description_bahasa_melayu", "description_bahasa", "keterangan"],
  zh: ["zh", "chinese", "label_zh", "description_zh"],
  ko: ["ko", "korean", "label_ko", "description_ko"],
  group: ["group", "division", "section", "category", "kumpulan"],
  archived: ["archived", "hidden", "inactive"],
};

const headerKey = (h: string): string => h.replace(/^﻿/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Which column of the file holds what. */
function mapColumns(header: readonly string[]): Partial<Record<Column, number>> {
  const found: Partial<Record<Column, number>> = {};
  header.forEach((h, i) => {
    const k = headerKey(h);
    for (const col of Object.keys(ALIASES) as Column[]) {
      if (found[col] === undefined && ALIASES[col].includes(k)) {
        found[col] = i;
        return;
      }
    }
  });
  return found;
}

const unformula = (s: string): string => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);
const YES = new Set(["yes", "y", "true", "1", "x", "ya"]);

export interface ParsedItems {
  items: ListItem[];
  /** Which optional columns the file had (so that an import changes only what the file talks about). */
  columns: readonly Column[];
  problems: ImportProblem[];
}

/** Read a file's text as items of a list of `kind`. Never throws. */
export function parseListCsv(text: string, kind: ListKind): ParsedItems {
  const problems: ImportProblem[] = [];
  const fail = (code: string, detail?: string): ParsedItems => ({ items: [], columns: [], problems: [{ row: 0, code, level: "error", ...(detail ? { detail } : {}) }] });
  const rows = parseCsv(text);
  if (rows.length === 0) return fail("empty_file");
  const cols = mapColumns(rows[0]);
  if (cols.value === undefined) return fail("missing_value_column");
  if (cols.en === undefined) return fail("missing_en_column");
  const body = rows.slice(1);
  if (body.length === 0) return fail("no_rows");
  if (body.length > MAX_LIST_ITEMS) return fail("too_many_rows", String(MAX_LIST_ITEMS));

  const seen = new Set<string>();
  const items: ListItem[] = [];
  const cell = (r: string[], c: Column): string => {
    const i = cols[c];
    return i === undefined ? "" : unformula((r[i] ?? "").replace(/\s+/g, " ").trim());
  };
  body.forEach((r, n) => {
    const row = n + 1;
    const err = (code: string, detail?: string) => problems.push({ row, code, level: "error", ...(detail ? { detail } : {}) });
    let value = cell(r, "value");
    if (value === "") return err("empty_value");
    if (kind === "msic" && /^\d{4}$/.test(value)) {
      problems.push({ row, code: "code_padded", level: "warning", detail: value });
      value = `0${value}`;
    }
    if (kind === "msic" ? !MSIC_CODE_RE.test(value) : !LIST_VALUE_RE.test(value)) return err(kind === "msic" ? "bad_msic_code" : "bad_value", value);
    if (seen.has(value)) return err("duplicate_value", value);
    const en = cell(r, "en");
    if (en === "") return err("empty_label", value);
    const label: L10n = { en };
    for (const lang of ["ms", "zh", "ko"] as const) {
      const t = cell(r, lang);
      if (t !== "") label[lang] = t;
    }
    if (Object.values(label).some((t) => t.length > MAX_ITEM_LABEL)) return err("label_too_long", value);
    const group = cell(r, "group");
    if (group.length > 40) return err("group_too_long", value);
    seen.add(value);
    const item: ListItem = { value, label };
    if (group) item.group = group;
    if (cols.archived !== undefined && YES.has(cell(r, "archived").toLowerCase())) item.archived = true;
    items.push(item);
  });
  const columns = (Object.keys(cols) as Column[]).filter((c) => c !== "value" && c !== "en");
  return { items, columns, problems };
}

// ---- merging into a list ---------------------------------------------------------------------------------------------

export interface Merged {
  items: ListItem[];
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

const sameLabel = (a: L10n, b: L10n): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply imported items to a list. `merge` adds what is new and updates what is there (a language the file does not
 * give is kept; the order of the list is kept, new items go last). `replace` makes the list exactly the file. Only a list
 * that is not a system list may be replaced: the caller checks, because a system list's values can never go.
 */
export function mergeImported(existing: readonly ListItem[], parsed: ParsedItems, mode: "merge" | "replace"): Merged {
  const touched = (c: Column) => parsed.columns.includes(c);
  if (mode === "replace") {
    const had = new Map(existing.map((i) => [i.value, i]));
    let updated = 0;
    let unchanged = 0;
    let added = 0;
    for (const i of parsed.items) {
      const old = had.get(i.value);
      if (!old) added++;
      else if (sameLabel(old.label, i.label) && (old.group ?? "") === (i.group ?? "") && !!old.archived === !!i.archived) unchanged++;
      else updated++;
    }
    const keep = new Set(parsed.items.map((i) => i.value));
    return { items: parsed.items, added, updated, unchanged, removed: existing.filter((i) => !keep.has(i.value)).length };
  }
  const byValue = new Map(parsed.items.map((i) => [i.value, i]));
  let updated = 0;
  let unchanged = 0;
  const merged = existing.map((old) => {
    const incoming = byValue.get(old.value);
    if (!incoming) return old;
    byValue.delete(old.value);
    const label: L10n = { ...old.label, ...incoming.label };
    const next: ListItem = { ...old, label };
    if (touched("group")) {
      if (incoming.group) next.group = incoming.group;
      else delete next.group;
    }
    if (touched("archived")) {
      if (incoming.archived) next.archived = true;
      else delete next.archived;
    }
    if (JSON.stringify(next) === JSON.stringify(old)) {
      unchanged++;
      return old;
    }
    updated++;
    return next;
  });
  const fresh = [...byValue.values()];
  return { items: [...merged, ...fresh], added: fresh.length, updated, unchanged, removed: 0 };
}
