// ============================================================
// Doc Sign registration forms (migration 164, requirement F-58): the shapes of the two tables and the
// vocabulary around them. Pure types and constants, no I/O. Imported by the server, the public page and the
// Settings screen, so it carries nothing that needs a server secret.
// ============================================================

import type { CopyInput } from "../copy-list";
import type { SignLocale } from "../types";

/** How the page treats a detail: asked and needed, asked but may be left empty, or not asked at all. */
export const ASK_LEVELS = ["required", "optional", "off"] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

/** The details a page can ask for, in the order it shows them. */
export const REGISTRATION_DETAILS = ["full_name", "email", "phone", "company"] as const;
export type RegistrationDetail = (typeof REGISTRATION_DETAILS)[number];

/** Which details the page asks for. The email is always required: it is where the document goes. */
export type AskedFields = Record<RegistrationDetail, AskLevel>;

export const DEFAULT_ASKED: AskedFields = { full_name: "required", email: "required", phone: "optional", company: "required" };

/**
 * What the form sends: `sign` an agreement to sign, `form` a form without a signature (migration 169): the person gets a link,
 * fills the parts in and submits. The mode must be the mode of the form's template (the database holds that too).
 */
export const REGISTRATION_MODES = ["sign", "form"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

/** The script the page loads when Turnstile is on (the one outside address the page may reach; see next.config.ts). */
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

export const DEFAULT_DAILY_CAP = 100;
export const MAX_DAILY_CAP = 5000;

/** A person for one of the template's other roles, fixed in the form (for example the director who countersigns). */
export interface OtherSigner {
  role_key: string;
  name: string;
  email: string;
  channel: "email" | "whatsapp";
  phone?: string | null;
}

export type Wording = Partial<Record<SignLocale, string>>;

export interface RegistrationFormRow {
  id: string;
  account_id: string;
  slug: string;
  name: string;
  active: boolean;
  mode: RegistrationMode;
  send_document: boolean;
  template_id: string | null;
  applicant_role_key: string | null;
  signers_other: OtherSigner[];
  /** Migration 176: people who receive the signed copy of every document this form sends (at most 10; none is `[]`). Never shown on the public page. */
  copy_recipients: CopyInput[];
  contact_tag_id: string | null;
  fields: AskedFields;
  consent_text: Wording;
  success_message: Wording;
  default_locale: SignLocale;
  daily_cap: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** What became of a submission. */
export const REGISTRATION_STATUSES = ["accepted", "rejected_spam", "rejected_cap", "failed"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/**
 * The short codes that say why, stored in `sign_registrations.reason`. Never personal data. The Settings screen
 * words each in the reader's language; a code it has not seen reads as the plain status.
 */
export const REGISTRATION_REASONS = [
  // accepted (a normal acceptance has no reason; this one is a repeat that started nothing new)
  "duplicate",
  // rejected_spam
  "honeypot",
  "token_invalid",
  "token_expired",
  "token_too_fast",
  "captcha_failed",
  // rejected_cap
  "daily_cap",
  // failed
  "in_progress",
  "contact_limit_reached",
  "sign_limit_reached",
  "form_not_ready",
  "template_not_active",
  "delivery_failed",
  "send_failed",
] as const;
export type RegistrationReason = (typeof REGISTRATION_REASONS)[number];

export interface RegistrationEntry {
  id: string;
  status: RegistrationStatus;
  reason: string | null;
  contact_id: string | null;
  document_id: string | null;
  locale: SignLocale | null;
  created_at: string;
}

/** The counts the Settings list shows beside each form, over the last 30 days. */
export interface RegistrationCounts {
  accepted: number;
  rejected_spam: number;
  rejected_cap: number;
  failed: number;
  /** Accepted in the last 24 hours (what the daily cap counts). */
  today: number;
}
