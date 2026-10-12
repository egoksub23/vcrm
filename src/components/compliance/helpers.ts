// ============================================================
// Compliance requests, the screens' pure helpers: no React, no DOM, no network, so each can be tested without a browser.
// (There is no DOM renderer in this repo's tests; what is NOT covered by a test is listed in docs/compliance-requests.md.)
// ============================================================

import type { ClockView } from "@/lib/compliance/clock";
import { l10n } from "@/lib/compliance/fields";
import type { DisabledReason } from "@/lib/compliance/transitions";
import type { EventKind, FieldDef, L10n, RequestEvent, RequestStatus, RequestSummary } from "@/lib/compliance/types";

/** Revealed bank details are hidden again after this long. */
export const REVEAL_MS = 2 * 60_000;

/** Have the revealed values run out? `until` is null when nothing is revealed. */
export const revealExpired = (until: number | null, now: number): boolean => until !== null && now >= until;

/** Seconds left of a reveal (rounded up, never below 0). */
export const revealSecondsLeft = (until: number | null, now: number): number => (until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000)));

// ---- status and clock words -------------------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "warn" | "ok" | "danger";

export const STATUS_TONE: Record<RequestStatus, Tone> = {
  received: "info",
  identity_check: "info",
  officer_review: "info",
  awaiting_signoff: "warn",
  approved: "ok",
  rejected: "danger",
  executing: "info",
  completed: "ok",
  closed: "neutral",
};

/** What to say about the clock in one line, as a message key and its values (the screen translates it). */
export interface ClockLine {
  /** Keys under Compliance.clock */
  key: "none" | "paused" | "done" | "dayOf" | "dayOnly" | "stopOnly";
  values: Record<string, number>;
  /** The second part ("21 days to stop", "3 days past the stop"), or null. */
  stop: { key: "toStop" | "stopToday" | "overStop"; count: number } | null;
}

export function clockLine(v: ClockView): ClockLine {
  const day = v.dayNumber;
  if (v.state === "done") return { key: "done", values: { days: v.tookDays ?? day }, stop: null };
  const stop: ClockLine["stop"] =
    v.daysToStop === null ? null : v.state === "breached" ? (v.daysOverStop > 0 ? { key: "overStop", count: v.daysOverStop } : { key: "stopToday", count: 0 }) : { key: "toStop", count: Math.max(1, v.daysToStop) };
  if (v.state === "paused") return { key: "paused", values: { day }, stop };
  if (v.state === "none") return { key: "none", values: { day }, stop: null };
  if (v.targetDays !== null) return { key: "dayOf", values: { day, target: v.targetDays }, stop };
  return { key: stop ? "stopOnly" : "dayOnly", values: { day }, stop };
}

/** The chip's message key and tone for a clock state (the word is always shown with it). */
export const CLOCK_TONE: Record<ClockView["state"], Tone> = {
  none: "neutral",
  on_track: "ok",
  target_passed: "warn",
  near_stop: "danger",
  breached: "danger",
  paused: "neutral",
  done: "neutral",
};

// ---- the list's filters, as the screen keeps them --------------------------------------------------------------------

export interface Filters {
  type: string;
  status: string;
  due: string;
  assignee: string;
  mine: boolean;
  q: string;
  from: string;
  to: string;
  page: number;
}

export const EMPTY_FILTERS: Filters = { type: "", status: "", due: "all", assignee: "", mine: false, q: "", from: "", to: "", page: 1 };

export const hasFilters = (f: Filters): boolean => f.type !== "" || f.status !== "" || f.due !== "all" || f.assignee !== "" || f.mine || f.q.trim() !== "" || f.from !== "" || f.to !== "";

/** The header chips, each one a filter. */
export const HEADER_CHIPS = [
  { key: "needsIdentityCheck", patch: { status: "received,identity_check", due: "all" } },
  { key: "inReview", patch: { status: "officer_review", due: "all" } },
  { key: "awaitingSignoff", patch: { status: "awaiting_signoff", due: "all" } },
  { key: "executing", patch: { status: "approved,executing", due: "all" } },
  { key: "pastTarget", patch: { status: "", due: "target_passed" } },
  { key: "nearStop", patch: { status: "", due: "near_stop" } },
  { key: "breached", patch: { status: "", due: "breached" } },
] as const;
export type HeaderChipKey = (typeof HEADER_CHIPS)[number]["key"];

