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

/**
 * Migration 169 (F-97): what the people on a template or a document are asked to do. `sign` is an agreement to sign; `form` is a form in parts
 * with no signature at all (the person fills it in and submits). Fixed when a template is made and copied to each document.
 */
export const SIGN_MODES = ["sign", "form"] as const;
export type SignMode = (typeof SIGN_MODES)[number];
export const isFormMode = (row: { mode?: SignMode | string | null } | SignMode | string | null | undefined): boolean => (typeof row === "string" ? row : row?.mode) === "form";

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
  /**
   * Document collections: "people" marks a role the collection's people made (one for each person who must sign, on a document that has no roles
   * of its own). The editor shows it locked ("from the collection's people"); the collection keeps it in step with the people. Absent for every
   * other role.
   */
  source?: "people";
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
  /** Migration 169: an agreement to sign, or a form without a signature. Copied from the template version; never changes. */
  mode: SignMode;
  /** Migration 170: sent from a template to try it out. Marked TEST, never counted against the limit, never sent to webhooks or automations. Fixed once sent. */
  test: boolean;
  sign_in_order: boolean;
  code_required: boolean;
  /** Phase 2 (migration 166): a signer may forward their turn, or a part of the form, to someone else. The sender's switch. */
  allow_forwarding: boolean;
  /** Phase 2 (migration 171): the envelope this document is part of, and its place in it (1 to 6); both null for a document on its own. Fixed once set. */
  envelope_id?: string | null;
  envelope_position?: number | null;
  /**
   * Migration 176: private to its uploader, the workspace's admins and the Halo users named as signers (a document of a private collection is
   * private). Chosen while a draft, fixed once sent. Absent or false: seen by everyone with menu.sign. See service/privacy.ts.
   */
  is_private?: boolean;
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
  /** Phase 2 (migration 166). A delegate (a filler who was handed parts of a signer's form): the parts they may see and fill; null for everyone else. */
  part_keys: string[] | null;
  /** The signer who handed the parts over (set exactly when `part_keys` is). */
  delegated_by: string | null;
  /** How many forwards this position has made, a turn or a part. */
  forward_count: number;
  /** The names that held this position before a forward, oldest first. */
  forward_history: { name: string; at: string }[];
  /** Phase 2 (migration 171): in an envelope, the rows that are one person across its documents share this id; the person's row on their first document (the anchor) has its own id here. Null outside an envelope. */
  party_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Migration 171: several documents signed in one sitting by the same people. The status is derived from the documents (the words are the documents'). */
export interface SignEnvelopeRow {
  id: string;
  account_id: string;
  reference: string | null;
  title: string;
  status: DocumentStatus;
  contact_id: string | null;
  message: string | null;
  locale: SignLocale;
  sign_in_order: boolean;
  code_required: boolean;
  reminder_days: number[] | null;
  expires_at: string | null;
  sent_at: string | null;
  completed_at: string | null;
  void_reason: string | null;
  end_notified_at: string | null;
  /** Migration 176: a private collection (and so every document of it) is seen only by its uploader, admins and the Halo users named on it. */
  is_private?: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Migration 175: a person who receives the signed copy when the document (or every document of the collection) is completed. Not a signer. */
export interface SignCopyRecipientRow {
  id: string;
  account_id: string;
  /** Exactly one of the two is set: a document on its own, or a document collection. */
  document_id: string | null;
  envelope_id: string | null;
  full_name: string;
  email: string;
  /** When the signed copy was sent to this person; null until then. */
  notified_at: string | null;
  created_by: string | null;
  created_at: string;
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
  /** Migration 169: the mode of the template, carried by each of its versions. */
  mode: SignMode;
  defaults: TemplateDefaults;
  created_at: string;
}

export interface TemplateDefaults {
  expiry_days?: number;
  reminder_days?: number[];
  sign_in_order?: boolean;
  code_required?: boolean;
  /** Phase 2: a document made from this version lets its signers forward. Off unless the template says so. */
  allow_forwarding?: boolean;
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
  /** Set when this invitation is a forward: the name of the person who handed it over. */
  forwarded_by?: string;
  /** Set when only a part of a form was handed over. */
  part?: string;
  /** Set when this invitation is for a person of an envelope: one link serves all of their documents. */
  envelope_id?: string;
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
  // the sender asked for another try after sealing stopped (service/seal-retry.ts); History only: left off the certificate
  "seal_retried",
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
  // phase 2: forwarding, and a person who has not been invited moving to another step
  "forwarded",
  "part_forwarded",
  "part_taken_back",
  "signer_moved",
  "forwarding_changed",
  // phase 2: a Halo user opened their own turn from inside Halo (a new link, not sent anywhere; see service/countersign.ts)
  "halo_link",
  // phase 2: a sender asked to see a sensitive answer in full (the field and the document, never the value; see service/sensitive-staff.ts)
  "sensitive_viewed",
  // phase 2 (migration 169): in a form without a signature, everyone had submitted
  "all_submitted",
  // phase 2 (WP20b): the file of a draft was replaced (never on a sent document); kept in the history, left off the certificate
  "file_replaced",
  // phase 2 (migration 171): envelopes. Markers in each document's chain; the document's own events (sent, signed, sealed...) are unchanged.
  "envelope_sent",
  "envelope_completed",
  "envelope_declined",
  // document collections, while a draft: a document added, one removed, the order changed. History only: left off the certificate.
  "envelope_document_added",
  "envelope_document_removed",
  "envelope_reordered",
  // migration 175: a person who receives a copy was added to a document or collection, or removed (names and masked addresses only). History only: left off the certificate.
  "copy_recipient_added",
  "copy_recipient_removed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
