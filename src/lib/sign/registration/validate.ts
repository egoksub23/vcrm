// ============================================================
// Registration forms: checking what comes in. Two inputs, both untrusted:
//
//   parseSubmission   what a stranger posts from the public page. Strict: strings only, trimmed, length caps,
//                     no markup, an email that could be one, a phone number the existing normaliser accepts
//                     (digits with a country code), consent exactly true. It says which detail is wrong and
//                     why with a stable code; the page words the code in the person's language.
//   parseFormInput    what an admin posts to create or change a form. It checks shape and size only; whether
//                     the template and the roles make a form that can send is `formReadiness`.
//
// Pure: no I/O.
// ============================================================

import { normalizeEmail, normalizeIdentityPhone } from "@/lib/widget/identity-token";

import { checkCopyList, type CopyInput } from "../copy-list";
import { KEY_PATTERN, normalizePhone, type Issue } from "../rules";
import { SIGN_LOCALES, type SignLocale } from "../types";
import { ASK_LEVELS, DEFAULT_ASKED, MAX_DAILY_CAP, REGISTRATION_DETAILS, REGISTRATION_MODES, type AskedFields, type AskLevel, type OtherSigner, type RegistrationDetail, type RegistrationMode, type Wording } from "./types";

export const NAME_MAX = 120;
export const COMPANY_MAX = 160;
export const CONSENT_MAX = 2000;
export const SUCCESS_MAX = 1000;
export const FORM_NAME_MAX = 120;
export const MAX_OTHER_SIGNERS = 10;
export const TURNSTILE_TOKEN_MAX = 2100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNER_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// control characters (including newlines and tabs inside a single-line value)
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

// ---- the public submission -----------------------------------------------------------------------------

/** Why a detail was refused. The page has a sentence for each, per detail. */
export type DetailProblem = "required" | "too_long" | "invalid";

export interface Submission {
  fullName: string | null;
  /** Lower case. */
  email: string;
  /** Digits only, as the contacts store a number; null when not asked or left empty. */
  phone: string | null;
  company: string | null;
  locale: SignLocale | null;
  token: string;
  captcha: string | null;
  /** Whatever was in the hidden field: anything at all means a script filled it. */
  honeypot: string;
}

export type SubmissionCheck =
  | { ok: true; value: Submission }
  | { ok: false; problems: Partial<Record<RegistrationDetail | "consent", DetailProblem>> };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A single line of text: control characters removed, runs of spaces made one, trimmed. */
export function cleanLine(v: unknown): string {
  return str(v).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
}

const hasMarkup = (s: string): boolean => /[<>]/.test(s);

function text(raw: unknown, level: AskLevel, max: number): { value: string | null; problem?: DetailProblem } {
  if (level === "off") return { value: null };
  const s = cleanLine(raw);
  if (!s) return level === "required" ? { value: null, problem: "required" } : { value: null };
  if (s.length > max) return { value: null, problem: "too_long" };
  if (hasMarkup(s)) return { value: null, problem: "invalid" };
  return { value: s };
}

/** The honeypot is "filled" by anything but an absent or empty value. */
const honeypotOf = (v: unknown): string => (v === undefined || v === null || v === "" ? "" : typeof v === "string" ? v.trim() : "filled");