/** Is this header chip the active filter? */
export function chipActive(chip: (typeof HEADER_CHIPS)[number], f: Filters): boolean {
  return f.status === chip.patch.status && f.due === chip.patch.due;
}

/** Click a header chip: apply its filter, or clear it when it is already the active one. */
export function toggleChip(chip: (typeof HEADER_CHIPS)[number], f: Filters): Filters {
  return chipActive(chip, f) ? { ...f, status: "", due: "all", page: 1 } : { ...f, ...chip.patch, page: 1 };
}

// ---- labels ----------------------------------------------------------------------------------------------------------

export const typeLabel = (r: Pick<RequestSummary, "typeLabel" | "typeLabelL10n">, locale: string): string => {
  const v = (r.typeLabelL10n as Record<string, string | undefined>)[locale];
  return v && v.trim() !== "" ? v : r.typeLabel;
};

export const fieldLabel = (f: Pick<FieldDef, "label" | "key">, locale: string): string => l10n(f.label as L10n, locale, f.key);

export const FORMER_MEMBER = null;

/** The message key (under Compliance.blocked) that explains why an action is switched off. */
export const blockedKey = (reason: DisabledReason): string => reason;

// ---- the timeline ----------------------------------------------------------------------------------------------------

export interface EventLine {
  /** Key under Compliance.timeline.kinds (with a variant when the detail asks for one). */
  key: string;
  values: Record<string, string | number>;
  /** The note the person typed, if the event carries one. */
  text: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What to say about an event: a message key, its values and the note. Never throws on an unexpected detail. */
export function eventLine(e: Pick<RequestEvent, "kind" | "detail">): EventLine {
  const d = e.detail ?? {};
  const kind: EventKind = e.kind;
  switch (kind) {
    case "status":
      return { key: "status", values: { from: str(d.from), to: str(d.to) }, text: str(d.note) || null };
    case "note":
      return { key: "note", values: {}, text: str(d.text) || null };
    case "identity_check":
      return { key: "identity_check", values: { method: str(d.method), outcome: str(d.outcome) }, text: null };
    case "review":
      return { key: "review", values: { recommendation: str(d.recommendation) }, text: null };
    case "signoff":
      return { key: d.override === true ? "signoff_override" : "signoff", values: { decision: str(d.decision) }, text: null };
    case "execute_step":
      return { key: d.done === false ? "step_undone" : "step_done", values: { step: str(d.step) }, text: str(d.note) || null };
    case "reveal":
      return { key: d.allowed === false ? "reveal_refused" : "reveal", values: {}, text: null };
    case "view":
      return { key: str(d.file) ? "view_file" : "view", values: { name: str(d.name) }, text: null };
    case "attachment":
      return { key: "attachment", values: { name: str(d.name) }, text: null };
    case "link":
      return { key: "link", values: { field: str(d.field) }, text: null };
    case "edited":
      return { key: "edited", values: { fields: Array.isArray(d.fields) ? (d.fields as string[]).join(", ") : "" }, text: null };
    case "standing":
      return { key: d.dues_outstanding === true ? "standing_dues" : "standing_clear", values: {}, text: null };
    case "clock_pause":
      return { key: "clock_pause", values: {}, text: str(d.note) || null };
    case "clock_resume":
      return { key: "clock_resume", values: {}, text: str(d.note) || null };
    case "clock_alert":
      return { key: "clock_alert", values: { threshold: typeof d.threshold === "number" ? d.threshold : 0 }, text: null };
    case "notice":
      return {
        key: d.status === "failed" ? "notice_failed" : d.status === "skipped" ? "notice_skipped" : "notice_sent",
        values: { notice: str(d.notice), audience: str(d.audience), reason: str(d.reason), count: typeof d.recipients === "number" ? d.recipients : 0 },
        text: str(d.text) || null,
      };
    case "created":
      return { key: d.backdated === true ? "created_backdated" : "created", values: { source: str(d.source) }, text: null };
    case "assigned":
      return { key: d.to ? "assigned" : "unassigned", values: {}, text: null };
    default:
      return { key: "other", values: {}, text: null };
  }
}

/** A timeline entry: an event, and how many 'opened the case' events of the same person it stands for (1 for any other event). */
export type TimelineEntry = RequestEvent & { count: number };

/**
 * The timeline shows what happened, not every time the page loaded: 'view' events of the same person on the case itself (not a file) within
 * `windowMs` of each other are shown as one entry ("opened the case, 4 times"), dated at the latest. The events themselves are all kept.
 * `events` is newest first, as the server sends them.
 */
export function collapseViews(events: readonly RequestEvent[], windowMs = 10 * 60_000): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const e of events) {
    const plainView = e.kind === "view" && !(e.detail && e.detail.file);
    const prev = out[out.length - 1];
    if (plainView && prev && prev.kind === "view" && !(prev.detail && prev.detail.file) && prev.actor?.id === e.actor?.id) {
      const gap = Math.abs(Date.parse(prev.at) - Date.parse(e.at));
      if (Number.isFinite(gap) && gap <= windowMs) {
        prev.count += 1;
        continue;
      }
    }
    out.push({ ...e, count: 1 });
  }
  return out;
}

