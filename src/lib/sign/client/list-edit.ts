// ============================================================
// Doc Sign option lists, the Lists screen: the pure part. What a person types for an item becomes an item (or says what is
// wrong with it), the items are paged and searched, an item is added, relabelled, moved or archived without touching the
// rest, and a failed call or a problem in an imported file is worded by a stable code.
// Pure: no React, no I/O.
// ============================================================

import type { L10n } from "../forms/types";
import { LIST_VALUE_RE, MAX_ITEM_LABEL, MAX_LIST_ITEMS, MSIC_CODE_RE, type ListItem, type ListKind } from "../lists/types";
import { moveItem } from "./form-edit";

export const LIST_PAGE_SIZE = 50;

export interface Page<T> {
  rows: T[];
  /** 1-based, kept within what exists. */
  page: number;
  pages: number;
  total: number;
}

export function paginate<T>(items: readonly T[], page: number, size = LIST_PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: items.slice((at - 1) * size, at * size), page: at, pages, total: items.length };
}

// ---- one item as a form ----------------------------------------------------------------------------------------------

export interface ItemDraft {
  value: string;
  en: string;
  ms: string;
  zh: string;
  ko: string;
  group: string;
}

export const emptyDraft = (): ItemDraft => ({ value: "", en: "", ms: "", zh: "", ko: "", group: "" });

export const draftOf = (item: ListItem): ItemDraft => ({ value: item.value, en: item.label.en, ms: item.label.ms ?? "", zh: item.label.zh ?? "", ko: item.label.ko ?? "", group: item.group ?? "" });

/** The item a draft stands for. Empty languages and an empty group are left out. `archived` is carried over from `from`. */
export function itemFromDraft(d: ItemDraft, from?: ListItem): ListItem {
  const label: L10n = { en: d.en.trim() };
  for (const lang of ["ms", "zh", "ko"] as const) {
    const t = d[lang].trim();
    if (t) label[lang] = t;
  }
  const item: ListItem = { value: d.value.trim(), label };
  if (d.group.trim()) item.group = d.group.trim();
  if (from?.archived) item.archived = true;
  return item;
}

/** What is wrong with a draft, as codes (`errors.<code>`); empty when it can be saved. `taken` holds the values already in the list. */
export function draftProblems(d: ItemDraft, kind: ListKind, taken: ReadonlySet<string>, isNew: boolean): string[] {
  const out: string[] = [];
  const value = d.value.trim();
  if (isNew) {
    if (value === "") out.push("empty_value");
    else if (kind === "msic" ? !MSIC_CODE_RE.test(value) : !LIST_VALUE_RE.test(value)) out.push(kind === "msic" ? "bad_msic_code" : "bad_value");
    else if (taken.has(value)) out.push("duplicate_value");
  }
  if (d.en.trim() === "") out.push("empty_label");
  if ([d.en, d.ms, d.zh, d.ko].some((t) => t.trim().length > MAX_ITEM_LABEL)) out.push("label_too_long");
  if (d.group.trim().length > 40) out.push("group_too_long");
  return out;
}

// ---- changing the items ----------------------------------------------------------------------------------------------

export const hasRoom = (items: readonly ListItem[]): boolean => items.length < MAX_LIST_ITEMS;

export const appendItem = (items: readonly ListItem[], item: ListItem): ListItem[] => [...items, item];

export const replaceItem = (items: readonly ListItem[], value: string, next: ListItem): ListItem[] => items.map((i) => (i.value === value ? next : i));

export const setItemArchived = (items: readonly ListItem[], value: string, archived: boolean): ListItem[] =>
  items.map((i) => {
    if (i.value !== value) return i;
    const { archived: _drop, ...rest } = i;
    void _drop;
    return archived ? { ...rest, archived: true } : rest;
  });

/** Move an item up or down (`by` -1 or 1), by its value, in the whole list. */
export function moveItemBy(items: readonly ListItem[], value: string, by: -1 | 1): ListItem[] {
  const i = items.findIndex((x) => x.value === value);
  const to = i + by;
  if (i < 0 || to < 0 || to >= items.length) return [...items];
  return moveItem(items, i, to) as ListItem[];
}

// ---- wording failures ------------------------------------------------------------------------------------------------

/** Codes a route (or the checks behind it) answers with, each worded under `Sign.lists.errors.<code>`. Any other reads as `generic`. */
export const LIST_ERROR_CODES = [
  "network",
  "signed_out",
  "forbidden",
  "rate_limited",
  "request_failed",
  "database_error",
  "body_too_large",
  "bad_json",
  "list_not_found",
  "bad_list",
  "bad_name",
  "bad_description",
  "bad_archived",
  "bad_items",
  "bad_item",
  "bad_label",
  "bad_group",
  "bad_value",
  "bad_msic_code",
  "empty_value",
  "empty_label",
  "label_too_long",
  "group_too_long",
  "duplicate_value",
  "too_many_items",
  "list_values_locked",
  "value_removed",
  "system_list_merge_only",
  "not_a_system_list",
  "bad_import",
  "import_failed",
] as const;

export function listErrorKey(code: string | null | undefined): string {
  return code && (LIST_ERROR_CODES as readonly string[]).includes(code) ? `errors.${code}` : "errors.generic";
}

/** What can be said about a row of an imported file (ImportProblem.code), worded under `Sign.lists.import.problems.<code>`. */
export const IMPORT_PROBLEM_CODES = [
  "empty_file",
  "missing_value_column",
  "missing_en_column",
  "no_rows",
  "too_many_rows",
  "empty_value",
  "code_padded",
  "bad_msic_code",
  "bad_value",
  "duplicate_value",
  "empty_label",
  "label_too_long",
  "group_too_long",
] as const;

export function importProblemKey(code: string): string {
  return (IMPORT_PROBLEM_CODES as readonly string[]).includes(code) ? `import.problems.${code}` : "import.problems.unknown";
}

/** Do the items of two lists differ (a screen's "you have unsaved changes")? */
export const itemsChanged = (a: readonly ListItem[], b: readonly ListItem[]): boolean => JSON.stringify(a) !== JSON.stringify(b);