export function parseSubmission(body: unknown, asked: AskedFields): SubmissionCheck {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const problems: Partial<Record<RegistrationDetail | "consent", DetailProblem>> = {};

  const name = text(b.fullName, asked.full_name, NAME_MAX);
  if (name.problem) problems.full_name = name.problem;
  const company = text(b.company, asked.company, COMPANY_MAX);
  if (company.problem) problems.company = company.problem;

  // the email is always asked: it is where the document goes
  const rawEmail = cleanLine(b.email);
  let email = "";
  if (!rawEmail) problems.email = "required";
  else {
    const e = normalizeEmail(rawEmail);
    if (!e || hasMarkup(e) || !SIGNER_EMAIL_RE.test(e)) problems.email = rawEmail.length > 254 ? "too_long" : "invalid";
    else email = e;
  }

  let phone: string | null = null;
  if (asked.phone !== "off") {
    const rawPhone = cleanLine(b.phone);
    if (!rawPhone) {
      if (asked.phone === "required") problems.phone = "required";
    } else if (rawPhone.length > 32) problems.phone = "too_long";
    else {
      const p = normalizeIdentityPhone(rawPhone);
      if (p) phone = p;
      else problems.phone = "invalid";
    }
  }

  if (b.consent !== true) problems.consent = "required";
  if (Object.keys(problems).length > 0) return { ok: false, problems };

  const captcha = str(b.captcha).trim();
  return {
    ok: true,
    value: {
      fullName: name.value,
      email,
      phone,
      company: company.value,
      locale: (SIGN_LOCALES as readonly string[]).includes(str(b.locale)) ? (b.locale as SignLocale) : null,
      token: str(b.token).slice(0, 300),
      captcha: captcha ? captcha.slice(0, TURNSTILE_TOKEN_MAX) : null,
      honeypot: honeypotOf(b.website_url),
    },
  };
}

/** The honeypot and the token of a body, before the details are looked at (a script is judged first). */
export function peekTrap(body: unknown): { honeypot: string; token: string } {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  return { honeypot: honeypotOf(b.website_url), token: str(b.token).slice(0, 300) };
}

// ---- an admin's form -----------------------------------------------------------------------------------

export interface FormInput {
  name?: string;
  active?: boolean;
  sendDocument?: boolean;
  /** `sign` or `form`: what the form sends. Left out, it follows the chosen template's mode. */
  mode?: RegistrationMode;
  templateId?: string | null;
  applicantRoleKey?: string | null;
  signersOther?: OtherSigner[];
  /** People who receive the signed copy of every document the form sends (migration 176). */
  copyRecipients?: CopyInput[];
  contactTagId?: string | null;
  fields?: AskedFields;
  consentText?: Wording;
  successMessage?: Wording;
  defaultLocale?: SignLocale;
  dailyCap?: number;
}

export type FormInputCheck = { ok: true; value: FormInput } | { ok: false; issues: Issue[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function wording(raw: unknown, field: string, max: number, issues: Issue[]): Wording | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    issues.push({ code: "bad_wording", field });
    return undefined;
  }
  const out: Wording = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(SIGN_LOCALES as readonly string[]).includes(k) || typeof v !== "string") {
      issues.push({ code: "bad_wording", field });
      continue;
    }
    const t = v.replace(/\r\n/g, "\n").trim();
    if (t.length > max) issues.push({ code: "wording_too_long", field, detail: k });
    else if (t) out[k as SignLocale] = t;
  }
  return out;
}

function otherSigners(raw: unknown, issues: Issue[]): OtherSigner[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_OTHER_SIGNERS) {
    issues.push({ code: "bad_signers", field: "signersOther" });
    return undefined;
  }
  const out: OtherSigner[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const at = { field: "signersOther", detail: String(i) };
    if (!isObject(item)) return void issues.push({ code: "bad_signers", ...at });
    const roleKey = str(item.role_key).trim();
    const name = cleanLine(item.name);
    const email = cleanLine(item.email).toLowerCase();
    const channel = item.channel === "whatsapp" ? "whatsapp" : "email";
    const phone = item.phone === undefined || item.phone === null || item.phone === "" ? null : normalizePhone(str(item.phone));
    if (!KEY_PATTERN.test(roleKey) || seen.has(roleKey)) issues.push({ code: "signer_role", ...at });
    if (!name || name.length > 160 || hasMarkup(name)) issues.push({ code: "signer_name", ...at });
    if (!SIGNER_EMAIL_RE.test(email) || email.length > 254) issues.push({ code: "signer_email", ...at });
    if (channel === "whatsapp" && !phone) issues.push({ code: "signer_phone", ...at });
    seen.add(roleKey);
    out.push({ role_key: roleKey, name, email, channel, phone: channel === "whatsapp" ? phone : null });
  });
  return out;
}

