// ============================================================
// Compliance requests: database rows as the server reads them, and their mappers. Server only (it is imported by the services; the browser gets the
// mapped shapes from ../types).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { validateChecklist, validateFieldDefs } from "../fields";
import type {
  ChecklistItem,
  ChecklistTemplateItem,
  EventKind,
  FieldDef,
  IdentityCheck,
  PersonRef,
  RequestEvent,
  RequestFile,
  RequestSource,
  RequestStatus,
  RequestSummary,
  RequestTypeRow,
  ReviewRecord,
  SignoffRecord,
  StandingRecord,
  Viewer,
} from "../types";

export interface ComplianceCaller {
  accountId: string;
  userId: string;
  viewer: Viewer;
}

type Json = Record<string, unknown>;

export interface RequestRow {
  id: string;
  account_id: string;
  reference: string;
  type_key: string;
  status: RequestStatus;
  received_at: string;
  source: RequestSource;
  channel: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  ticket_id: string | null;
  incident_id: string | null;
  kyc_validation_ref: string | null;
  data: Json | null;
  data_enc: string | null;
  identity_check: Json | null;
  review: Json | null;
  signoff: Json | null;
  account_standing: Json | null;
  outcome_reason: string | null;
  target_days: number | null;
  hard_stop_days: number | null;
  target_due_at: string | null;
  hard_stop_at: string | null;
  clock_paused_at: string | null;
  decided_at: string | null;
  completed_at: string | null;
  closed_at: string | null;
  retention_until: string;
  created_by: string | null;
  assigned_to: string | null;
  is_test: boolean;
  created_at: string;
}

/** Every column the server reads (data_enc included: only the detail, the reveal and the edit use it). */
export const REQUEST_COLUMNS =
  "id, account_id, reference, type_key, status, received_at, source, channel, customer_name, customer_email, customer_phone, contact_id, conversation_id, ticket_id, incident_id, kyc_validation_ref, data, data_enc, identity_check, review, signoff, account_standing, outcome_reason, target_days, hard_stop_days, target_due_at, hard_stop_at, clock_paused_at, decided_at, completed_at, closed_at, retention_until, created_by, assigned_to, is_test, created_at";

export interface TypeDbRow {
  id: string;
  key: string;
  label: string;
  label_l10n: Json | null;
  fields: unknown;
  checklist: unknown;
  target_days: number | null;
  hard_stop_days: number | null;
  requires_identity_check: boolean;
  check_dues: boolean;
  allow_pause: boolean;
  active: boolean;
  is_system: boolean;
  position: number;
}
export const TYPE_COLUMNS = "id, key, label, label_l10n, fields, checklist, target_days, hard_stop_days, requires_identity_check, check_dues, allow_pause, active, is_system, position";

const l10nOf = (v: Json | null): RequestTypeRow["labelL10n"] => {
  const out: RequestTypeRow["labelL10n"] = {};
  for (const l of ["ms", "zh", "ko"] as const) if (typeof v?.[l] === "string" && v[l] !== "") out[l] = v[l] as string;
  return out;
};

export function typeFromRow(r: TypeDbRow): RequestTypeRow {
  const fields = validateFieldDefs(r.fields);
  const checklist = validateChecklist(r.checklist);
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    labelL10n: l10nOf(r.label_l10n),
    fields: fields.ok ? fields.fields : [],
    checklist: checklist.ok ? checklist.items : [],
    targetDays: r.target_days,
    hardStopDays: r.hard_stop_days,
    requiresIdentityCheck: r.requires_identity_check,
    checkDues: r.check_dues,
    allowPause: r.allow_pause,
    active: r.active,
    isSystem: r.is_system,
    position: r.position,
  };
}

export async function loadTypes(admin: SupabaseClient, accountId: string): Promise<RequestTypeRow[]> {
  const { data } = await admin.from("compliance_request_types").select(TYPE_COLUMNS).eq("account_id", accountId).order("position", { ascending: true }).limit(100);
  return ((data ?? []) as unknown as TypeDbRow[]).map(typeFromRow);
}

// ---- people ---------------------------------------------------------------------------------------------------------

export type PeopleMap = Map<string, string | null>;

