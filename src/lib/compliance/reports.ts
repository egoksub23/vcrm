// ============================================================
// Compliance requests, the reports (Part B): the numbers and the CSV, as PURE functions over the cases' rows (no I/O, no Node imports, so the page and
// the tests use them without a database). The server reads the rows (service/reports.ts) and these decide what they mean.
//
// The questions the Head of Compliance and an auditor ask:
//   how many cases of each type, and in which status
//   for the cases that have a regulatory clock: how many were completed within the practice target, how many after it but within the stop, how many
//     after the stop, and how many are still open past it
//   how long it takes: the average and the median days from the request to the decision, and from the request to completion
//   who signed off, how many approved and how many rejected
//   why rejected: the categories the Head chose
//   how old the open cases are
//
// A case belongs to the report when it was REQUESTED inside the date range (received_at), so every figure is about the same set of cases. What an
// export carries: the reference, type, source, status and the dates; never a name, a phone number, an email address, a bank detail or a reason.
// ============================================================

import { csvCell } from "@/lib/sign/lists/csv";

import { FINISHED_STATUSES, REJECTION_CATEGORIES, REQUEST_STATUSES, type RejectionCategory, type RequestSource, type RequestStatus } from "./types";

/** What the report reads from each case. */
export interface ReportRow {
  reference: string;
  type_key: string;
  source: RequestSource;
  status: RequestStatus;
  received_at: string;
  target_due_at: string | null;
  hard_stop_at: string | null;
  decided_at: string | null;
  completed_at: string | null;
  closed_at: string | null;
  signoff: Record<string, unknown> | null;
}

export interface ReportFilters {
  /** ISO instants: requested from (inclusive) to (exclusive). */
  from: string | null;
  to: string | null;
  type: string | null;
}

/** The most rows a report reads and an export writes. */
export const REPORT_CAP = 5000;
const DAY = 86_400_000;

export interface Stat {
  count: number;
  /** Days, one decimal; null when there is nothing to average. */
  average: number | null;
  median: number | null;
}

