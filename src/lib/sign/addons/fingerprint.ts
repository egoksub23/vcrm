// ============================================================
// Telling an add-on's template that nobody edited from one that was edited (F-81). An update replaces the first kind in place and
// leaves the second alone. "Edited" means its content is not what any shipped version contained: the placed fields, the roles, the
// form and the defaults. Pure.
//
// The comparison is on a canonical form, because the database stores JSON with its own key order and a form that names a shared list
// is stored with the list's items copied in:
//   * keys are sorted and undefined members dropped;
//   * a field that names a list is compared without its copied-in `options` (an admin relabelling a bank in Settings is not editing the
//     template);
//   * the defaults are compared as the service stores them (`cleanDefaults`).
// Not part of it: the template's name, description, tags, category and status (a workspace renames and activates freely, and an
// update does not look for the template by anything but its name), and the file (checked by its fingerprint where it matters).
// ============================================================

import { createHash } from "node:crypto";

import type { FormDefinition } from "../forms/types";
import { stripListOptions } from "../forms/lists";
import type { PlacedField } from "../pdf/types";
import { cleanDefaults } from "../service/templates";
import type { SignRole, TemplateDefaults } from "../types";

export interface TemplateContent {
  roles: readonly SignRole[];
  fields: readonly PlacedField[];
  defaults: TemplateDefaults;
  form?: FormDefinition | null;
}

/** JSON with sorted keys and without undefined members: equal content gives the same text whatever order it was built in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The fingerprint of a template's content (see the header for what counts). */
export function contentFingerprint(c: TemplateContent): string {
  const body = {
    roles: c.roles,
    fields: c.fields,
    defaults: cleanDefaults(c.defaults),
    form: c.form ? stripListOptions(c.form) : null,
  };
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/** Does the content equal any of the given shapes? */
export function equalsAny(content: TemplateContent, shapes: readonly TemplateContent[]): boolean {
  const mine = contentFingerprint(content);
  return shapes.some((s) => contentFingerprint(s) === mine);
}
