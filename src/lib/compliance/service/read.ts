// ============================================================
// Compliance requests: reading. The list (filters, counts, paging), one case's detail (masked; a 'view' event is written first) and the
// definitions. Server only. Every query is scoped to the caller's workspace; the routes have already required menu.compliance.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { DUE_FILTERS, computeClock, inDueBucket, isFinished, type DueFilter } from "../clock";
import { complianceError } from "../errors";
import { normalisePhone, searchKind } from "../reference";
import { maskedFields, openSensitive } from "../secrets";
import {
  REQUEST_STATUSES,
  type ListCounts,
  type PersonRef,
  type RequestDetail,
  type RequestLinks,
  type RequestList,
  type RequestStatus,
  type RequestTypeRow,
} from "../types";
import { logEvent } from "./events";
import {
  CHECKLIST_COLUMNS,
  EVENT_COLUMNS,
  FILE_COLUMNS,
  NOTICE_COLUMNS,
  REQUEST_COLUMNS,
  checklistFromRow,
  eventFromRow,
  fileFromRow,
  identityOf,
  loadPeople,
  loadTypes,
  noticeFromRow,
  personRef,
  reviewOf,
  signoffOf,
  standingOf,
  summaryFromRow,
  type ChecklistDbRow,
  type ComplianceCaller,
  type EventDbRow,
  type FileDbRow,
  type NoticeDbRow,
  type RequestRow,
} from "./rows";

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;
/** The most cases one list or count reads. A workspace with more open than this needs the reports (Part B). */
export const READ_CAP = 5000;
export const EVENTS_CAP = 300;

const LIST_COLUMNS =
  "id, account_id, reference, type_key, status, received_at, source, channel, customer_name, customer_email, customer_phone, target_days, hard_stop_days, target_due_at, hard_stop_at, clock_paused_at, completed_at, closed_at, created_by, assigned_to, is_test";

export interface ListFilters {
  type?: string | null;
  statuses?: RequestStatus[];
  due?: DueFilter;
  /** A person's id, or "none" for unassigned. */
  assignee?: string | null;
  /** Assigned to the caller, or raised by them. */
  mine?: boolean;
  q?: string | null;
  /** ISO instants: received from (inclusive) to (exclusive). */
  from?: string | null;
  to?: string | null;
  page?: number;
  pageSize?: number;
}

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Read the list filters from a query string, ignoring anything that is not valid. */
export function parseListFilters(params: URLSearchParams): ListFilters {
  const statuses = (params.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is RequestStatus => (REQUEST_STATUSES as readonly string[]).includes(s));
  const due = params.get("due") ?? "all";
  const assignee = params.get("assignee");
  const num = (k: string, d: number, max: number) => {
    const n = Math.trunc(Number(params.get(k)));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : d;
  };
  return {
    type: /^[a-z][a-z0-9_]{1,39}$/.test(params.get("type") ?? "") ? params.get("type") : null,
    statuses,
    due: (DUE_FILTERS as readonly string[]).includes(due) ? (due as DueFilter) : "all",
    assignee: assignee === "none" || /^[0-9a-f-]{36}$/i.test(assignee ?? "") ? assignee : null,
    mine: params.get("mine") === "1",
    q: (params.get("q") ?? "").trim().slice(0, 100) || null,
    from: iso(params.get("from")),
    to: iso(params.get("to")),
    page: num("page", 1, 10_000),
    pageSize: num("page_size", PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX),
  };
}