export function askedFrom(raw: unknown): AskedFields | null {
  if (!isObject(raw)) return null;
  const out: AskedFields = { ...DEFAULT_ASKED };
  for (const k of REGISTRATION_DETAILS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (!(ASK_LEVELS as readonly unknown[]).includes(v)) return null;
    out[k] = v as AskLevel;
  }
  // the email is where the document goes: it cannot be optional or hidden
  out.email = "required";
  return out;
}

/** An admin's request body for a form. Every field is optional (a change sends what changed); a create sends the lot. */
export function parseFormInput(body: unknown): FormInputCheck {
  const issues: Issue[] = [];
  if (!isObject(body)) return { ok: false, issues: [{ code: "bad_form" }] };
  const out: FormInput = {};

  if (body.name !== undefined) {
    const name = cleanLine(body.name);
    if (!name || name.length > FORM_NAME_MAX || hasMarkup(name)) issues.push({ code: "bad_name", field: "name" });
    else out.name = name;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") issues.push({ code: "bad_flag", field: "active" });
    else out.active = body.active;
  }
  if (body.sendDocument !== undefined) {
    if (typeof body.sendDocument !== "boolean") issues.push({ code: "bad_flag", field: "sendDocument" });
    else out.sendDocument = body.sendDocument;
  }
  if (body.mode !== undefined) {
    if (typeof body.mode === "string" && (REGISTRATION_MODES as readonly string[]).includes(body.mode)) out.mode = body.mode as RegistrationMode;
    else issues.push({ code: "bad_mode", field: "mode" });
  }
  for (const [key, field] of [["templateId", "templateId"], ["contactTagId", "contactTagId"]] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (v === null || v === "") out[key] = null;
    else if (typeof v === "string" && UUID_RE.test(v)) out[key] = v.toLowerCase();
    else issues.push({ code: "bad_id", field });
  }
  if (body.applicantRoleKey !== undefined) {
    const v = body.applicantRoleKey;
    if (v === null || v === "") out.applicantRoleKey = null;
    else if (typeof v === "string" && KEY_PATTERN.test(v)) out.applicantRoleKey = v;
    else issues.push({ code: "bad_role", field: "applicantRoleKey" });
  }
  const signers = otherSigners(body.signersOther, issues);
  if (signers) out.signersOther = signers;
  if (body.copyRecipients !== undefined) {
    const copies = checkCopyList(body.copyRecipients);
    if (copies.ok) out.copyRecipients = copies.list;
    else for (const i of copies.issues) issues.push({ code: i.code, field: "copyRecipients", ...(i.index !== undefined ? { detail: String(i.index) } : {}) });
  }
  if (body.fields !== undefined) {
    const asked = askedFrom(body.fields);
    if (asked) out.fields = asked;
    else issues.push({ code: "bad_fields", field: "fields" });
  }
  const consent = wording(body.consentText, "consentText", CONSENT_MAX, issues);
  if (consent) out.consentText = consent;
  const success = wording(body.successMessage, "successMessage", SUCCESS_MAX, issues);
  if (success) out.successMessage = success;
  if (body.defaultLocale !== undefined) {
    if (typeof body.defaultLocale === "string" && (SIGN_LOCALES as readonly string[]).includes(body.defaultLocale)) out.defaultLocale = body.defaultLocale as SignLocale;
    else issues.push({ code: "bad_locale", field: "defaultLocale" });
  }
  if (body.dailyCap !== undefined) {
    const n = body.dailyCap;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_DAILY_CAP) out.dailyCap = n;
    else issues.push({ code: "bad_cap", field: "dailyCap" });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}
