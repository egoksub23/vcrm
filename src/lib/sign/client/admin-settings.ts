// ============================================================
// Doc Sign settings, browser side: small pure helpers the Settings screens share (and the tests cover).
// No I/O, and nothing here imports a Node module, so it is safe in a client component.
// ============================================================

import { cleanReminderDays } from "../defaults";

/** The name Halo gives the certificate it makes for a workspace (service/certificates.ts). */
export const SELF_SIGNED_NAME_PREFIX = "Halo self-signed";

// ---- category keys ---------------------------------------------------------------------------------

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
export const isCategoryKey = (k: string): boolean => KEY_RE.test(k);

/**
 * The key of a new category, made from its name: lower case, letters and digits, words joined by `_`.
 * It is unique among `taken` (every key the workspace has, archived ones too) and never changes afterwards.
 * A name with no Latin letters or digits (a Chinese name, say) gets "category".
 */
export function keyFromName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = base ? `c_${base}` : "category";
  base = base.slice(0, 36).replace(/_+$/, "");
  if (base.length < 2) base = "category";
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}_${Date.now() % 100000}`;
}

// ---- days -------------------------------------------------------------------------------------------

export type DaysProblem = "not_a_number" | "out_of_range" | "too_many";

/**
 * Reminder days typed as "3, 7": whole days from 1 to 60, at most five. An empty text is an empty list.
 * Returns the cleaned list (ascending, no duplicates), or the problem.
 */
export function parseReminderDays(text: string): { days: number[] } | { problem: DaysProblem } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return { problem: "not_a_number" };
    nums.push(Number(p));
  }
  if (nums.some((n) => n < 1 || n > 60)) return { problem: "out_of_range" };
  const days = cleanReminderDays(nums);
  if (new Set(nums).size > 5) return { problem: "too_many" };
  return { days };
}

export const formatReminderDays = (days: readonly number[] | null | undefined): string => (days ?? []).join(", ");

/** A whole number from `min` to `max`, or null for a blank or invalid text. */
export function parseWholeNumber(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

// ---- the sealing certificate -----------------------------------------------------------------------

export type CertificateState = "valid" | "expiring" | "expired" | "unknown";

/** The screen warns this many days before the certificate ends (docs/vircle-sign-ux.html, A1). */
export const CERTIFICATE_WARN_DAYS = 60;

export function certificateState(validUntil: string | null | undefined, now: Date): { state: CertificateState; daysLeft: number | null } {
  if (!validUntil) return { state: "unknown", daysLeft: null };
  const end = new Date(validUntil).getTime();
  if (Number.isNaN(end)) return { state: "unknown", daysLeft: null };
  const daysLeft = Math.floor((end - now.getTime()) / 86_400_000);
  if (end <= now.getTime()) return { state: "expired", daysLeft };
  return { state: daysLeft <= CERTIFICATE_WARN_DAYS ? "expiring" : "valid", daysLeft };
}

// ---- consent wording -------------------------------------------------------------------------------

export const CONSENT_MAX_CHARS = 2000;

/**
 * The `consent_texts` object to store after the person changed one language: a blank text removes that
 * language's own wording (the default applies again); other languages are kept as they are.
 */
export function withConsentText(current: Record<string, string> | null | undefined, locale: string, text: string): Record<string, string> {
  const next: Record<string, string> = { ...(current ?? {}) };
  const t = text.trim();
  if (t) next[locale] = t.slice(0, CONSENT_MAX_CHARS);
  else delete next[locale];
  return next;
}

// ---- the category form -----------------------------------------------------------------------------

export interface CategoryFormInput {
  name: string;
  description: string;
  /** Blank means "use the workspace setting". */
  expiry: string;
  reminders: string;
  codeRequired: boolean;
  signInOrder: boolean;
  retention: string;
  /** Per language; a blank text means "no own wording for this language". */
  consent: Record<string, string>;
}

export type CategoryFormField = "name" | "description" | "expiry" | "reminders" | "retention";

/** What is stored for a category (the columns of `sign_categories` the form sets). */
export interface CategoryValues {
  name: string;
  description: string | null;
  expiry_days: number | null;
  reminder_days: number[] | null;
  code_required: boolean;
  sign_in_order: boolean;
  retention_years: number | null;
  consent_text: Record<string, string> | null;
}

/** The form turned into the values to store, or the problem with each field that is wrong (a code the screen words). */
export function parseCategoryForm(input: CategoryFormInput): { ok: true; values: CategoryValues } | { ok: false; errors: Partial<Record<CategoryFormField, string>> } {
  const errors: Partial<Record<CategoryFormField, string>> = {};
  const name = input.name.trim();
  if (name.length < 1) errors.name = "name_required";
  else if (name.length > 80) errors.name = "name_too_long";
  const description = input.description.trim();
  if (description.length > 500) errors.description = "description_too_long";

  let expiry: number | null = null;
  if (input.expiry.trim() !== "") {
    expiry = parseWholeNumber(input.expiry, 1, 365);
    if (expiry === null) errors.expiry = "expiry_invalid";
  }
  let reminders: number[] | null = null;
  if (input.reminders.trim() !== "") {
    const parsed = parseReminderDays(input.reminders);
    if ("problem" in parsed) errors.reminders = `reminders_${parsed.problem}`;
    else reminders = parsed.days;
  }
  let retention: number | null = null;
  if (input.retention.trim() !== "") {
    retention = parseWholeNumber(input.retention, 1, 50);
    if (retention === null) errors.retention = "retention_invalid";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  let consent: Record<string, string> = {};
  for (const [locale, text] of Object.entries(input.consent)) consent = withConsentText(consent, locale, text);
  return {
    ok: true,
    values: {
      name,
      description: description || null,
      expiry_days: expiry,
      reminder_days: reminders,
      code_required: input.codeRequired,
      sign_in_order: input.signInOrder,
      retention_years: retention,
      consent_text: Object.keys(consent).length > 0 ? consent : null,
    },
  };
}

// ---- order -----------------------------------------------------------------------------------------

/**
 * Move one category up (-1) or down (1) in the list shown. Positions are renumbered 1..n in the new order
 * (rows can share a position, for example when a few were created together), and only the rows whose position
 * changed are returned.
 */
export function reorderPositions(inOrder: readonly { id: string; position: number }[], id: string, dir: -1 | 1): { id: string; position: number }[] {
  const from = inOrder.findIndex((r) => r.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= inOrder.length) return [];
  const next = inOrder.map((r) => r.id);
  [next[from], next[to]] = [next[to], next[from]];
  const before = new Map(inOrder.map((r) => [r.id, r.position]));
  return next.map((rid, i) => ({ id: rid, position: i + 1 })).filter((r) => before.get(r.id) !== r.position);
}

/** A row of `sign_categories` as the browser reads it. */
export interface SignCategoryRow {
  id: string;
  account_id: string;
  key: string;
  name: string;
  description: string | null;
  expiry_days: number | null;
  reminder_days: number[] | null;
  code_required: boolean;
  sign_in_order: boolean;
  consent_text: Record<string, string> | null;
  retention_years: number | null;
  /** Set when an add-on created or adopted the category. */
  addon_key: string | null;
  position: number;
  archived: boolean;
}

/** Categories in the order shown: by position, then name. */
export function sortCategories<T extends { position: number; name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}