/** The names of the workspace's members (profiles), by login id. A person who left is not here: the screens show "Former member". */
export async function loadPeople(admin: SupabaseClient, accountId: string): Promise<PeopleMap> {
  const { data } = await admin.from("profiles").select("user_id, full_name, email").eq("account_id", accountId).limit(500);
  const map: PeopleMap = new Map();
  for (const p of (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) map.set(p.user_id, (p.full_name?.trim() || p.email || "").trim() || null);
  return map;
}

export const personRef = (people: PeopleMap, id: string | null | undefined): PersonRef | null => (id ? { id, name: people.get(id) ?? null } : null);

// ---- records stored as JSON ----------------------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function identityOf(j: Json | null): IdentityCheck {
  const o = j ?? {};
  return {
    method: str(o.method) as IdentityCheck["method"] ?? undefined,
    methodOther: str(o.method_other),
    outcome: str(o.outcome) as IdentityCheck["outcome"] ?? undefined,
    notes: str(o.notes),
    verifiedBy: str(o.verified_by),
    recordedBy: str(o.recorded_by),
    verifiedAt: str(o.verified_at),
  };
}
export function reviewOf(j: Json | null): ReviewRecord {
  const o = j ?? {};
  return {
    recommendation: str(o.recommendation) as ReviewRecord["recommendation"] ?? undefined,
    notes: str(o.notes),
    by: str(o.by),
    at: str(o.at),
    sentBackAt: str(o.sent_back_at),
    sentBackBy: str(o.sent_back_by),
    sentBackNote: str(o.sent_back_note),
  };
}
export function signoffOf(j: Json | null): SignoffRecord {
  const o = j ?? {};
  return { decision: str(o.decision) as SignoffRecord["decision"] ?? undefined, by: str(o.by), at: str(o.at), reason: str(o.reason), overrideReason: str(o.override_reason) };
}
export function standingOf(j: Json | null): StandingRecord {
  const o = j ?? {};
  return {
    duesOutstanding: typeof o.dues_outstanding === "boolean" ? o.dues_outstanding : null,
    notes: str(o.notes),
    source: (str(o.source) as StandingRecord["source"]) ?? undefined,
    setBy: str(o.set_by),
    setAt: str(o.set_at),
  };
}

export function summaryFromRow(r: RequestRow, type: RequestTypeRow | undefined, people: PeopleMap): RequestSummary {
  return {
    id: r.id,
    reference: r.reference,
    typeKey: r.type_key,
    typeLabel: type?.label ?? r.type_key,
    typeLabelL10n: type?.labelL10n ?? {},
    status: r.status,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    customerPhone: r.customer_phone,
    receivedAt: r.received_at,
    targetDays: r.target_days,
    hardStopDays: r.hard_stop_days,
    targetDueAt: r.target_due_at,
    hardStopAt: r.hard_stop_at,
    pausedAt: r.clock_paused_at,
    completedAt: r.completed_at,
    closedAt: r.closed_at,
    assignedTo: personRef(people, r.assigned_to),
    source: r.source,
    isTest: r.is_test,
  };
}

export interface ChecklistDbRow {
  step_key: string;
  label: string;
  label_l10n: Json | null;
  position: number;
  done_by: string | null;
  done_at: string | null;
  note: string | null;
}
export const CHECKLIST_COLUMNS = "step_key, label, label_l10n, position, done_by, done_at, note";

export function checklistFromRow(r: ChecklistDbRow, people: PeopleMap): ChecklistItem {
  const l: ChecklistItem["labelL10n"] = {};
  for (const k of ["en", "ms", "zh", "ko"] as const) if (typeof r.label_l10n?.[k] === "string") l[k] = r.label_l10n[k] as string;
  return { stepKey: r.step_key, label: r.label, labelL10n: l, position: r.position, done: r.done_at !== null, doneBy: personRef(people, r.done_by), doneAt: r.done_at, note: r.note };
}

export interface FileDbRow {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  field_key: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
}
export const FILE_COLUMNS = "id, name, mime, size_bytes, field_key, uploaded_by, uploaded_at";
export const fileFromRow = (r: FileDbRow, people: PeopleMap): RequestFile => ({
  id: r.id,
  name: r.name,
  mime: r.mime,
  size: Number(r.size_bytes),
  fieldKey: r.field_key,
  uploadedBy: personRef(people, r.uploaded_by),
  uploadedAt: r.uploaded_at,
});

export interface EventDbRow {
  id: string;
  kind: EventKind;
  at: string;
  actor: string | null;
  detail: Json | null;
}
export const EVENT_COLUMNS = "id, kind, at, actor, detail";
export const eventFromRow = (r: EventDbRow, people: PeopleMap): RequestEvent => ({ id: r.id, kind: r.kind, at: r.at, actor: personRef(people, r.actor), detail: r.detail ?? {} });

/** Field definitions by key (a lookup for the services). */
export const fieldMap = (fields: readonly FieldDef[]): Map<string, FieldDef> => new Map(fields.map((f) => [f.key, f]));

export type { ChecklistTemplateItem };
