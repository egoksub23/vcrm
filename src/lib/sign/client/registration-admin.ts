// ============================================================
// Doc Sign, Settings > Registration forms: the logic of the editor that has no screen in it. Pure, so it is tested
// without a browser:
//   - `draftFrom` / `toPayload`: the form being edited, and the request body it becomes (with the problems that can
//     be said before sending; the server checks everything again);
//   - `previewAddress`: the address as it will read, for the live preview while the name is typed;
//   - the keys for the words of an issue, a reason and an outcome, so a code the screens have never seen reads as a
//     plain sentence and never as a raw code.
// Nothing here may import a server module: it runs in the browser.
// ============================================================

import { ASK_LEVELS, DEFAULT_ASKED, DEFAULT_DAILY_CAP, MAX_DAILY_CAP, REGISTRATION_REASONS, type AskLevel, type OtherSigner, type RegistrationFormRow } from "@/lib/sign/registration/types";
import { slugBase } from "@/lib/sign/registration/slug-base";
import { SIGN_LOCALES, type SignLocale } from "@/lib/sign/types";

export interface TemplateOption {
  id: string;
  name: string;
  roles: { key: string; label: string; kind: "signer" | "filler" }[];
  hasForm: boolean;
  /** Migration 169: `form` for a form without a signature. Absent is an agreement to sign. */
  mode?: "sign" | "form";
}

export interface TagOption {
  id: string;
  name: string;
  color: string;
}

export interface FormOptions {
  templates: TemplateOption[];
  tags: TagOption[];
  /** The product's agreement wording per language, with {workspace} where the name goes. */
  consentDefaults: Record<SignLocale, string>;
  /** The bot check is switched on (the keys are set on the server). */
  turnstile: boolean;
  /** The address registration pages are built on. */
  origin: string;
}

/** One person for another role: a name and an email, both or neither. */
export interface OtherDraft {
  name: string;
  email: string;
}

export interface FormDraft {
  name: string;
  active: boolean;
  sendDocument: boolean;
  templateId: string;
  applicantRoleKey: string;
  /** By role key. */
  others: Record<string, OtherDraft>;
  contactTagId: string;
  /** The email is always required, so it is not here. */
  fullName: AskLevel;
  company: AskLevel;
  phone: AskLevel;
  dailyCap: string;
  defaultLocale: SignLocale;
  consentText: Record<SignLocale, string>;
  successMessage: Record<SignLocale, string>;
}

const blankWording = (): Record<SignLocale, string> => ({ en: "", ms: "", zh: "", ko: "" });

export function newDraft(): FormDraft {
  return {
    name: "",
    active: false,
    sendDocument: true,
    templateId: "",
    applicantRoleKey: "",
    others: {},
    contactTagId: "",
    fullName: DEFAULT_ASKED.full_name,
    company: DEFAULT_ASKED.company,
    phone: DEFAULT_ASKED.phone,
    dailyCap: String(DEFAULT_DAILY_CAP),
    defaultLocale: "en",
    consentText: blankWording(),
    successMessage: blankWording(),
  };
}

export function draftFrom(form: RegistrationFormRow): FormDraft {
  const others: Record<string, OtherDraft> = {};
  for (const s of form.signers_other) others[s.role_key] = { name: s.name, email: s.email };
  return {
    name: form.name,
    active: form.active,
    sendDocument: form.send_document,
    templateId: form.template_id ?? "",
    applicantRoleKey: form.applicant_role_key ?? "",
    others,
    contactTagId: form.contact_tag_id ?? "",
    fullName: form.fields.full_name,
    company: form.fields.company,
    phone: form.fields.phone,
    dailyCap: String(form.daily_cap),
    defaultLocale: form.default_locale,
    consentText: { ...blankWording(), ...form.consent_text },
    successMessage: { ...blankWording(), ...form.success_message },
  };
}

// ---- the request ---------------------------------------------------------------------------------------

export type DraftField = "name" | "template" | "applicantRole" | "others" | "dailyCap";
export type DraftProblem = "required" | "too_long" | "incomplete" | "invalid";

