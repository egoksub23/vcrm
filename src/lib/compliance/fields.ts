// ============================================================
// Compliance requests: the field definitions of a request type, and the check of what a form (or a member of staff) submits against them.
// Pure (no I/O, no Node imports): the settings screen, the staff form, the server and Part B's public form share it.
//
// The answers come out in two bags: `data` (ordinary answers, stored as JSON) and `sensitive` (the fields the type marks sensitive: the server
// encrypts them with the key ring and stores only ciphertext; see secrets.ts). A `file` field has no value here: files are uploaded one at a time
// through their own route (and recorded against the field's key).
// ============================================================

import { normalisePhone } from "./reference";
import { FIELD_TYPES, SENSITIVE_FIELD_TYPES, type ChecklistTemplateItem, type FieldDef, type FieldType, type L10n } from "./types";

export const MAX_FIELDS = 40;
export const MAX_CHECKLIST_STEPS = 20;
export const MAX_TEXT = 300;
export const MAX_MULTILINE = 2000;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Locale = "en" | "ms" | "zh" | "ko";
const LOCALES: readonly Locale[] = ["en", "ms", "zh", "ko"];

/** The text of a localized label in the locale, else English, else the key. */
export function l10n(label: L10n | undefined | null, locale: string, fallback = ""): string {
  if (!label) return fallback;
  const v = (label as Record<string, string | undefined>)[locale];
  return (typeof v === "string" && v.trim() !== "" ? v : label.en) || fallback;
}

/** A label object cleaned: only the four languages, trimmed text, English required. Null when English is missing. */
export function cleanL10n(v: unknown, max = 200): L10n | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const l of LOCALES) {
    const t = typeof src[l] === "string" ? (src[l] as string).trim() : "";
    if (t !== "") out[l] = t.slice(0, max);
  }
  return typeof out.en === "string" && out.en !== "" ? (out as L10n) : null;
}

export interface DefinitionIssue {
  code: "bad_fields" | "too_many_fields" | "bad_key" | "duplicate_key" | "bad_type" | "bad_label" | "bad_sensitive" | "bad_options" | "bad_checklist" | "too_many_steps" | "bad_show_if";
  field?: string;
}

function cleanShowIf(v: unknown): FieldDef["showIf"] | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const field = typeof o.field === "string" ? o.field : "";
  const values = Array.isArray(o.in) ? o.in.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80).slice(0, 40) : [];
  return KEY_RE.test(field) && values.length > 0 ? { field, in: values } : null;
}

/** Validate and clean a type's field definitions. */
export function validateFieldDefs(input: unknown): { ok: true; fields: FieldDef[] } | { ok: false; issues: DefinitionIssue[] } {
  if (!Array.isArray(input)) return { ok: false, issues: [{ code: "bad_fields" }] };
  if (input.length > MAX_FIELDS) return { ok: false, issues: [{ code: "too_many_fields" }] };
  const issues: DefinitionIssue[] = [];
  const seen = new Set<string>();
  const fields: FieldDef[] = [];
  for (const raw of input) {
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const key = typeof f.key === "string" ? f.key : "";
    if (!KEY_RE.test(key)) {
      issues.push({ code: "bad_key", field: key });
      continue;
    }
    if (seen.has(key)) issues.push({ code: "duplicate_key", field: key });
    seen.add(key);
    const type = f.type as FieldType;
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      issues.push({ code: "bad_type", field: key });
      continue;
    }
    const label = cleanL10n(f.label);
    if (!label) {
      issues.push({ code: "bad_label", field: key });
      continue;
    }
    const sensitive = f.sensitive === true;
    if (f.sensitive !== undefined && typeof f.sensitive !== "boolean") issues.push({ code: "bad_sensitive", field: key });
    if (sensitive && !SENSITIVE_FIELD_TYPES.includes(type)) issues.push({ code: "bad_sensitive", field: key });
    const def: FieldDef = { key, type, label, required: f.required === true, sensitive };
    const help = f.help === undefined ? null : cleanL10n(f.help, 400);
    if (help) def.help = help;
    const showIf = cleanShowIf(f.showIf);
    if (f.showIf !== undefined && !showIf) issues.push({ code: "bad_show_if", field: key });
    if (showIf) def.showIf = showIf;
    if (type === "choice") {
      const opts = Array.isArray(f.options) ? f.options : [];
      const options: { value: string; label: L10n }[] = [];
      for (const o of opts.slice(0, 40)) {
        const oo = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
        const value = typeof oo.value === "string" ? oo.value.trim().slice(0, 80) : "";
        const ol = cleanL10n(oo.label, 120);
        if (value && ol) options.push({ value, label: ol });
      }
      if (options.length === 0) issues.push({ code: "bad_options", field: key });
      def.options = options;
    }
    fields.push(def);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, fields };
}

