// ============================================================
// Doc Sign form builder, a form WITHOUT a signature (migration 169): the people who fill it in. A form-only template has
// roles that only fill in (never sign); the builder edits them here so a form several people complete (the owner, then their
// accounts person) needs no page editor. Pure: no React, no I/O.
// ============================================================

import type { FormDefinition } from "../forms/types";
import { MAX_ROLES, SENDER_ROLE } from "../rules";
import type { SignRole } from "../types";

/** The label used for the role a new template starts with, and for a new one with no name typed. */
export const DEFAULT_ROLE_LABEL = "Person";

/** A role key from a label: letters and digits only, starting with a letter, not taken, never the sender's own. */
export function roleKeyFor(label: string, taken: Iterable<string>): string {
  const used = new Set([...taken, SENDER_ROLE]);
  const base = (label.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "person").replace(/^[^a-z]+/, "r_").slice(0, 30);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const key = `${base}_${n}`;
    if (!used.has(key)) return key;
  }
  return `${base}_${Date.now() % 100000}`;
}

/** A role that only fills in, after the ones there are. The colour is the first of the six not in use (or the next in turn). */
export function addFillerRole(roles: readonly SignRole[], label: string): SignRole[] {
  if (roles.length >= MAX_ROLES) return [...roles];
  const name = label.trim().slice(0, 60) || DEFAULT_ROLE_LABEL;
  const usedColours = new Set(roles.map((r) => r.color));
  const color = [0, 1, 2, 3, 4, 5].find((c) => !usedColours.has(c)) ?? roles.length % 6;
  return [...roles, { key: roleKeyFor(name, roles.map((r) => r.key)), label: name, kind: "filler", color }];
}

export function renameRole(roles: readonly SignRole[], key: string, label: string): SignRole[] {
  return roles.map((r) => (r.key === key ? { ...r, label: label.slice(0, 60) } : r));
}

/** The parts that use a role: while there are some, the role stays. */
export const partsOfRole = (form: FormDefinition, key: string): number => form.parts.filter((p) => p.role === key).length;

/** Remove a role nothing uses; the last role is never removed (a form needs somebody to fill it in). */
export function removeRole(roles: readonly SignRole[], key: string, form: FormDefinition): SignRole[] {
  if (roles.length <= 1 || partsOfRole(form, key) > 0) return [...roles];
  return roles.filter((r) => r.key !== key);
}

/** A role with an empty label cannot be saved (the server refuses it); its name in the list, for a message about it. */
export const rolesNeedNames = (roles: readonly SignRole[]): boolean => roles.some((r) => r.label.trim().length === 0);
