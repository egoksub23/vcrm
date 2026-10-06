// ============================================================
// Doc Sign bulk send, browser side: what the sender fills in, turned into the request the server takes, which step
// is ready, how a failure or a problem is worded, and how a running batch is shown. Pure (no React, no I/O), so
// the rules are tested. The server checks everything again; this only keeps the screen from sending what it knows
// would be refused.
// ============================================================

import { BULK_MAX_BYTES, BULK_MAX_FIXED, BULK_MAX_ROWS, type BulkFixedSigner, type BulkJobStatus, type BulkJobView, type BulkRoleInfo, type BulkRowState } from "../bulk/types";
import { normalizePhone } from "../rules";
import type { SignChannel, SignLocale } from "../types";
import { SIGN_LOCALES } from "../types";
import { cleanReminderDays } from "../defaults";

export type WizardStep = "template" | "people" | "setup" | "review";
export const WIZARD_STEPS: readonly WizardStep[] = ["template", "people", "setup", "review"];

/** Someone who is the same on every document, as typed. */
export interface FixedPerson {
  fullName: string;
  email: string;
  phone: string;
  channel: SignChannel;
}

export interface PickedContact {
  id: string;
  name: string | null;
  email: string | null;
}

export interface WizardForm {
  templateId: string | null;
  source: "csv" | "contacts";
  csvText: string | null;
  fileName: string | null;
  contacts: PickedContact[];
  personRole: string | null;
  /** By role key. */
  fixed: Record<string, FixedPerson>;
  channel: SignChannel;
  title: string;
  categoryId: string | null;
  message: string;
  /** "" = the template's, the category's or the workspace's. */
  locale: SignLocale | "";
  /** Days as typed; "" = the default. */
  expiryDays: string;
  /** Days as typed, for example "3, 7"; null = the default. */
  reminderText: string | null;
  /** "default", "yes" or "no". */
  codeRequired: "default" | "yes" | "no";
  signInOrder: "default" | "yes" | "no";
  skipInvalid: boolean;
}

