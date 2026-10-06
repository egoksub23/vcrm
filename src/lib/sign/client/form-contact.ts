// ============================================================
// Doc Sign form builder: the contact fields an answer can fill. The built-in ones are name, email and company; a
// workspace's own contact fields (the `custom_fields` table) are mapped as `custom:<field_name>`. validate.ts
// accepts a custom name of letters, digits, spaces, "_", "." and "-" (1 to 60); a workspace field with another
// character in its name cannot be mapped and is left out of the list.
// Pure: no React, no I/O.
// ============================================================

import { CONTACT_FIELDS } from "../forms/types";

export const CUSTOM_CONTACT_RE = /^custom:[\p{L}\p{N} _.\-]{1,60}$/u;

/** The value stored for a workspace contact field, or null when its name cannot be mapped. */
export function customContactValue(fieldName: string): string | null {
  const v = `custom:${fieldName}`;
  return CUSTOM_CONTACT_RE.test(v) ? v : null;
}

export interface ContactChoice {
  /** What is stored in `contactField`. */
  value: string;
  kind: "base" | "custom" | "unknown";
  /** The built-in name's key, or the workspace field's name. */
  name: string;
}

/**
 * Everything a data field may fill: the built-in fields, then the workspace's own (sorted by name). A value already set that is in neither
 * list (a custom field since deleted) is kept as "unknown" so it is shown, and never silently dropped.
 */
export function contactChoices(customNames: readonly string[], current?: string): ContactChoice[] {
  const out: ContactChoice[] = CONTACT_FIELDS.map((name) => ({ value: name, kind: "base", name }));
  const seen = new Set<string>();
  for (const name of [...customNames].sort((a, b) => a.localeCompare(b))) {
    const value = customContactValue(name);
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push({ value, kind: "custom", name });
    }
  }
  if (current && !out.some((c) => c.value === current)) out.push({ value: current, kind: "unknown", name: current.replace(/^custom:/, "") });
  return out;
}
