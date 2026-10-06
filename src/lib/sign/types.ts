// ============================================================
// Doc Sign: the shapes of the database rows (migrations 157 and 158) and the vocabulary around them.
// Pure types and constants, no I/O.
// ============================================================

import type { FormDefinition } from "./forms/types";
import type { PlacedField } from "./pdf/types";

export const SIGN_BUCKET = "sign-documents";

export const DOCUMENT_STATUSES = ["draft", "sent", "in_progress", "sealing", "completed", "declined", "expired", "voided", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** A document in one of these can still change: someone may yet sign. */
export const OPEN_STATUSES: readonly DocumentStatus[] = ["sent", "in_progress"];
/** A document in one of these will not change again (failed can be retried by an operator). */
export const FINAL_STATUSES: readonly DocumentStatus[] = ["completed", "declined", "expired", "voided"];

export const SIGNER_STATUSES = ["pending", "sent", "viewed", "signed", "declined"] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export type SignerKind = "signer" | "filler";
export type SignChannel = "email" | "whatsapp";
export type SignLocale = "en" | "ms" | "zh" | "ko";
export const SIGN_LOCALES: readonly SignLocale[] = ["en", "ms", "zh", "ko"];

/** A role of a document or template: who completes which fields. */
export interface SignRole {
  /** Stable key, for example "merchant" or "director". */
  key: string;
  /** Shown to the sender, for example "Merchant". */
  label: string;
  kind: SignerKind;
  /** Colour slot 0..5 for the editor and the signing page. */
  color: number;
}

export interface SignDocumentRow {
  id: string;
  account_id: string;
  reference: string | null;
  title: string;
  status: DocumentStatus;
  category_id: string | null;
  template_version_id: string | null;
  contact_id: string | null;
  ticket_id: string | null;
  deal_id: string | null;
  merge_values: Record<string, unknown>;
  fields_snapshot: PlacedField[];
  roles_snapshot: SignRole[];
  /** Forms (phase 1B): the form the signers fill in parts; null for a document that is only fields on the page. */
  form_snapshot: FormDefinition | null;
  sign_in_order: boolean;
  code_required: boolean;
  locale: SignLocale;
  message: string | null;
  expires_at: string | null;
  sent_at: string | null;
  completed_at: string | null;
  retain_until: string | null;
  original_path: string | null;
  original_type: string | null;
  original_sha256: string | null;
  base_path: string | null;
  base_sha256: string | null;
  page_count: number | null;
  final_path: string | null;
  final_sha256: string | null;
  void_reason: string | null;
  reminder_days: number[] | null;
  sealing_started_at: string | null;
  sealing_attempts: number;
  seal_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignSignerRow {
  id: string;
  account_id: string;
  document_id: string;
  role_key: string;
  kind: SignerKind;
  full_name: string;
  email: string;
  phone: string | null;
  channel: SignChannel;
  order_no: number;
  status: SignerStatus;
  internal_user_id: string | null;
  invited_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  ip: string | null;
  device: string | null;
  locale: SignLocale | null;
  consent_version: string | null;
  consented_at: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
  created_at: string;
  updated_at: string;
}

export interface SignSettingsRow {
  id: string;
  account_id: string;
  default_expiry_days: number;
  reminder_days: number[];
  default_language: SignLocale;
  consent_texts: Record<string, string>;
  sender_name: string | null;
  logo_path: string | null;
  retention_years: number;
  certificate_id: string | null;
  whatsapp_template_name: string | null;
  whatsapp_template_language: string;
}

export interface SignTemplateVersionRow {
  id: string;
  account_id: string;
  template_id: string;
  version_no: number;
  source_path: string;
  source_sha256: string;
  original_path: string | null;
  original_type: string | null;
  page_count: number;
  fields: PlacedField[];
  roles: SignRole[];
  form: FormDefinition | null;
  defaults: TemplateDefaults;
  created_at: string;
}

export interface TemplateDefaults {
  expiry_days?: number;
  reminder_days?: number[];
  sign_in_order?: boolean;
  code_required?: boolean;
  locale?: SignLocale;
  subject?: string;
  message?: string;
}

/** What `sign_send_document` and the step functions return for each person who was just invited. */
export interface Invitation {
  signer_id: string;
  /** The link token. It exists nowhere else: send it, do not log it. */
  token: string;
  name: string;
  email: string;
  phone: string | null;
  channel: SignChannel;
  role_key: string;
  kind: SignerKind;
  order_no: number;
}

/** The event types the chain carries. The certificate and the detail screen word each in the reader's language. */
export const EVENT_TYPES = [
  "sent",
  "invited",
  "resent",
  "recipient_changed",
  "viewed",
  "code_sent",
  "code_verified",
  "code_failed",
  "consented",
  "saved",
  "signed",
  "submitted",
  "declined",
  "all_signed",
  "seal_attempt_failed",
  "sealed",
  "completed",
  "voided",
  "expired",
  "seal_failed",
  "reminded",
  "downloaded",
  "delivery_failed",
  "created",
  // forms
  "part_completed",
  "part_reopened",
  "uploaded",
  "upload_removed",
  "writeback",
  "expiry_extended",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