/** Validate and clean a type's checklist template. */
export function validateChecklist(input: unknown): { ok: true; items: ChecklistTemplateItem[] } | { ok: false; issues: DefinitionIssue[] } {
  if (!Array.isArray(input)) return { ok: false, issues: [{ code: "bad_checklist" }] };
  if (input.length > MAX_CHECKLIST_STEPS) return { ok: false, issues: [{ code: "too_many_steps" }] };
  const issues: DefinitionIssue[] = [];
  const seen = new Set<string>();
  const items: ChecklistTemplateItem[] = [];
  for (const raw of input) {
    const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const key = typeof it.key === "string" ? it.key : "";
    const label = cleanL10n(it.label, 300);
    if (!KEY_RE.test(key) || !label) {
      issues.push({ code: "bad_checklist", field: key });
      continue;
    }
    if (seen.has(key)) issues.push({ code: "duplicate_key", field: key });
    seen.add(key);
    items.push({ key, label });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, items };
}

/** A key for a new checklist step from its English words (letters, digits, underscore), unique among `taken`. */
export function stepKeyFrom(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9_]+/, "").slice(0, 30) || "step";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base.slice(0, 36)}_${n++}`;
  return key;
}

// ---- answers ---------------------------------------------------------------------------------------------------

export interface AnswerIssue {
  field: string;
  code: "required" | "invalid" | "too_long" | "not_a_choice" | "must_acknowledge";
}

export interface CheckedAnswers {
  /** Ordinary answers, cleaned (a phone in +60 form, a number as a number, a tick as true). */
  data: Record<string, string | number | boolean>;
  /** The sensitive answers, as text (to be encrypted). */
  sensitive: Record<string, string>;
}

/**
 * Is this field asked, given the answers so far? A field with no `showIf` always is. One with it is asked while the answer to the field it names is one
 * of the listed values (an unanswered or unknown controlling field hides it; a yes / no answer is compared as "true" or "false"). Used by the check below, by the forms and by the case's detail.
 */
export function isShown(field: FieldDef, _fields: readonly FieldDef[], answers: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const v = answers[field.showIf.field];
  // a yes / no answer is stored as true or false and listed as "true" or "false" (migration 186: the authorization letter is asked while the bank account is not the customer's own)
  if (typeof v === "boolean") return field.showIf.in.includes(String(v));
  return typeof v === "string" && field.showIf.in.includes(v.trim());
}

/** The fields to ask for the answers so far (the order of the type). */
export const visibleFields = (fields: readonly FieldDef[], answers: Record<string, unknown>): FieldDef[] => fields.filter((f) => isShown(f, fields, answers));

const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Check `input` against the type's fields. `partial` skips the "required" check (an edit that sends only some fields); everything sent is still checked.
 * Unknown keys are dropped. File fields are skipped (uploaded through their own route).
 */
export function checkAnswers(fields: readonly FieldDef[], input: Record<string, unknown>, opts: { partial?: boolean; context?: Record<string, unknown> } = {}): { ok: true; answers: CheckedAnswers } | { ok: false; issues: AnswerIssue[] } {
  const issues: AnswerIssue[] = [];
  const out: CheckedAnswers = { data: {}, sensitive: {} };
  // an edit sends only some fields: the answers already stored decide what is shown for the rest
  const seen = { ...(opts.context ?? {}), ...input };
  for (const f of fields) {
    if (f.type === "file") continue;
    if (!isShown(f, fields, seen)) continue;
    const raw = input[f.key];
    if (raw === undefined && opts.partial) continue;
    if (f.type === "acknowledge") {
      const on = raw === true || raw === "true";
      if (f.required && !on && !opts.partial) issues.push({ field: f.key, code: "must_acknowledge" });
      else if (f.required && raw !== undefined && !on) issues.push({ field: f.key, code: "must_acknowledge" });
      out.data[f.key] = on;
      continue;
    }
    if (isBlank(raw)) {
      if (f.required) issues.push({ field: f.key, code: "required" });
      continue;
    }
    let value: string | number | boolean;
    switch (f.type) {
      case "yesno":
        if (raw !== true && raw !== false && raw !== "true" && raw !== "false") {
          issues.push({ field: f.key, code: "invalid" });
          continue;
        }
        value = raw === true || raw === "true";
        break;
      case "number": {
        if (f.sensitive) {
          // a sensitive number is an identifier typed as digits (an account number): kept exactly as typed, spaces and dashes allowed
          const digits = String(raw).trim();
          if (!/^\d[\d\s-]{0,39}$/.test(digits)) {
            issues.push({ field: f.key, code: "invalid" });
            continue;
          }
          value = digits;
          break;
        }
        const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
        if (!Number.isFinite(n) || n < 0 || n > 1e12) {
          issues.push({ field: f.key, code: "invalid" });
          continue;
        }
        value = Math.round(n * 100) / 100;
        break;
      }
      case "phone": {
        const p = normalisePhone(String(raw));
        if (!p) {
          issues.push({ field: f.key, code: "invalid" });
          continue;
        }
        value = p;
        break;
      }
      case "email": {
        const e = String(raw).trim();
        if (!EMAIL_RE.test(e) || e.length > 320) {
          issues.push({ field: f.key, code: "invalid" });
          continue;
        }
        value = e;
        break;
      }
      case "date": {
        const d = String(raw).trim();
        const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN;
        if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d) {
          issues.push({ field: f.key, code: "invalid" });
          continue;
        }
        value = d;
        break;
      }
      case "choice": {
        const c = String(raw).trim();
        if (!f.options?.some((o) => o.value === c)) {
          issues.push({ field: f.key, code: "not_a_choice" });
          continue;
        }
        value = c;
        break;
      }
      default: {
        // text, multiline
        if (typeof raw !== "string" && typeof raw !== "number") {
          issues.push({ field: f.key, code: "invalid" });
          continue;
        }
        const t = String(raw).trim();
        if (t.length > (f.type === "multiline" ? MAX_MULTILINE : MAX_TEXT)) {
          issues.push({ field: f.key, code: "too_long" });
          continue;
        }
        value = t;
      }
    }
    if (f.sensitive) out.sensitive[f.key] = String(value);
    else out.data[f.key] = value;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, answers: out };
}

/** The file fields of a type (the documents it expects), for the Files panel. */
export const fileFieldsOf = (fields: readonly FieldDef[]): FieldDef[] => fields.filter((f) => f.type === "file");

/**
 * The documents a case is expected to have: the file fields that are asked for its answers. A file field that depends on an answer (migration 186: the
 * authorization letter, asked while the bank account is not the customer's own) is left out once the answer says it is not asked, and stays listed while
 * the question was never answered (a case from before the question existed).
 */
export const expectedFileFields = (fields: readonly FieldDef[], answers: Record<string, unknown>): FieldDef[] =>
  fileFieldsOf(fields).filter((f) => !f.showIf || isShown(f, fields, answers) || isBlank(answers[f.showIf.field]));
