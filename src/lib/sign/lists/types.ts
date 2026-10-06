// ============================================================
// Doc Sign option lists: the shapes. A list is a named, reusable set of choices (the states of Malaysia, the
// banks, the MSIC business codes) kept once in Settings > Doc Sign > Lists and used by any number of forms:
// a data field says `optionList: "states_my"` instead of carrying its own options.
//
// A form is FROZEN into a document when it is sent (the document keeps its own copy, see forms/lists.ts), so
// editing a list later never changes a document that is already out. The list is a source the builder copies
// from, not something a signer reads live.
//
// Plain data, no I/O: the browser (the Lists screen, the form builder) and the server share these.
// ============================================================

import type { L10n } from "../forms/types";

/** `options`: a short pick-list a person edits by hand. `msic`: the DOSM business activity codes (5-digit, searched by code or text). */
export const LIST_KINDS = ["options", "msic"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** A stable key: lower case, digits and underscores, starting with a letter (`states_my`). Never changes after it is created. */
export const LIST_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** The stored value of an item: the same shape a choice option has (validate.ts OPTION_RE). */
export const LIST_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,59}$/;
/** An MSIC code: five digits. */
export const MSIC_CODE_RE = /^\d{5}$/;

export const MAX_LIST_ITEMS = 5000;
/** The longest label an item may carry in any language (an MSIC description can run long). */
export const MAX_ITEM_LABEL = 300;
export const MAX_LIST_NAME = 120;
export const MAX_LIST_DESCRIPTION = 500;
/** Above this many items a signer's pick-list is a search box rather than a plain menu. */
export const SEARCH_THRESHOLD = 12;

export interface ListItem {
  /** Stored and compared; stable. Answers use it, so it never changes once a form has been sent. */
  value: string;
  label: L10n;
  /** A short heading the item sits under (for MSIC: the two-digit division). Display and export only. */
  group?: string;
  /** Hidden from new forms. A form already made keeps it. */
  archived?: boolean;
}

/** A row of `sign_option_lists`. */
export interface OptionListRow {
  id: string;
  account_id: string;
  key: string;
  name: string;
  description: string | null;
  kind: ListKind;
  items: ListItem[];
  /** The number of items (kept by the database, so a screen can list the lists without reading their items). */
  item_count?: number;
  /** Shipped with the product: its keys and values cannot be deleted, only relabelled and added to. */
  is_system: boolean;
  version: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

/** What the Lists screen and the form builder's picker need of a list without carrying all its items. */
export interface OptionListSummary {
  key: string;
  name: string;
  description: string | null;
  kind: ListKind;
  is_system: boolean;
  version: number;
  archived: boolean;
  itemCount: number;
  updated_at: string;
}

export const summaryOf = (r: Pick<OptionListRow, "key" | "name" | "description" | "kind" | "is_system" | "version" | "archived" | "items" | "updated_at">): OptionListSummary => ({
  key: r.key,
  name: r.name,
  description: r.description,
  kind: r.kind,
  is_system: r.is_system,
  version: r.version,
  archived: r.archived,
  itemCount: r.items.filter((i) => !i.archived).length,
  updated_at: r.updated_at,
});

/** The lists a resolver needs: by key, items only. */
export type ListCatalogue = ReadonlyMap<string, { key: string; kind: ListKind; items: readonly ListItem[] }>;

export const catalogueOf = (rows: readonly Pick<OptionListRow, "key" | "kind" | "items">[]): ListCatalogue => new Map(rows.map((r) => [r.key, { key: r.key, kind: r.kind, items: r.items }]));

// ---- the answers the routes give -------------------------------------------------------------------------------

/** GET /api/sign/lists */
export interface ListsResult {
  lists: OptionListSummary[];
}

/** A template that uses a list (its current version's form names it). */
export interface ListUse {
  id: string;
  name: string;
  status: "draft" | "active" | "archived";
}

/** GET /api/sign/lists/[key] */
export interface ListResult {
  list: OptionListRow;
  usedBy: ListUse[];
}

/**
 * One thing found in an imported file: the row (1 = first line after the header, 0 = the file as a whole), a stable code
 * the screen words, and whether the row was left out (`error`) or taken with a change (`warning`).
 */
export interface ImportProblem {
  row: number;
  code: string;
  level: "error" | "warning";
  detail?: string;
}

/** POST /api/sign/lists/[key]/import */
export interface ImportResult {
  /** `true` when nothing was written (a preview). */
  dryRun: boolean;
  added: number;
  updated: number;
  unchanged: number;
  /** Items a replacing import removed (never for a system list). */
  removed: number;
  /** What was found in the file. A row with an `error` is never applied. */
  problems: ImportProblem[];
  /** The list after the import (absent for a preview). */
  list?: OptionListRow;
}

/** A label in `lang`, or English. */
export const itemLabel = (item: Pick<ListItem, "value" | "label">, lang: keyof L10n = "en"): string => (item.label[lang] && String(item.label[lang]).trim()) || item.label.en || item.value;
