// ============================================================
// Doc Sign editor: reading and writing the template's default options (TemplateDefaults) from form controls.
// Pure. A blank control means "no default" and the key is left out, so the workspace's setting applies.
// ============================================================

import { cleanReminderDays } from "../defaults";
import type { TemplateDefaults } from "../types";

/** "3, 7 14" becomes [3, 7, 14]: whole days 1 to 60, ascending, at most five (the same rule the server applies). */
export function parseDaysList(text: string): number[] {
  const numbers = text
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  return cleanReminderDays(numbers);
}

export const formatDaysList = (days: readonly number[] | undefined): string => (days ?? []).join(", ");

/** The expiry typed in a number box: whole days 1 to 365, or undefined for none. */
export function parseExpiryDays(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= 1 && n <= 365 ? n : undefined;
}

type Patch = { [K in keyof TemplateDefaults]?: TemplateDefaults[K] | null };

/** Apply a change to the defaults: `undefined`, `null` and empty text remove a key instead of storing a blank. */
export function patchDefaults(current: TemplateDefaults, patch: Patch): TemplateDefaults {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const empty = value === undefined || value === null || (typeof value === "string" && value === "") || (Array.isArray(value) && value.length === 0);
    if (empty) delete next[key];
    else next[key] = value;
  }
  return next as TemplateDefaults;
}

/** Do two sets of defaults say the same thing (key order and blanks do not matter)? */
export function sameDefaults(a: TemplateDefaults, b: TemplateDefaults): boolean {
  return sortedJson(patchDefaults({}, a as Patch)) === sortedJson(patchDefaults({}, b as Patch));
}

function sortedJson(d: TemplateDefaults): string {
  return JSON.stringify(Object.fromEntries(Object.entries(d).sort(([x], [y]) => (x < y ? -1 : 1))));
}