export const AGEING_BUCKETS = ["d0_7", "d8_14", "d15_30", "d31_plus"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export type RejectionBucket = RejectionCategory | "uncategorised";

export interface ComplianceReport {
  filters: ReportFilters;
  generatedAt: string;
  /** The range held more cases than a report reads: the figures are about the newest REPORT_CAP of them. */
  truncated: boolean;
  total: number;
  open: number;
  finished: number;
  byType: { key: string; total: number; byStatus: Record<RequestStatus, number> }[];
  /** Cases of types that have a clock (a target and a stop). */
  clock: { considered: number; withinTarget: number; afterTarget: number; afterStop: number; openPastStop: number };
  timing: { toDecision: Stat; toCompletion: Stat };
  signoffs: { by: string; approved: number; rejected: number }[];
  rejections: { category: RejectionBucket; count: number }[];
  ageing: { bucket: AgeingBucket; count: number }[];
  types: { key: string; label: string; labelL10n: Partial<Record<"ms" | "zh" | "ko", string>> }[];
  people: { id: string; name: string | null }[];
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function stat(days: number[]): Stat {
  if (days.length === 0) return { count: 0, average: null, median: null };
  const sorted = [...days].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { count: days.length, average: round1(days.reduce((a, b) => a + b, 0) / days.length), median: round1(median) };
}

const emptyStatus = (): Record<RequestStatus, number> => Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<RequestStatus, number>;

export const isFinished = (s: RequestStatus): boolean => (FINISHED_STATUSES as readonly string[]).includes(s);

/** Which age bucket an open case is in. */
export function ageingBucket(receivedAt: string, nowMs: number): AgeingBucket {
  const days = Math.max(0, Math.floor((nowMs - (ms(receivedAt) ?? nowMs)) / DAY));
  return days <= 7 ? "d0_7" : days <= 14 ? "d8_14" : days <= 30 ? "d15_30" : "d31_plus";
}

const categoryOf = (v: unknown): RejectionBucket => ((REJECTION_CATEGORIES as readonly string[]).includes(String(v)) ? (v as RejectionCategory) : "uncategorised");

/** The figures. `nowMs` is a parameter so the same rows give the same report in a test. */
export function buildReport(rows: readonly ReportRow[], nowMs: number, meta: { filters: ReportFilters; truncated?: boolean }): Omit<ComplianceReport, "types" | "people"> {
  const byType = new Map<string, { key: string; total: number; byStatus: Record<RequestStatus, number> }>();
  const clock = { considered: 0, withinTarget: 0, afterTarget: 0, afterStop: 0, openPastStop: 0 };
  const toDecision: number[] = [];
  const toCompletion: number[] = [];
  const signoffs = new Map<string, { by: string; approved: number; rejected: number }>();
  const rejections = new Map<RejectionBucket, number>();
  const ageing = new Map<AgeingBucket, number>(AGEING_BUCKETS.map((b) => [b, 0]));
  let open = 0;

  for (const r of rows) {
    const t = byType.get(r.type_key) ?? { key: r.type_key, total: 0, byStatus: emptyStatus() };
    t.total++;
    t.byStatus[r.status] = (t.byStatus[r.status] ?? 0) + 1;
    byType.set(r.type_key, t);

    const received = ms(r.received_at);
    const decided = ms(r.decided_at);
    const completed = ms(r.completed_at);
    if (received !== null && decided !== null && decided >= received) toDecision.push((decided - received) / DAY);
    if (received !== null && completed !== null && completed >= received) toCompletion.push((completed - received) / DAY);

    const target = ms(r.target_due_at);
    const stop = ms(r.hard_stop_at);
    if (target !== null && stop !== null) {
      if (completed !== null) {
        clock.considered++;
        if (completed <= target) clock.withinTarget++;
        else if (completed <= stop) clock.afterTarget++;
        else clock.afterStop++;
      } else if (!isFinished(r.status) && r.status !== "rejected" && nowMs > stop) {
        // still open and past the stop (a rejected case waiting to be closed has no work left to be late with)
        clock.considered++;
        clock.openPastStop++;
      }
    }

    const so = r.signoff ?? {};
    const by = typeof so.by === "string" ? so.by : null;
    if (by && (so.decision === "approved" || so.decision === "rejected")) {
      const p = signoffs.get(by) ?? { by, approved: 0, rejected: 0 };
      if (so.decision === "approved") p.approved++;
      else p.rejected++;
      signoffs.set(by, p);
    }
    if (so.decision === "rejected") {
      const c = categoryOf(so.reason_category);
      rejections.set(c, (rejections.get(c) ?? 0) + 1);
    }

    if (!isFinished(r.status)) {
      open++;
      const b = ageingBucket(r.received_at, nowMs);
      ageing.set(b, (ageing.get(b) ?? 0) + 1);
    }
  }

  return {
    filters: meta.filters,
    generatedAt: new Date(nowMs).toISOString(),
    truncated: meta.truncated === true,
    total: rows.length,
    open,
    finished: rows.length - open,
    byType: [...byType.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key)),
    clock,
    timing: { toDecision: stat(toDecision), toCompletion: stat(toCompletion) },
    signoffs: [...signoffs.values()].sort((a, b) => b.approved + b.rejected - (a.approved + a.rejected) || a.by.localeCompare(b.by)),
    rejections: [...rejections.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    ageing: AGEING_BUCKETS.map((bucket) => ({ bucket, count: ageing.get(bucket) ?? 0 })),
  };
}

// ---- the CSV ----------------------------------------------------------------------------------------------------------------

export const CSV_COLUMNS = ["reference", "type", "source", "status", "received_at", "target_due_at", "hard_stop_at", "decided_at", "completed_at", "days_to_complete", "outcome"] as const;

/** How a case ended up, in one word: open, approved (being carried out), rejected, completed, or closed_without_decision. */
export type Outcome = "open" | "approved" | "rejected" | "completed" | "closed_without_decision";

export function outcomeOf(r: Pick<ReportRow, "status" | "completed_at" | "signoff">): Outcome {
  const decision = r.signoff?.decision;
  if (r.completed_at || r.status === "completed") return "completed";
  if (decision === "rejected") return "rejected";
  if (r.status === "closed") return "closed_without_decision";
  if (decision === "approved") return "approved";
  return "open";
}

const iso = (v: string | null | undefined): string => {
  const t = ms(v);
  return t === null ? "" : new Date(t).toISOString();
};

/** Whole days from the request to completion, one decimal; blank when it is not complete. */
export function daysToComplete(r: Pick<ReportRow, "received_at" | "completed_at">): string {
  const a = ms(r.received_at);
  const b = ms(r.completed_at);
  return a === null || b === null || b < a ? "" : String(round1((b - a) / DAY));
}

/**
 * The export. One row per case, the columns above, a byte order mark (so a spreadsheet opens it as UTF-8) and a cell that starts like a formula made
 * harmless. NO name, phone number, email address, bank detail, reason or note: a person reading an export can find the case in Halo by its reference.
 */
export function buildCsv(rows: readonly ReportRow[], typeLabel: (key: string) => string = (k) => k): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows.slice(0, REPORT_CAP)) {
    lines.push(
      [r.reference, typeLabel(r.type_key), r.source, r.status, iso(r.received_at), iso(r.target_due_at), iso(r.hard_stop_at), iso(r.decided_at), iso(r.completed_at), daysToComplete(r), outcomeOf(r)].map(csvCell).join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