// ---- time ------------------------------------------------------------------------------------------------------------

export function formatWhen(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(t));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

export function formatDay(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(t));
  } catch {
    return iso.slice(0, 10);
  }
}

/** A <input type="datetime-local"> value (the browser's local time) as an ISO instant, or "" when empty or not a date. */
export function localInputToIso(v: string): string {
  if (!v) return "";
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

// ---- the New request form ----------------------------------------------------------------------------------------------

export type FormValues = Record<string, string | boolean>;

/** The starting values of the form for a type: ticks off, text empty. */
export function emptyForm(fields: readonly FieldDef[]): FormValues {
  const out: FormValues = {};
  for (const f of fields) if (f.type !== "file") out[f.key] = f.type === "acknowledge" ? false : "";
  return out;
}

/** The answers to send: what was typed, without the empty ones (the server says which required ones are missing). */
export function answersFromForm(fields: readonly FieldDef[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "file") continue;
    const v = values[f.key];
    if (f.type === "acknowledge") out[f.key] = v === true;
    else if (typeof v === "string" && v.trim() !== "") out[f.key] = v.trim();
  }
  return out;
}

/** Which required fields are still empty (for the "N required fields" hint and disabling Create). */
export function missingRequired(fields: readonly FieldDef[], values: FormValues): string[] {
  return fields
    .filter((f) => f.required && f.type !== "file")
    .filter((f) => (f.type === "acknowledge" ? values[f.key] !== true : typeof values[f.key] !== "string" || (values[f.key] as string).trim() === ""))
    .map((f) => f.key);
}

/** The code of an API failure as the key of its words under Compliance.errors (an unknown code reads as the generic one). */
const KNOWN_ERRORS = new Set([
  "forbidden", "not_found", "invalid_request", "rate_limited", "invalid_transition", "maker_checker", "note_required", "identity_incomplete", "identity_not_passed",
  "recommendation_required", "dues_outstanding", "checklist_incomplete", "not_ready_to_execute", "frozen", "closed", "pause_not_allowed", "not_paused", "already_paused",
  "no_clock", "unsupported_file", "file_too_large", "too_many_files", "link_other_workspace", "type_unavailable", "assignee_cannot_see_requests", "validation_failed",
  "reveal_unavailable", "encryption_unavailable", "audit_failed", "storage_failed", "customer_reason_required", "category_required", "duplicate_open", "server_error", "network",
]);
export const errorKey = (code: string): string => (KNOWN_ERRORS.has(code) ? code : "server_error");
