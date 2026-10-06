// ============================================================
// Doc Sign bulk send (migration 162): the shapes shared by the server and the screens, and the limits.
// Pure types and constants, no I/O.
// ============================================================

import type { SignChannel, SignLocale } from "../types";

/** The most people one batch can hold. */
export const BULK_MAX_ROWS = 500;
/** The largest CSV text accepted, in bytes. */
export const BULK_MAX_BYTES = 1_000_000;
/** Batches a workspace can have queued or running at once (the database enforces it too). */
export const BULK_MAX_ACTIVE_JOBS = 3;
/** The most fixed people (the other roles of the template) one batch can name. */
export const BULK_MAX_FIXED = 5;
/** A row's merge value, as a document takes it. */
export const BULK_MAX_VALUE = 2000;

export type BulkJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type BulkRowState = "pending" | "sent" | "failed" | "skipped";

/** Someone who is the same on every document of the batch: the person of a role other than the one the rows fill. */
export interface BulkFixedSigner {
  roleKey: string;
  fullName: string;
  email: string;
  phone?: string | null;
  channel: SignChannel;
}

/** What every document of the batch shares. `null` means "the template's, the category's or the workspace's default". */
export interface BulkOptions {
  templateId: string;
  /** The template role the people of the list fill. */
  personRole: string;
  fixedSigners: BulkFixedSigner[];
  /** How the people of the list are reached. */
  channel: SignChannel;
  /** A title for every document; `{name}` becomes the person's name. null: "<template title> - <name>". */
  title: string | null;
  categoryId: string | null;
  message: string | null;
  locale: SignLocale | null;
  /** Days from sending until the link stops working. null: the default. */
  expiryDays: number | null;
  codeRequired: boolean | null;
  signInOrder: boolean | null;
  reminderDays: number[] | null;
}

/** What the list said for one person. Stored as the row's input and never changed. */
export interface BulkRowInput {
  name: string;
  email: string;
  phone: string | null;
  contactId: string | null;
  merge: Record<string, string>;
}

/** A problem, worded on screen by its code. `detail` is a column name, a row number or a count. */
export interface BulkProblem {
  code: string;
  detail?: string;
}

/** Problems of the file as a whole (nothing can be read from it, or part of it is dropped). */
export const FILE_PROBLEM_CODES = ["empty_file", "no_header", "missing_column", "duplicate_column", "too_many_rows", "too_large", "no_rows"] as const;
/** Problems of one person. */
export const ROW_PROBLEM_CODES = [
  "name_missing",
  "name_too_long",
  "email_missing",
  "email_invalid",
  "email_duplicate",
  "phone_invalid",
  "merge_missing",
  "merge_too_long",
  "contact_invalid",
  "contact_not_found",
  "same_person_twice",
] as const;
/** Problems of the setup (the template, the roles, the fixed people), shown once. */
export const PLAN_PROBLEM_CODES = [
  "template_not_ready",
  "bad_person_role",
  "bad_fixed_signer",
  "fixed_signer_name",
  "fixed_signer_email",
  "fixed_signer_phone",
  "role_without_person",
  "signer_without_signature",
  "merge_needs_file",
  "bad_options",
] as const;

export interface BulkRoleInfo {
  key: string;
  label: string;
  kind: "signer" | "filler";
  /** The role has fields to complete, so it needs a person. */
  needsPerson: boolean;
}

export interface BulkPreviewRow {
  rowNo: number;
  name: string;
  email: string;
  phone: string | null;
  contactId: string | null;
  merge: Record<string, string>;
  problems: BulkProblem[];
}

export interface BulkHeadroom {
  /** The workspace's monthly limit of documents sent, or null when there is none. */
  limit: number | null;
  used: number;
  /** Documents that can still be sent this month, or null when unlimited. */
  remaining: number | null;
  /** Documents this batch would send (rows without a problem). */
  needed: number;
  fits: boolean;
}

export interface BulkPreview {
  template: { id: string; name: string; mergeKeys: string[]; roles: BulkRoleInfo[] };
  file: { problems: BulkProblem[]; ignoredColumns: string[]; rowCount: number };
  plan: { problems: BulkProblem[] };
  rows: BulkPreviewRow[];
  counts: { total: number; ok: number; withProblems: number };
  headroom: BulkHeadroom;
}

export interface BulkRowView {
  rowNo: number;
  name: string;
  email: string;
  state: BulkRowState;
  documentId: string | null;
  reference: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Being worked on right now. */
  inFlight: boolean;
}

export interface BulkJobView {
  id: string;
  templateId: string | null;
  templateName: string;
  status: BulkJobStatus;
  source: "csv" | "contacts";
  fileName: string | null;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The statuses of a job that will not change again. */
export const BULK_FINAL_JOB_STATUSES: readonly BulkJobStatus[] = ["done", "failed", "cancelled"];
