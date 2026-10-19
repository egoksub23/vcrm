// ============================================================
// KYC review: the access log (migration 182, kyc_access_log). Server only; the service role writes, nothing else does.
//
// What a row holds: the workspace, the person, WHAT they did (lookup, list, view_image, reveal, config_error, decision), the friend id as typed (trimmed,
// only if it passes the same check the route applies), the validation id, the outcome and, for a decision, approve or reject. It never holds an API key,
// an image, a field value, a reviewer's note, a vendor URL or anything the back end said. The writer builds the row from named arguments, so nothing else can slip in.
//
// The log is append-only in the database (a trigger), is not trimmed by any job, and is read by workspace admins and owners only.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { toCsv } from "@/lib/csv";

import { FRIEND_ID_RE, KYC_ACTIONS, KYC_OUTCOMES, VALIDATION_ID_RE, type KycAccessRow, type KycDecision } from "./types";

export type KycAction = (typeof KYC_ACTIONS)[number];
export type KycOutcome = (typeof KYC_OUTCOMES)[number];

export interface AccessLogInput {
  accountId: string;
  userId: string;
  action: KycAction;
  friendId?: string | null;
  validationId?: string | null;
  outcome: KycOutcome;
  /** Only on a 'decision' row: which decision (never the note). */
  decision?: KycDecision | null;
}

/** The friend id for the log: trimmed, and only when it is one the route would accept (so the log never holds free text). */
export function logFriendId(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return FRIEND_ID_RE.test(t) ? t : null;
}

export function logValidationId(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return VALIDATION_ID_RE.test(t) ? t : null;
}

/** Write one row. Returns false when it could not be written (the caller then refuses to show anything: the log is never skipped). */
export async function writeAccessLog(admin: SupabaseClient, input: AccessLogInput): Promise<boolean> {
  try {
    const { error } = await admin.from("kyc_access_log").insert({
      account_id: input.accountId,
      user_id: input.userId,
      action: input.action,
      friend_id: logFriendId(input.friendId),
      validation_id: logValidationId(input.validationId),
      outcome: input.outcome,
      decision: input.decision ?? null,
    });
    if (error) {
      console.error("[kyc] access log write failed");
      return false;
    }
    return true;
  } catch {
    console.error("[kyc] access log write failed");
    return false;
  }
}

// ------------------------------------------------------------
// Reading (admins and owners; the route checks)
// ------------------------------------------------------------
export interface AccessLogFilters {
  userId?: string | null;
  friendId?: string | null;
  action?: KycAction | null;
  /** ISO timestamps; from inclusive, to exclusive. */
  from?: string | null;
  to?: string | null;
  /** Rows older than this timestamp only (the next page). */
  before?: string | null;
}

export const EXPORT_MAX_ROWS = 5000;
export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the filters from a query string, ignoring anything that is not valid. */
export function parseLogFilters(params: URLSearchParams): AccessLogFilters {
  const iso = (k: string): string | null => {
    const v = params.get(k);
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  const user = params.get("user_id");
  const action = params.get("action");
  return {
    userId: user && UUID_RE.test(user) ? user : null,
    friendId: logFriendId(params.get("friend_id")),
    action: action && (KYC_ACTIONS as readonly string[]).includes(action) ? (action as KycAction) : null,
    from: iso("from"),
    to: iso("to"),
    before: iso("before"),
  };
}

interface LogDbRow {
  id: string;
  created_at: string;
  user_id: string | null;
  action: KycAccessRow["action"];
  friend_id: string | null;
  validation_id: string | null;
  outcome: KycAccessRow["outcome"];
  decision: KycAccessRow["decision"];
}

export interface AccessLogPerson {
  id: string;
  name: string;
}

async function peopleOf(admin: SupabaseClient, accountId: string): Promise<AccessLogPerson[]> {
  const { data } = await admin.from("profiles").select("user_id, full_name, email").eq("account_id", accountId).limit(500);
  return ((data ?? []) as { user_id: string; full_name: string | null; email: string | null }[])
    .map((p) => ({ id: p.user_id, name: (p.full_name?.trim() || p.email || "").trim() }))
    .filter((p) => p.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A page of the log, newest first, with the people's names. */
export async function listAccessLog(
  admin: SupabaseClient,
  accountId: string,
  filters: AccessLogFilters,
  limit: number = PAGE_DEFAULT,
): Promise<{ rows: KycAccessRow[]; people: AccessLogPerson[]; hasMore: boolean } | null> {
  const size = Math.max(1, Math.min(PAGE_MAX, Math.trunc(limit)));
  const rows = await selectRows(admin, accountId, filters, size + 1);
  if (rows === null) return null;
  const people = await peopleOf(admin, accountId);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const page = rows.slice(0, size).map((r) => toRow(r, names));
  return { rows: page, people, hasMore: rows.length > size };
}

async function selectRows(admin: SupabaseClient, accountId: string, f: AccessLogFilters, max: number): Promise<LogDbRow[] | null> {
  let q = admin
    .from("kyc_access_log")
    .select("id, created_at, user_id, action, friend_id, validation_id, outcome, decision")
    .eq("account_id", accountId);
  if (f.userId) q = q.eq("user_id", f.userId);
  if (f.friendId) q = q.eq("friend_id", f.friendId);
  if (f.action) q = q.eq("action", f.action);
  if (f.from) q = q.gte("created_at", f.from);
  if (f.to) q = q.lt("created_at", f.to);
  if (f.before) q = q.lt("created_at", f.before);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(max);
  if (error) return null;
  return (data ?? []) as LogDbRow[];
}

function toRow(r: LogDbRow, names: Map<string, string>): KycAccessRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    userId: r.user_id,
    userName: r.user_id ? (names.get(r.user_id) ?? null) : null,
    action: r.action,
    friendId: r.friend_id,
    validationId: r.validation_id,
    outcome: r.outcome,
    decision: r.decision ?? null,
  };
}

export const CSV_HEADER = ["Time (UTC)", "Person", "Person ID", "Action", "Friend ID", "Validation ID", "Outcome", "Decision"] as const;

/** The CSV of the log under the same filters, newest first, at most EXPORT_MAX_ROWS rows. Cells that start with = + - @ are guarded by toCsv. */
export async function exportAccessLogCsv(admin: SupabaseClient, accountId: string, filters: AccessLogFilters): Promise<{ csv: string; rows: number; truncated: boolean } | null> {
  const rows = await selectRows(admin, accountId, { ...filters, before: filters.before ?? null }, EXPORT_MAX_ROWS + 1);
  if (rows === null) return null;
  const people = await peopleOf(admin, accountId);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const kept = rows.slice(0, EXPORT_MAX_ROWS);
  const lines = [
    [...CSV_HEADER],
    ...kept.map((r) => [r.created_at, (r.user_id && names.get(r.user_id)) || "", r.user_id ?? "", r.action, r.friend_id ?? "", r.validation_id ?? "", r.outcome, r.decision ?? ""]),
  ];
  return { csv: toCsv(lines), rows: kept.length, truncated: rows.length > EXPORT_MAX_ROWS };
}