/** Text safe to put inside a PostgREST or() filter: nothing that can add a condition or a wildcard of its own. */
export function searchTerm(q: string): string {
  return q.replace(/[,()%*\\_:"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function searchFilter(q: string): string | null {
  const kind = searchKind(q);
  const term = searchTerm(q);
  if (term === "") return null;
  if (kind === "reference") return `reference.ilike.%${term}%`;
  const parts = [`reference.ilike.%${term}%`, `customer_name.ilike.%${term}%`, `customer_email.ilike.%${term}%`];
  const phone = kind === "phone" ? normalisePhone(q) : null;
  if (phone) parts.push(`customer_phone.eq.${phone}`);
  else if (/^[+\d][\d\s().-]*$/.test(q.trim())) {
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 4) parts.push(`customer_phone.ilike.%${digits}%`);
  }
  return parts.join(",");
}

const listClock = (r: RequestRow) => ({
  status: r.status,
  receivedAt: r.received_at,
  targetDays: r.target_days,
  hardStopDays: r.hard_stop_days,
  targetDueAt: r.target_due_at,
  hardStopAt: r.hard_stop_at,
  pausedAt: r.clock_paused_at,
  completedAt: r.completed_at,
  closedAt: r.closed_at,
});

export function emptyCounts(): ListCounts {
  return { needsIdentityCheck: 0, inReview: 0, awaitingSignoff: 0, executing: 0, pastTarget: 0, nearStop: 0, breached: 0, open: 0 };
}

/** The header numbers, over every open case of the workspace (whatever the list is filtered to). Disjoint buckets: a case counts once on the clock chips. */
export function countOpen(rows: readonly Pick<RequestRow, "status" | "received_at" | "target_days" | "hard_stop_days" | "target_due_at" | "hard_stop_at" | "clock_paused_at" | "completed_at" | "closed_at">[], nowMs: number): ListCounts {
  const c = emptyCounts();
  for (const r of rows) {
    if (isFinished(r.status)) continue;
    c.open++;
    if (r.status === "received" || r.status === "identity_check") c.needsIdentityCheck++;
    else if (r.status === "officer_review") c.inReview++;
    else if (r.status === "awaiting_signoff") c.awaitingSignoff++;
    else if (r.status === "approved" || r.status === "executing") c.executing++;
    const state = computeClock(listClock(r as RequestRow), nowMs).state;
    if (state === "target_passed") c.pastTarget++;
    else if (state === "near_stop") c.nearStop++;
    else if (state === "breached") c.breached++;
  }
  return c;
}

export async function listRequests(admin: SupabaseClient, caller: ComplianceCaller, f: ListFilters, now: () => number = Date.now): Promise<RequestList> {
  const nowMs = now();
  let q = admin.from("compliance_requests").select(LIST_COLUMNS).eq("account_id", caller.accountId);
  if (f.type) q = q.eq("type_key", f.type);
  if (f.statuses && f.statuses.length > 0) q = q.in("status", f.statuses);
  if (f.assignee === "none") q = q.is("assigned_to", null);
  else if (f.assignee) q = q.eq("assigned_to", f.assignee);
  if (f.mine) q = q.or(`assigned_to.eq.${caller.userId},created_by.eq.${caller.userId}`);
  const search = f.q ? searchFilter(f.q) : null;
  if (search) q = q.or(search);
  if (f.from) q = q.gte("received_at", f.from);
  if (f.to) q = q.lt("received_at", f.to);
  const [listRes, openRes, types, people] = await Promise.all([
    q.order("received_at", { ascending: false }).limit(READ_CAP),
    admin
      .from("compliance_requests")
      .select("status, received_at, target_days, hard_stop_days, target_due_at, hard_stop_at, clock_paused_at, completed_at, closed_at")
      .eq("account_id", caller.accountId)
      .is("closed_at", null)
      .limit(READ_CAP),
    loadTypes(admin, caller.accountId),
    loadPeople(admin, caller.accountId),
  ]);
  if (listRes.error || openRes.error) throw complianceError("server_error");

  const byType = new Map(types.map((t) => [t.key, t]));
  const due = f.due ?? "all";
  const all = ((listRes.data ?? []) as unknown as RequestRow[]).filter((r) => inDueBucket(listClock(r), due, nowMs));
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, f.pageSize ?? PAGE_SIZE_DEFAULT));
  const page = Math.max(1, f.page ?? 1);
  const rows = all.slice((page - 1) * pageSize, page * pageSize).map((r) => summaryFromRow(r, byType.get(r.type_key), people));

  const holders = await holdersOf(admin, caller.accountId, "menu.compliance");
  const assignable: PersonRef[] = holders.map((id) => ({ id, name: people.get(id) ?? null })).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return {
    rows,
    total: all.length,
    counts: countOpen((openRes.data ?? []) as unknown as RequestRow[], nowMs),
    types: types.map((t) => ({ key: t.key, label: t.label, labelL10n: t.labelL10n, active: t.active })),
    people: assignable,
    viewer: caller.viewer,
  };
}

/** The people of the workspace who hold a capability (one database call). */
export async function holdersOf(admin: SupabaseClient, accountId: string, cap: string): Promise<string[]> {
  const { data, error } = await admin.rpc("compliance_holders", { p_account: accountId, p_cap: cap });
  if (error || !Array.isArray(data)) return [];
  return data as string[];
}

// ---- one case --------------------------------------------------------------------------------------------------------