export const EMPTY_FORM: WizardForm = {
  templateId: null,
  source: "csv",
  csvText: null,
  fileName: null,
  contacts: [],
  personRole: null,
  fixed: {},
  channel: "email",
  title: "",
  categoryId: null,
  message: "",
  locale: "",
  expiryDays: "",
  reminderText: null,
  codeRequired: "default",
  signInOrder: "default",
  skipInvalid: false,
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const emptyPerson = (): FixedPerson => ({ fullName: "", email: "", phone: "", channel: "email" });

const triState = (v: "default" | "yes" | "no"): boolean | null => (v === "default" ? null : v === "yes");

/** The days as typed ("3, 7") as a list, or null when the sender left the default. */
function reminderDaysOf(text: string | null): number[] | null {
  if (text === null) return null;
  return cleanReminderDays(
    text
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((x) => Number(x)),
  );
}

/** A fixed person counts as given once anything is typed; a role that needs one must have it. */
export const personStarted = (p: FixedPerson | undefined): boolean => !!p && (p.fullName.trim() !== "" || p.email.trim() !== "" || p.phone.trim() !== "");

export function personComplete(p: FixedPerson | undefined): boolean {
  if (!p) return false;
  return p.fullName.trim() !== "" && EMAIL_RE.test(p.email.trim()) && (p.channel !== "whatsapp" || normalizePhone(p.phone) !== null);
}

/** The role the people of the list most likely fill: the first one that has something to complete and signs, else the first. */
export function pickDefaultRole(roles: readonly BulkRoleInfo[]): string | null {
  return (roles.find((r) => r.needsPerson && r.kind === "signer") ?? roles.find((r) => r.needsPerson) ?? roles[0])?.key ?? null;
}

/** The people of the other roles, as the server takes them: only those the sender started. */
export function fixedSignersOf(form: WizardForm, roles: readonly BulkRoleInfo[]): BulkFixedSigner[] {
  const out: BulkFixedSigner[] = [];
  for (const r of roles) {
    if (r.key === form.personRole) continue;
    const p = form.fixed[r.key];
    if (!personStarted(p)) continue;
    out.push({ roleKey: r.key, fullName: p.fullName.trim(), email: p.email.trim(), phone: p.phone.trim() || null, channel: p.channel });
  }
  return out;
}

export interface BulkRequestBody {
  options: Record<string, unknown>;
  csv?: string;
  contactIds?: string[];
  skipInvalid: boolean;
  fileName?: string;
}

/** The body of the preview and of the start request: the same for both. Null while something needed is missing. */
export function buildRequest(form: WizardForm, roles: readonly BulkRoleInfo[]): BulkRequestBody | null {
  if (!form.templateId || !form.personRole) return null;
  const hasList = form.source === "csv" ? form.csvText !== null && form.csvText !== "" : form.contacts.length > 0;
  if (!hasList) return null;
  const days = form.expiryDays.trim() === "" ? null : Number(form.expiryDays);
  const options = {
    templateId: form.templateId,
    personRole: form.personRole,
    fixedSigners: fixedSignersOf(form, roles),
    channel: form.channel,
    title: form.title.trim() === "" ? null : form.title.trim(),
    categoryId: form.categoryId,
    message: form.message.trim() === "" ? null : form.message.trim(),
    locale: form.locale === "" ? null : form.locale,
    expiryDays: days,
    codeRequired: triState(form.codeRequired),
    signInOrder: triState(form.signInOrder),
    reminderDays: reminderDaysOf(form.reminderText),
  };
  return form.source === "csv"
    ? { options, csv: form.csvText ?? "", skipInvalid: form.skipInvalid, ...(form.fileName ? { fileName: form.fileName } : {}) }
    : { options, contactIds: form.contacts.map((c) => c.id), skipInvalid: form.skipInvalid };
}

/** What stops the sender moving on from the setup step: codes the screen words, empty when it is fine. */
export function setupProblems(form: WizardForm, roles: readonly BulkRoleInfo[]): string[] {
  const out: string[] = [];
  if (!form.personRole || !roles.some((r) => r.key === form.personRole)) out.push("personRole");
  const others = roles.filter((r) => r.key !== form.personRole);
  if (others.filter((r) => personStarted(form.fixed[r.key])).length > BULK_MAX_FIXED) out.push("tooManyFixed");
  for (const r of others) {
    const p = form.fixed[r.key];
    if ((r.needsPerson || personStarted(p)) && !personComplete(p)) out.push(`fixed:${r.key}`);
  }
  if (form.expiryDays.trim() !== "") {
    const n = Number(form.expiryDays);
    if (!Number.isInteger(n) || n < 1 || n > 365) out.push("expiryDays");
  }
  if (form.reminderText !== null && form.reminderText.trim() !== "") {
    const typed = form.reminderText.split(/[\s,;]+/).filter(Boolean);
    const days = reminderDaysOf(form.reminderText) ?? [];
    // "0" means no reminders at all
    const none = typed.length === 1 && Number(typed[0]) === 0;
    if (!none && (days.length === 0 || days.length !== new Set(typed.map(Number)).size || typed.length > 5)) out.push("reminders");
  }
  if (form.message.length > 2000) out.push("message");
  if (form.title.length > 200) out.push("title");
  if (form.locale !== "" && !SIGN_LOCALES.includes(form.locale)) out.push("locale");
  return out;
}

/** Is each step complete enough to move on from? The review step is complete once a batch has been started. */
export function stepDone(step: WizardStep, form: WizardForm, roles: readonly BulkRoleInfo[]): boolean {
  switch (step) {
    case "template":
      return form.templateId !== null;
    case "people":
      return form.source === "csv" ? !!form.csvText : form.contacts.length > 0;
    case "setup":
      return setupProblems(form, roles).length === 0;
    default:
      return false;
  }
}

// ---- the file ------------------------------------------------------------------------------------------

export type FileCheck = "too_large" | "not_csv" | null;

/** A first look at the chosen file, before it is read. The server reads and checks the contents. */
export function checkFile(file: { name: string; size: number; type?: string }): FileCheck {
  if (file.size > BULK_MAX_BYTES) return "too_large";
  const csvLike = /\.(csv|txt)$/i.test(file.name) || /csv|text\/plain/i.test(file.type ?? "");
  return csvLike ? null : "not_csv";
}

/** A sample file for the template: a header with the columns the template needs, and one example line. */
export function sampleCsv(mergeKeys: readonly string[]): string[][] {
  const personKeys = new Set(["full_name", "email", "phone", "name"]);
  const extra = mergeKeys.filter((k) => !personKeys.has(k.toLowerCase()));
  return [
    ["full_name", "email", "phone", ...extra],
    ["Ali bin Ahmad", "ali@example.com", "+60123456789", ...extra.map(() => "")],
  ];
}

export const MAX_ROWS_TEXT = BULK_MAX_ROWS;

// ---- words ---------------------------------------------------------------------------------------------

/** Failure codes the bulk screens word themselves (the rest read as the generic sentence). */
export const BULK_ERROR_CODES = [
  "bad_options",
  "list_required",
  "bulk_file_problems",
  "bulk_not_ready",
  "rows_have_problems",
  "nothing_to_send",
  "sign_limit_reached",
  "too_many_bulk_jobs",
  "template_not_found",
  "template_not_active",
  "template_has_no_version",
  "category_not_found",
  "job_not_found",
  "job_finished",
  "nothing_to_download",
  "bad_ids",
  "sign_disabled",
  "network",
  "signed_out",
  "forbidden",
  "rate_limited",
  "body_too_large",
] as const;
const KNOWN: ReadonlySet<string> = new Set(BULK_ERROR_CODES);

/** The message key (under `Sign.bulk`) for a failure code of a bulk route. */
export const bulkErrorKey = (code: string | null | undefined): string => (code && KNOWN.has(code) ? `errors.${code}` : "errors.generic");

/** Codes of a failed or stopped row that have a sentence of their own (a row's own problems are `problem.<code>`). */
const ROW_CODES: ReadonlySet<string> = new Set([
  "sign_limit_reached",
  "cancelled",
  "gave_up",
  "sign_disabled",
  "template_not_found",
  "template_not_active",
  "template_has_no_version",
  "category_not_found",
  "not_ready",
  "signer_name",
  "signer_email",
  "signer_phone",
  "signer_role",
  "expiry_in_the_past",
  "document_not_draft",
  "database_error",
  "row_not_open",
  "unexpected",
]);

/** The message key (under `Sign.bulk`) for what became of a row. Unknown codes read as "something went wrong". */
export const rowReasonKey = (code: string | null | undefined): string => (code && ROW_CODES.has(code) ? `reason.${code}` : "reason.unknown");

const PLAN_CODES: ReadonlySet<string> = new Set([
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
]);
export const planProblemKey = (code: string): string => (PLAN_CODES.has(code) ? `plan.${code}` : "plan.template_not_ready");

const FILE_CODES: ReadonlySet<string> = new Set(["empty_file", "no_header", "missing_column", "duplicate_column", "too_many_rows", "too_large", "no_rows"]);
export const fileProblemKey = (code: string): string => (FILE_CODES.has(code) ? `file.${code}` : "file.unknown");

// ---- a running batch -----------------------------------------------------------------------------------

export const isFinalJob = (status: BulkJobStatus): boolean => status === "done" || status === "failed" || status === "cancelled";

/** How far along a batch is: people with an answer (sent, failed or skipped) of the total, 0 to 100. */
export function progressPercent(job: Pick<BulkJobView, "total" | "sent" | "failed" | "skipped">): number {
  if (job.total <= 0) return 0;
  return Math.min(100, Math.round(((job.sent + job.failed + job.skipped) / job.total) * 100));
}

/** Milliseconds until the screen asks again: soon while it is running, slower while queued, never when finished. */
export function nextPollMs(status: BulkJobStatus, failures = 0): number | null {
  if (isFinalJob(status)) return null;
  const base = status === "running" ? 3000 : 5000;
  return Math.min(30_000, base * 2 ** Math.min(failures, 3));
}

export const ROW_FILTERS = ["all", "sent", "failed", "skipped", "pending"] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];
export const rowMatches = (state: BulkRowState, filter: RowFilter): boolean => filter === "all" || state === filter;

/** A badge tint for a row's state. */
export function rowStateClass(state: BulkRowState): string {
  switch (state) {
    case "sent":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "skipped":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function jobStatusClass(status: BulkJobStatus): string {
  switch (status) {
    case "done":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "cancelled":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-300";
    case "running":
      return "bg-sky-500/15 text-sky-800 dark:text-sky-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}