export interface Payload {
  name: string;
  active: boolean;
  sendDocument: boolean;
  templateId: string | null;
  applicantRoleKey: string | null;
  signersOther: OtherSigner[];
  contactTagId: string | null;
  fields: { full_name: AskLevel; email: "required"; phone: AskLevel; company: AskLevel };
  consentText: Partial<Record<SignLocale, string>>;
  successMessage: Partial<Record<SignLocale, string>>;
  defaultLocale: SignLocale;
  dailyCap: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function words(from: Record<SignLocale, string>): Partial<Record<SignLocale, string>> {
  const out: Partial<Record<SignLocale, string>> = {};
  for (const l of SIGN_LOCALES) if (from[l].trim()) out[l] = from[l].trim();
  return out;
}

/**
 * The request body for a draft, or what is wrong with it. A form that sends no document keeps no template, role or
 * people (they would only be dead settings). People for roles the template does not have are dropped.
 */
export function toPayload(draft: FormDraft, options: Pick<FormOptions, "templates">): { ok: true; payload: Payload } | { ok: false; problems: Partial<Record<DraftField, DraftProblem>> } {
  const problems: Partial<Record<DraftField, DraftProblem>> = {};
  const name = draft.name.replace(/\s+/g, " ").trim();
  if (!name) problems.name = "required";
  else if (name.length > 120) problems.name = "too_long";

  const cap = Number(draft.dailyCap);
  if (!/^\d+$/.test(draft.dailyCap.trim()) || !Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_CAP) problems.dailyCap = "invalid";

  let signersOther: OtherSigner[] = [];
  let templateId: string | null = null;
  let applicantRoleKey: string | null = null;
  if (draft.sendDocument) {
    const template = options.templates.find((t) => t.id === draft.templateId);
    if (!template) problems.template = "required";
    else {
      templateId = template.id;
      if (!template.roles.some((r) => r.key === draft.applicantRoleKey)) problems.applicantRole = "required";
      else {
        applicantRoleKey = draft.applicantRoleKey;
        for (const role of template.roles) {
          if (role.key === applicantRoleKey) continue;
          const who = draft.others[role.key];
          const n = who?.name.trim() ?? "";
          const e = who?.email.trim().toLowerCase() ?? "";
          if (!n && !e) continue;
          if (!n || !e) problems.others = "incomplete";
          else if (!EMAIL.test(e)) problems.others = "invalid";
          else signersOther.push({ role_key: role.key, name: n, email: e, channel: "email", phone: null });
        }
      }
    }
  }
  if (!draft.sendDocument) signersOther = [];
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return {
    ok: true,
    payload: {
      name,
      active: draft.active,
      sendDocument: draft.sendDocument,
      templateId,
      applicantRoleKey,
      signersOther,
      contactTagId: draft.contactTagId || null,
      fields: { full_name: draft.fullName, email: "required", phone: draft.phone, company: draft.company },
      consentText: words(draft.consentText),
      successMessage: words(draft.successMessage),
      defaultLocale: draft.defaultLocale,
      dailyCap: cap,
    },
  };
}

/** The choices of a detail: required, optional, or not asked. */
export const ASK_CHOICES: readonly AskLevel[] = ASK_LEVELS;

/** What the address will read like: the readable start now, the random end once it is saved. */
export function previewAddress(origin: string, name: string): string {
  return `${origin.replace(/\/+$/, "")}/r/${slugBase(name)}-xxxxxxxx`;
}

// ---- words ---------------------------------------------------------------------------------------------

const KNOWN_REASONS: ReadonlySet<string> = new Set(REGISTRATION_REASONS);

/** The message key (under `Sign.admin.registration`) for a reason code; a code never seen reads as the general sentence. */
export const reasonKey = (reason: string | null | undefined): string => (reason && KNOWN_REASONS.has(reason) ? `reasons.${reason}` : "reasons.generic");

const KNOWN_ISSUES: ReadonlySet<string> = new Set([
  "no_template",
  // a form without a signature (migration 169)
  "template_mode_mismatch",
  "no_person",
  "form_mode_needs_a_form",
  "form_mode_signature",
  "form_mode_placement",
  "form_mode_signer_role",
  "template_not_active",
  "template_has_no_version",
  "no_applicant_role",
  "applicant_role_unknown",
  "signer_role",
  "no_signer",
  "role_without_person",
  "part_without_person",
  "signer_without_signature",
  "signer_name",
  "signer_email",
  "signer_phone",
  "too_many_signers",
  "order_not_unique",
  "same_person_twice",
]);

/** The message key (under `Sign.admin.registration`) for an issue that stops a form working. */
export const issueKey = (code: string): string => (KNOWN_ISSUES.has(code) ? `issues.${code}` : "issues.generic");
