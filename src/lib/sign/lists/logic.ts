// ============================================================
// Option lists: the rules and the small pure helpers the server, the Lists screen and the signer's search all use.
// ============================================================

import type { Issue } from "../rules";
import type { L10n } from "../forms/types";
import { LIST_KEY_RE, LIST_VALUE_RE, MAX_ITEM_LABEL, MAX_LIST_DESCRIPTION, MAX_LIST_ITEMS, MAX_LIST_NAME, MSIC_CODE_RE, type ListItem, type ListKind } from "./types";

const LANGS = ["en", "ms", "zh", "ko"] as const;

/** A list key from a name ("Our suppliers" -> "our_suppliers"), made unique among `taken`. Never empty. */
export function listKeyFromName(name: string, taken: ReadonlySet<string>): string {
  let slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  if (!slug) slug = "list";
  if (!/^[a-z]/.test(slug)) slug = `l_${slug}`;
  let key = slug;
  for (let n = 2; taken.has(key) && n < 10_000; n++) key = `${slug.slice(0, 36)}_${n}`;
  return key;
}

const cleanText = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null);

/** Is `name` / `description` acceptable? Codes: bad_name, bad_description. */
export function metaProblems(meta: { name?: unknown; description?: unknown }): Issue[] {
  const issues: Issue[] = [];
  if (meta.name !== undefined && cleanText(meta.name, MAX_LIST_NAME) === null) issues.push({ code: "bad_name" });
  if (meta.description !== undefined && meta.description !== null && (typeof meta.description !== "string" || meta.description.length > MAX_LIST_DESCRIPTION)) issues.push({ code: "bad_description" });
  return issues;
}

/**
 * Problems with a list's items as a whole. Codes: too_many_items, bad_item, bad_value, bad_msic_code, duplicate_value,
 * bad_label, label_too_long, bad_group. `field` carries the value (or the row number when there is none).
 */
export function itemProblems(items: unknown, kind: ListKind): Issue[] {
  if (!Array.isArray(items)) return [{ code: "bad_items" }];
  if (items.length > MAX_LIST_ITEMS) return [{ code: "too_many_items", detail: String(MAX_LIST_ITEMS) }];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  items.forEach((raw, n) => {
    const at = { field: typeof raw?.value === "string" ? raw.value : String(n + 1) };
    if (typeof raw !== "object" || raw === null || typeof raw.value !== "string" || typeof raw.label !== "object" || raw.label === null) {
      issues.push({ code: "bad_item", ...at });
      return;
    }
    const item = raw as ListItem;
    if (kind === "msic" ? !MSIC_CODE_RE.test(item.value) : !LIST_VALUE_RE.test(item.value)) issues.push({ code: kind === "msic" ? "bad_msic_code" : "bad_value", ...at });
    if (seen.has(item.value)) issues.push({ code: "duplicate_value", ...at });
    seen.add(item.value);
    const label = item.label as Record<string, unknown>;
    if (typeof label.en !== "string" || label.en.trim() === "") issues.push({ code: "bad_label", ...at });
    for (const [lang, text] of Object.entries(label)) {
      if (!(LANGS as readonly string[]).includes(lang) || typeof text !== "string") issues.push({ code: "bad_label", ...at });
      else if (text.length > MAX_ITEM_LABEL) issues.push({ code: "label_too_long", ...at });
    }
    if (item.group !== undefined && (typeof item.group !== "string" || item.group.length > 40)) issues.push({ code: "bad_group", ...at });
    if (item.archived !== undefined && typeof item.archived !== "boolean") issues.push({ code: "bad_item", ...at });
  });
  return issues;
}

/** A tidy copy of the items: only the known properties, labels trimmed, empty languages and flags dropped. */
export function cleanItems(items: readonly ListItem[]): ListItem[] {
  return items.map((i) => {
    const label: L10n = { en: i.label.en.trim() };
    for (const lang of ["ms", "zh", "ko"] as const) {
      const t = i.label[lang]?.trim();
      if (t) label[lang] = t;
    }
    const out: ListItem = { value: i.value, label };
    if (i.group?.trim()) out.group = i.group.trim();
    if (i.archived) out.archived = true;
    return out;
  });
}

/** The values that were in `before` and are not in `after`. */
export function removedValues(before: readonly ListItem[], after: readonly ListItem[]): string[] {
  const keep = new Set(after.map((i) => i.value));
  return before.filter((i) => !keep.has(i.value)).map((i) => i.value);
}

/** Does the list's content differ (items, in order, with labels)? */
export const sameItems = (a: readonly ListItem[], b: readonly ListItem[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * "Reset to default" for a system list: every item the product ships is back as shipped (its labels and its place), and the
 * items the workspace added are kept after them untouched. A system list's values never go, so nothing is lost.
 */
export function resetToDefault(current: readonly ListItem[], defaults: readonly ListItem[]): ListItem[] {
  const shipped = new Set(defaults.map((i) => i.value));
  return [...defaults.map((i) => ({ ...i, label: { ...i.label } })), ...current.filter((i) => !shipped.has(i.value))];
}

// ---- searching ---------------------------------------------------------------------------------------------------

/** Lower case, accents removed, white space collapsed: how a search term and an item are compared. */
export const normalizeSearch = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * The items that match a search, best first. Every word of the search must appear in the item's value, the group or a label in
 * any language (a signer may type the code, an English word or a word of their own language). A code that starts with the
 * search ranks first, then a label that starts with it, then the rest in the list's own order.
 */
export function searchItems<T extends Pick<ListItem, "value" | "label"> & { group?: string }>(items: readonly T[], query: string, lang: keyof L10n = "en", limit = 50): T[] {
  const q = normalizeSearch(query);
  if (q === "") return items.slice(0, limit);
  const words = q.split(" ");
  const scored: { item: T; rank: number; at: number }[] = [];
  items.forEach((item, at) => {
    const own = normalizeSearch(item.label[lang] || item.label.en || "");
    const haystack = [item.value, item.group ?? "", ...Object.values(item.label)].map(normalizeSearch).join(" ");
    if (!words.every((w) => haystack.includes(w))) return;
    const rank = normalizeSearch(item.value).startsWith(q) ? 0 : own.startsWith(q) ? 1 : own.includes(q) ? 2 : 3;
    scored.push({ item, rank, at });
  });
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return scored.slice(0, limit).map((s) => s.item);
}

export const isListKey = (s: unknown): s is string => typeof s === "string" && LIST_KEY_RE.test(s);
