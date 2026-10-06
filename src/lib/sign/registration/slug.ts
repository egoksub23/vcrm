// ============================================================
// The slug of a registration page (/r/<slug>): a public identifier, 6 to 40 characters of a-z, 0-9 and
// hyphens. It is made from the form's name plus a random suffix, so a page cannot be found by counting or
// guessing, and it never contains the workspace id. "Regenerate" keeps the readable start and draws a new
// suffix, which retires the old address at once.
// ============================================================

import { randomInt } from "node:crypto";

import { slugBase } from "./slug-base";

export { slugBase };

/** The same pattern as the database constraint on sign_registration_forms.slug (migration 164). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{4,38}[a-z0-9]$/;

/** No 0, o, 1, l or i: a person may have to read an address aloud. 31 symbols, 8 of them are about 39 bits. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const SUFFIX_LENGTH = 8;
const SUFFIX_RE = /^[a-z0-9]{8}$/;

export const isValidSlug = (value: unknown): value is string => typeof value === "string" && SLUG_RE.test(value);

/** A request's slug in the form the database stores it, or null when it cannot be one. */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

export function randomSuffix(): string {
  let out = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** A new slug for a form called `name`. */
export function makeSlug(name: string): string {
  return `${slugBase(name)}-${randomSuffix()}`;
}

/** A fresh slug that keeps the readable start of the one it replaces. */
export function regenerateSlug(current: string): string {
  const at = current.lastIndexOf("-");
  const keep = at > 0 && SUFFIX_RE.test(current.slice(at + 1)) ? current.slice(0, at) : current;
  return `${slugBase(keep)}-${randomSuffix()}`;
}
