// ============================================================
// Compliance requests, the reports: reading the cases for them and the export. Server only. The figures themselves are pure (../reports.ts).
//
// Who: compliance.review or compliance.approve (the routes check; this checks again). What: the cases REQUESTED in the date range of the workspace, at
// most REPORT_CAP of them (the newest; the answer says when there were more). The export is written to the exports log FIRST (who, the filters, how
// many rows): when the log cannot be written nothing is returned, the same rule as the KYC access log and as revealing a bank detail.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { complianceError } from "../errors";
import { REPORT_CAP, buildCsv, buildReport, type ComplianceReport, type ReportFilters, type ReportRow } from "../reports";
import { REQUEST_STATUSES } from "../types";
import { loadPeople, loadTypes, type ComplianceCaller } from "./rows";

const COLUMNS = "reference, type_key, source, status, received_at, target_due_at, hard_stop_at, decided_at, completed_at, closed_at, signoff";

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The filters of a request's query string, ignoring anything that is not valid. */
export function parseReportFilters(params: URLSearchParams): ReportFilters {
  const type = params.get("type") ?? "";
  return { from: iso(params.get("from")), to: iso(params.get("to")), type: /^[a-z][a-z0-9_]{1,39}$/.test(type) ? type : null };
}

const mayRead = (caller: ComplianceCaller) => caller.viewer.canReview || caller.viewer.canApprove;

async function readRows(admin: SupabaseClient, caller: ComplianceCaller, f: ReportFilters): Promise<{ rows: ReportRow[]; truncated: boolean }> {
  let q = admin.from("compliance_requests").select(COLUMNS).eq("account_id", caller.accountId);
  if (f.type) q = q.eq("type_key", f.type);
  if (f.from) q = q.gte("received_at", f.from);
  if (f.to) q = q.lt("received_at", f.to);
  const { data, error } = await q.order("received_at", { ascending: false }).limit(REPORT_CAP + 1);
  if (error) throw complianceError("server_error");
  const all = ((data ?? []) as unknown as ReportRow[]).filter((r) => (REQUEST_STATUSES as readonly string[]).includes(r.status));
  return { rows: all.slice(0, REPORT_CAP), truncated: all.length > REPORT_CAP };
}

export async function loadReport(admin: SupabaseClient, caller: ComplianceCaller, filters: ReportFilters, now: () => number = Date.now): Promise<ComplianceReport> {
  if (!mayRead(caller)) throw complianceError("forbidden");
  const [{ rows, truncated }, types, people] = await Promise.all([readRows(admin, caller, filters), loadTypes(admin, caller.accountId), loadPeople(admin, caller.accountId)]);
  const report = buildReport(rows, now(), { filters, truncated });
  const named = new Set(report.signoffs.map((s) => s.by));
  return {
    ...report,
    types: types.map((t) => ({ key: t.key, label: t.label, labelL10n: t.labelL10n })),
    people: [...named].map((id) => ({ id, name: people.get(id) ?? null })),
  };
}

export interface ExportResult {
  csv: string;
  rows: number;
  truncated: boolean;
}

/** The CSV of the cases in the range. The exports log is written first; if it cannot be, nothing is returned. */
export async function exportReportCsv(admin: SupabaseClient, caller: ComplianceCaller, filters: ReportFilters): Promise<ExportResult> {
  if (!mayRead(caller)) throw complianceError("forbidden");
  const { rows, truncated } = await readRows(admin, caller, filters);
  const logged = await admin.from("compliance_exports").insert({
    account_id: caller.accountId,
    actor: caller.userId,
    kind: "csv",
    filters: { from: filters.from, to: filters.to, type: filters.type },
    row_count: rows.length,
    truncated,
  });
  if (logged.error) {
    console.error("[compliance] an export could not be recorded");
    throw complianceError("audit_failed");
  }
  const types = new Map((await loadTypes(admin, caller.accountId)).map((t) => [t.key, t.label]));
  return { csv: buildCsv(rows, (k) => types.get(k) ?? k), rows: rows.length, truncated };
}

/**
 * The number on the sidebar badge: what is waiting for THIS person. A holder of compliance.approve counts the cases awaiting sign-off they could sign
 * (not one whose identity check they recorded); a holder of compliance.review counts the cases waiting for an identity check or an officer's review.
 * A person with both counts both. Zero for anyone else.
 */
export async function badgeCount(admin: SupabaseClient, caller: ComplianceCaller): Promise<number> {
  const { canApprove, canReview } = caller.viewer;
  if (!canApprove && !canReview) return 0;
  const statuses = [...(canApprove ? ["awaiting_signoff"] : []), ...(canReview ? ["received", "identity_check", "officer_review"] : [])];
  const { data, error } = await admin.from("compliance_requests").select("status, identity_check").eq("account_id", caller.accountId).in("status", statuses).limit(2000);
  if (error) throw complianceError("server_error");
  let n = 0;
  for (const r of (data ?? []) as { status: string; identity_check: { verified_by?: string; recorded_by?: string } | null }[]) {
    if (r.status === "awaiting_signoff") {
      const did = r.identity_check?.verified_by === caller.userId || r.identity_check?.recorded_by === caller.userId;
      if (!did) n++;
    } else n++;
  }
  return n;
}
