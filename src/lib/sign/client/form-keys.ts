// ============================================================
// Doc Sign form builder: keys. A data field, a part and an option each have a short stable key that the
// server stores answers under. The sender never has to invent one: it is made from the English label
// ("Tax percentage" -> "tax_percentage"), kept unique, and always in the shape validateForm accepts.
// Pure: no React, no I/O.
// ============================================================

import type { FormDefinition } from "../forms/types";
import type { PlacedField } from "../pdf/types";

/** validate.ts KEY_RE: a data field key and a part key. */
export const DATA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** validate.ts OPTION_RE: the stored value of a choice option. */
export const OPTION_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,59}$/;

export const DATA_KEY_MAX = 40;
export const OPTION_VALUE_MAX = 60;

export const isDataKey = (s: string): boolean => DATA_KEY_RE.test(s);
export const isOptionValue = (s: string): boolean => OPTION_VALUE_RE.test(s);

/** Lower-case words joined by underscores, letters and digits only; accents are dropped ("Café 2" -> "cafe_2"). May be empty. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** `base` if free, else base_2, base_3 ... The result is never longer than `max`. */
export function uniqueKey(base: string, taken: ReadonlySet<string>, max = DATA_KEY_MAX): string {
  const root = base.slice(0, max);
  if (!taken.has(root)) return root;
  for (let n = 2; n < 10000; n++) {
    const suffix = `_${n}`;
    const candidate = `${root.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root.slice(0, max - 6)}_${taken.size + 1}`;
}

/** What a person typed as a key, made acceptable: letters, digits and underscores, starting with a letter. */
export function cleanDataKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, "").replace(/^[^A-Za-z]+/, "").slice(0, DATA_KEY_MAX);
}

/** A key for a data field or a part, made from its English label. An empty or non-Latin label gives `fallback`. */
export function keyFromLabel(label: string, taken: ReadonlySet<string>, fallback = "field"): string {
  let slug = slugify(label).slice(0, DATA_KEY_MAX);
  if (!slug) slug = fallback;
  if (!/^[a-z]/.test(slug)) slug = `f_${slug}`.slice(0, DATA_KEY_MAX);
  return uniqueKey(slug, taken);
}

/** The stored value of an option, made from its English label ("Sdn. Bhd." -> "sdn_bhd"). */
export function optionValueFromLabel(label: string, taken: ReadonlySet<string>, fallback = "option"): string {
  const slug = slugify(label).slice(0, OPTION_VALUE_MAX);
  return uniqueKey(slug || fallback, taken, OPTION_VALUE_MAX);
}

/** Every key a new data field must avoid: the form's data keys and the template's placement keys. */
export function takenDataKeys(form: FormDefinition, placements: readonly PlacedField[] = []): Set<string> {
  return new Set([...form.fields.map((f) => f.key), ...placements.map((p) => p.key)]);
}

export const takenPartKeys = (form: FormDefinition): Set<string> => new Set(form.parts.map((p) => p.key));