async function linksOf(admin: SupabaseClient, accountId: string, r: RequestRow): Promise<RequestLinks> {
  const [contact, ticket, incident] = await Promise.all([
    r.contact_id ? admin.from("contacts").select("id, name").eq("id", r.contact_id).eq("account_id", accountId).maybeSingle() : Promise.resolve({ data: null }),
    r.ticket_id ? admin.from("tickets").select("id, ticket_number, subject").eq("id", r.ticket_id).eq("account_id", accountId).maybeSingle() : Promise.resolve({ data: null }),
    r.incident_id ? admin.from("incidents").select("id, incident_number, title").eq("id", r.incident_id).eq("account_id", accountId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const c = contact.data as { id: string; name: string | null } | null;
  const t = ticket.data as { id: string; ticket_number: number | null; subject: string | null } | null;
  const i = incident.data as { id: string; incident_number: number | null; title: string | null } | null;
  return {
    contact: c ? { id: c.id, name: c.name } : null,
    conversationId: r.conversation_id,
    ticket: t ? { id: t.id, number: t.ticket_number, subject: t.subject } : null,
    incident: i ? { id: i.id, number: i.incident_number, title: i.title } : null,
    kycValidationRef: r.kyc_validation_ref,
  };
}

export async function loadRow(admin: SupabaseClient, accountId: string, id: string): Promise<RequestRow> {
  const { data, error } = await admin.from("compliance_requests").select(REQUEST_COLUMNS).eq("id", id).eq("account_id", accountId).maybeSingle();
  if (error) throw complianceError("server_error");
  if (!data) throw complianceError("not_found");
  return data as unknown as RequestRow;
}

export async function loadType(admin: SupabaseClient, accountId: string, key: string): Promise<RequestTypeRow | undefined> {
  return (await loadTypes(admin, accountId)).find((t) => t.key === key);
}

/**
 * One case for the screen. Writes a 'view' event FIRST: when the trail cannot be written nothing is returned (the same rule as the KYC access log).
 * The sensitive answers come back as masks only.
 */
export async function getRequestDetail(admin: SupabaseClient, caller: ComplianceCaller, id: string, opts: { logView?: boolean } = {}): Promise<RequestDetail> {
  const row = await loadRow(admin, caller.accountId, id);
  if (opts.logView !== false && !(await logEvent(admin, { accountId: caller.accountId, requestId: row.id, actor: caller.userId, kind: "view" }))) {
    throw complianceError("audit_failed");
  }
  const [types, people, checklist, files, events, links, notices] = await Promise.all([
    loadTypes(admin, caller.accountId),
    loadPeople(admin, caller.accountId),
    admin.from("compliance_request_checklist").select(CHECKLIST_COLUMNS).eq("request_id", row.id).eq("account_id", caller.accountId).order("position", { ascending: true }),
    admin.from("compliance_request_files").select(FILE_COLUMNS).eq("request_id", row.id).eq("account_id", caller.accountId).order("uploaded_at", { ascending: true }),
    admin.from("compliance_request_events").select(EVENT_COLUMNS).eq("request_id", row.id).eq("account_id", caller.accountId).order("seq", { ascending: false }).limit(EVENTS_CAP),
    linksOf(admin, caller.accountId, row),
    admin.from("compliance_notices").select(NOTICE_COLUMNS).eq("request_id", row.id).eq("account_id", caller.accountId).order("claimed_at", { ascending: false }).limit(60),
  ]);
  const type = types.find((t) => t.key === row.type_key) ?? null;
  const summary = summaryFromRow(row, type ?? undefined, people);
  let sensitive: RequestDetail["sensitive"] = [];
  let sensitiveReadable = true;
  try {
    sensitive = maskedFields(type?.fields ?? [], openSensitive(row.id, row.data_enc));
  } catch {
    sensitiveReadable = false;
    sensitive = maskedFields(type?.fields ?? [], {});
  }
  return {
    ...summary,
    channel: row.channel,
    customerLocale: row.customer_locale,
    emailVerifiedAt: row.email_verified_at,
    notices: ((notices.data ?? []) as unknown as NoticeDbRow[]).map((n) => noticeFromRow(n, people)),
    type,
    data: (row.data ?? {}) as RequestDetail["data"],
    sensitive,
    sensitiveReadable,
    identityCheck: identityOf(row.identity_check),
    review: reviewOf(row.review),
    signoff: signoffOf(row.signoff),
    standing: standingOf(row.account_standing),
    outcomeReason: row.outcome_reason,
    decidedAt: row.decided_at,
    retentionUntil: row.retention_until,
    links,
    checklist: ((checklist.data ?? []) as unknown as ChecklistDbRow[]).map((c) => checklistFromRow(c, people)),
    files: ((files.data ?? []) as unknown as FileDbRow[]).map((f) => fileFromRow(f, people)),
    events: ((events.data ?? []) as unknown as EventDbRow[]).map((e) => eventFromRow(e, people)),
    createdBy: personRef(people, row.created_by),
    viewer: caller.viewer,
  };
}
