// ============================================================
// Compliance requests (migration 183): the shapes and constants shared by the server and the screens. No I/O and no Node imports, so the
// browser may import this file.
// ============================================================

export const REQUEST_STATUSES = [
  "received",
  "identity_check",
  "officer_review",
  "awaiting_signoff",
  "approved",
  "rejected",
  "executing",
  "completed",
  "closed",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Statuses in which the case is finished as far as the regulatory clock goes. */
export const FINISHED_STATUSES: readonly RequestStatus[] = ["completed", "closed"];

export const SOURCES = ["form", "staff", "inbox", "ticket"] as const;
export type RequestSource = (typeof SOURCES)[number];

export const EVENT_KINDS = [
  "created",
  "edited",
  "status",
  "identity_check",
  "review",
  "signoff",
  "execute_step",
  "note",
  "link",
  "reveal",
  "view",
  "export",
  "clock_pause",
  "clock_resume",
  "attachment",
  "standing",
  "assigned",
  "clock_alert",
  // Migration 184: an email about the case (sent, failed, or not sent with the reason), customer or staff
  "notice",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const IDENTITY_METHODS = ["call_back", "video_call", "id_document", "chat_verification", "in_person", "other"] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];
export const IDENTITY_OUTCOMES = ["pass", "fail"] as const;
export type IdentityOutcome = (typeof IDENTITY_OUTCOMES)[number];

export const RECOMMENDATIONS = ["approve", "reject", "more_info"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/** A localized text: the languages Halo is translated into; `en` is always there. */
export type L10n = { en: string; ms?: string; zh?: string; ko?: string };

export const FIELD_TYPES = ["text", "multiline", "phone", "email", "number", "date", "choice", "yesno", "acknowledge", "file"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A field of a request type. Types that may carry a secret are SENSITIVE_FIELD_TYPES. */
export interface FieldDef {
  key: string;
  type: FieldType;
  label: L10n;
  required: boolean;
  sensitive: boolean;
  help?: L10n;
  /** `choice` only. */
  options?: { value: string; label: L10n }[];
}

export const SENSITIVE_FIELD_TYPES: readonly FieldType[] = ["text", "multiline", "number", "phone", "email", "date"];

export interface ChecklistTemplateItem {
  key: string;
  label: L10n;
}

export interface RequestTypeRow {
  id: string;
  key: string;
  label: string;
  labelL10n: Partial<Record<"ms" | "zh" | "ko", string>>;
  fields: FieldDef[];
  checklist: ChecklistTemplateItem[];
  targetDays: number | null;
  hardStopDays: number | null;
  requiresIdentityCheck: boolean;
  checkDues: boolean;
  allowPause: boolean;
  active: boolean;
  isSystem: boolean;
  position: number;
}

export interface IdentityCheck {
  method?: IdentityMethod;
  methodOther?: string | null;
  outcome?: IdentityOutcome | "not_required";
  notes?: string | null;
  verifiedBy?: string | null;
  recordedBy?: string | null;
  verifiedAt?: string | null;
}

export interface ReviewRecord {
  recommendation?: Recommendation;
  notes?: string | null;
  by?: string | null;
  at?: string | null;
  sentBackAt?: string | null;
  sentBackBy?: string | null;
  sentBackNote?: string | null;
}

export interface SignoffRecord {
  decision?: "approved" | "rejected";
  by?: string | null;
  at?: string | null;
  reason?: string | null;
  overrideReason?: string | null;
  /** Migration 184: a rejection's category (for the reports) and the words the customer is told (separate from the internal note). */
  reasonCategory?: RejectionCategory | null;
  customerReason?: string | null;
}

/** What the reports group the rejections by (migration 184 validates the same list). */
export const REJECTION_CATEGORIES = ["identity_failed", "incomplete_information", "dues_outstanding", "not_eligible", "duplicate", "customer_withdrew", "other"] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

export const LOCALES = ["en", "ms", "zh", "ko"] as const;
export type CustomerLocale = (typeof LOCALES)[number];

export interface StandingRecord {
  /** null/absent: not recorded yet. */
  duesOutstanding?: boolean | null;
  notes?: string | null;
  /** "manual" now; "api" when the Vircle back office fills it in. */
  source?: "manual" | "api";
  setBy?: string | null;
  setAt?: string | null;
}

export interface PersonRef {
  id: string;
  name: string | null;
}

export interface ChecklistItem {
  stepKey: string;
  label: string;
  labelL10n: Partial<Record<"en" | "ms" | "zh" | "ko", string>>;
  position: number;
  done: boolean;
  doneBy: PersonRef | null;
  doneAt: string | null;
  note: string | null;
}

export interface RequestFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  fieldKey: string | null;
  uploadedBy: PersonRef | null;
  uploadedAt: string;
}

export interface RequestEvent {
  id: string;
  kind: EventKind;
  at: string;
  actor: PersonRef | null;
  detail: Record<string, unknown>;
}

export interface RequestLinks {
  contact: { id: string; name: string | null } | null;
  conversationId: string | null;
  ticket: { id: string; number: number | null; subject: string | null } | null;
  incident: { id: string; number: number | null; title: string | null } | null;
  kycValidationRef: string | null;
}

/** One email about a case, as the screens show it (never the address or the text of a customer email's bank details: it has none). */
export interface NoticeSummary {
  kind: NoticeKind;
  audience: "customer" | "staff";
  status: "claimed" | "sent" | "failed" | "skipped";
  /** A named reason when it did not go. */
  detail: string | null;
  language: CustomerLocale | null;
  claimedAt: string;
  by: PersonRef | null;
}

export const NOTICE_KINDS = ["received", "more_info", "approved", "rejected", "completed", "signoff_waiting", "clock_alert"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The row of the list. */
export interface RequestSummary {
  id: string;
  reference: string;
  typeKey: string;
  typeLabel: string;
  typeLabelL10n: Partial<Record<"ms" | "zh" | "ko", string>>;
  status: RequestStatus;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  receivedAt: string;
  targetDays: number | null;
  hardStopDays: number | null;
  targetDueAt: string | null;
  hardStopAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  assignedTo: PersonRef | null;
  source: RequestSource;
  isTest: boolean;
}

/** What the viewer's permissions allow, computed on the server from the capabilities (menu.compliance is a given). */
export interface Viewer {
  userId: string;
  canReview: boolean;
  canApprove: boolean;
  canReveal: boolean;
  canExecute: boolean;
  canManage: boolean;
}

export interface SensitiveField {
  key: string;
  label: L10n;
  type: FieldType;
  /** The masked text (never the value). */
  masked: string;
  present: boolean;
}

export interface RequestDetail extends RequestSummary {
  channel: string | null;
  /** Migration 184. The language the customer's emails go out in. */
  customerLocale: CustomerLocale | null;
  /** Migration 184. When the customer proved the email address with the emailed code (the public form); null for a case staff made. */
  emailVerifiedAt: string | null;
  /** The emails the workspace sent about this case (the latest of each), for the "Notify the customer" panel. */
  notices: NoticeSummary[];
  type: RequestTypeRow | null;
  data: Record<string, unknown>;
  sensitive: SensitiveField[];
  /** False when the stored sensitive answers could not be decrypted (a key problem): the panel says so instead of showing nothing. */
  sensitiveReadable: boolean;
  identityCheck: IdentityCheck;
  review: ReviewRecord;
  signoff: SignoffRecord;
  standing: StandingRecord;
  outcomeReason: string | null;
  decidedAt: string | null;
  retentionUntil: string;
  links: RequestLinks;
  checklist: ChecklistItem[];
  files: RequestFile[];
  events: RequestEvent[];
  createdBy: PersonRef | null;
  viewer: Viewer;
}

export interface ListCounts {
  needsIdentityCheck: number;
  inReview: number;
  awaitingSignoff: number;
  executing: number;
  pastTarget: number;
  nearStop: number;
  breached: number;
  open: number;
}

export interface RequestList {
  rows: RequestSummary[];
  total: number;
  counts: ListCounts;
  types: { key: string; label: string; labelL10n: Partial<Record<"ms" | "zh" | "ko", string>>; active: boolean }[];
  people: PersonRef[];
  viewer: Viewer;
}

/** The error codes the routes answer with (the screens word each in four languages; the database's words are never passed on). */
export const ERROR_CODES = [
  "forbidden",
  "not_found",
  "invalid_request",
  "rate_limited",
  "invalid_transition",
  "maker_checker",
  "note_required",
  "identity_incomplete",
  "identity_not_passed",
  "recommendation_required",
  "dues_outstanding",
  "checklist_incomplete",
  "not_ready_to_execute",
  "frozen",
  "closed",
  "pause_not_allowed",
  "not_paused",
  "already_paused",
  "no_clock",
  "unsupported_file",
  "file_too_large",
  "too_many_files",
  "link_other_workspace",
  "type_unavailable",
  "assignee_cannot_see_requests",
  "validation_failed",
  "reveal_unavailable",
  "encryption_unavailable",
  "audit_failed",
  "storage_failed",
  "customer_reason_required",
  "category_required",
  "duplicate_open",
  "server_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
