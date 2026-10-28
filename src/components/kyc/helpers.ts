// ============================================================
// KYC review, the screen's pure helpers: no React, no DOM, no network, so each can be tested without a browser.
// (There is no DOM renderer in this repo's tests; what is NOT covered by a test is listed in docs/kyc-review.md.)
// ============================================================

import { reviewKind } from "@/lib/kyc/review";
import type { KycDocType, KycErrorCode, KycReviewStatus, KycValidation, StatusTone } from "@/lib/kyc/types";

/** The ID image is covered after this long without any interaction with it. */
export const IDLE_COVER_MS = 3 * 60_000;
/** Revealed values are hidden again after this long. */
export const REVEAL_MS = 2 * 60_000;

export interface IdleInput {
  /** When the reviewer last touched the viewer (ms since the epoch). */
  lastActivity: number;
  now: number;
  /** The browser tab is hidden. */
  hidden: boolean;
  idleMs?: number;
}

/** Should the image be hidden behind the "Click to show" cover? True when the tab is hidden, or after three minutes of nothing. */
export function shouldCover({ lastActivity, now, hidden, idleMs = IDLE_COVER_MS }: IdleInput): boolean {
  if (hidden) return true;
  return now - lastActivity >= idleMs;
}

/** Have the revealed values run out? `until` is null when nothing is revealed. */
export function revealExpired(until: number | null, now: number): boolean {
  return until !== null && now >= until;
}

// ------------------------------------------------------------
// The watermark
// ------------------------------------------------------------
export function watermarkText(viewer: string, when: Date, locale: string): string {
  const name = viewer.replace(/\s+/g, " ").trim().slice(0, 40) || "?";
  let time: string;
  try {
    time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(when);
  } catch {
    time = when.toISOString().slice(0, 16).replace("T", " ");
  }
  return `${name} · ${time} · Halo`;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * A repeating, diagonal watermark as an SVG background (a CSS data URL), light text with a dark outline so it reads on any photo. The text is escaped,
 * so a name can never add markup. It is drawn by the browser over the image (a CSS background on an overlay), not part of the image bytes.
 */
export function watermarkBackground(text: string): string {
  const safe = xmlEscape(text);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='340' height='190'>` +
    `<text x='170' y='95' transform='rotate(-28 170 95)' text-anchor='middle' font-family='sans-serif' font-size='14' font-weight='700' ` +
    `fill='rgba(255,255,255,0.6)' stroke='rgba(0,0,0,0.55)' stroke-width='0.7' paint-order='stroke'>${safe}</text></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

// ------------------------------------------------------------
// The viewer's zoom, rotation and fit
// ------------------------------------------------------------
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export interface ViewerState {
  zoom: number;
  rotate: 0 | 90 | 180 | 270;
  /** true: fit the image to the frame; false: its own size (100%). */
  fit: boolean;
}

export const INITIAL_VIEW: ViewerState = { zoom: 1, rotate: 0, fit: true };

function nearestStep(zoom: number): number {
  let best = 0;
  for (let i = 0; i < ZOOM_STEPS.length; i++) if (Math.abs(ZOOM_STEPS[i] - zoom) < Math.abs(ZOOM_STEPS[best] - zoom)) best = i;
  return best;
}

export function zoomIn(s: ViewerState): ViewerState {
  const i = nearestStep(s.zoom);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS[i] <= s.zoom ? i + 1 : i)];
  return { ...s, zoom: next };
}
export function zoomOut(s: ViewerState): ViewerState {
  const i = nearestStep(s.zoom);
  const next = ZOOM_STEPS[Math.max(0, ZOOM_STEPS[i] >= s.zoom ? i - 1 : i)];
  return { ...s, zoom: next };
}
export function rotate90(s: ViewerState): ViewerState {
  return { ...s, rotate: (((s.rotate + 90) % 360) as ViewerState["rotate"]) };
}
export function toggleFit(s: ViewerState): ViewerState {
  return { ...s, fit: !s.fit, zoom: 1 };
}
export function resetView(): ViewerState {
  return INITIAL_VIEW;
}
export const canZoomIn = (s: ViewerState) => s.zoom < ZOOM_STEPS[ZOOM_STEPS.length - 1];
export const canZoomOut = (s: ViewerState) => s.zoom > ZOOM_STEPS[0];
export const zoomLabel = (s: ViewerState) => `${Math.round(s.zoom * 100)}%`;

/** The keyboard shortcuts of the viewer. Returns the next state, or null when the key is not one of ours (so the browser keeps it). */
export function viewerKey(s: ViewerState, key: string): ViewerState | null {
  switch (key) {
    case "+":
    case "=":
      return zoomIn(s);
    case "-":
    case "_":
      return zoomOut(s);
    case "0":
      return resetView();
    case "r":
    case "R":
      return rotate90(s);
    case "f":
    case "F":
      return toggleFit(s);
    default:
      return null;
  }
}

// ------------------------------------------------------------
// Chips and text
// ------------------------------------------------------------
export const TONE_ORDER: StatusTone[] = ["positive", "pending", "negative", "neutral"];

/** A short form of a long validation id for the list ("val_1234…"); the whole id is in the technical details. */
export function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** "3 minutes ago" / "in 2 hours" in the person's language, from an ISO time. Falls back to the date for anything older than a month. */
export function relativeTime(iso: string, now: number, locale: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    return exactTime(iso, locale);
  }
  if (abs < 45) return rtf.format(Math.round(diffSec), "second");
  if (abs < 45 * 60) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 22 * 3600) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 26 * 86400) return rtf.format(Math.round(diffSec / 86400), "day");
  return exactTime(iso, locale);
}

/** The exact time in the BROWSER's time zone. */
export function exactTime(iso: string, locale: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(t));
  } catch {
    return new Date(t).toISOString();
  }
}

/** Which i18n key (under Kyc.errors) words an error code, with the codes the browser itself can produce. */
export type ClientErrorCode = KycErrorCode | "network";
export function errorKey(code: ClientErrorCode | string): string {
  const known = [
    "not_configured", "upstream_unreachable", "upstream_unauthorized", "not_found", "bad_response", "image_too_large", "image_type_unsupported",
    "image_host_blocked", "invalid_request", "rate_limited", "forbidden", "audit_failed", "already_decided", "amend_refused", "network",
  ];
  return known.includes(code) ? code : "generic";
}

// ------------------------------------------------------------
// Recent searches: friend ids only, never data
// ------------------------------------------------------------
export const RECENT_MAX = 8;
export const recentKey = (userId: string) => `halo:kyc:recent:${userId}`;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadRecent(storage: StorageLike | null, userId: string, valid: (v: string) => boolean): string[] {
  if (!storage || !userId) return [];
  try {
    const raw = storage.getItem(recentKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && valid(v)).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function addRecent(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
}

export function saveRecent(storage: StorageLike | null, userId: string, list: readonly string[]): void {
  if (!storage || !userId) return;
  try {
    if (list.length === 0) storage.removeItem(recentKey(userId));
    else storage.setItem(recentKey(userId), JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // storage blocked or full: the list just is not remembered
  }
}

// ------------------------------------------------------------
// Filters: which checks the reviewer wants to see
//
// review_status, doc_type, created_from, created_to are sent to the back end and applied there.
// The result (validation_status) word is applied here, client-side, so the screen pages itself
// until it has enough matching rows (shouldKeepPaging).
// ------------------------------------------------------------

export interface KycFilters {
  /** Server-side: pending | approved | rejected | staff_rejected | auto_rejected | "all" (omit param). */
  reviewStatus: KycReviewStatus | "all";
  /** YYYY-MM-DD (Malaysia time). Required when reviewStatus !== "pending". */
  dateFrom: string;
  dateTo: string;
  /** One status word exactly as the back end sends it ("UNREADABLE"), or "" for every status. Client-side filter. */
  result: string;
  /** A document kind the back end can filter by, or "" for every kind. */
  docType: "" | KycDocType;
}

export const NO_FILTERS: KycFilters = { reviewStatus: "all", dateFrom: "", dateTo: "", result: "", docType: "" };

/** What the page opens on, and what "Clear filters" goes back to: the checks nobody has decided yet. */
export const DEFAULT_FILTERS: KycFilters = { reviewStatus: "pending", dateFrom: "", dateTo: "", result: "", docType: "" };

export const isDefaultFilters = (f: KycFilters): boolean =>
  f.reviewStatus === DEFAULT_FILTERS.reviewStatus && f.dateFrom === DEFAULT_FILTERS.dateFrom && f.dateTo === DEFAULT_FILTERS.dateTo && f.result === DEFAULT_FILTERS.result && f.docType === DEFAULT_FILTERS.docType;

/** True when the selected status requires a date range before a fetch can be made. */
export const dateRangeRequired = (f: KycFilters): boolean => f.reviewStatus !== "pending";

/** True when both date fields carry a valid YYYY-MM-DD value and from ≤ to. */
export const dateRangeValid = (f: KycFilters): boolean => {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  return re.test(f.dateFrom) && re.test(f.dateTo) && f.dateFrom <= f.dateTo;
};

/** True when the current filters allow a fetch to be made. */
export const canFetch = (f: KycFilters): boolean => !dateRangeRequired(f) || dateRangeValid(f);

/** "APPROVED" -> approved, "REJECTED" -> rejected, another word the back end may send -> other; null when nobody has decided this check. */
export function reviewWord(v: Pick<KycValidation, "review">): "approved" | "rejected" | "other" | null {
  return v.review ? reviewKind(v.review.raw) : null;
}

/** Does this check belong in the list that was asked for? review_status is server-side; only result and docType are re-checked here. */
export function matchesFilters(v: KycValidation, f: KycFilters): boolean {
  if (f.result !== "" && (v.status.raw ?? "").toUpperCase() !== f.result.toUpperCase()) return false;
  if (f.docType !== "" && (v.type ?? "").toLowerCase() !== f.docType) return false;
  return true;
}

export const filterValidations = (items: readonly KycValidation[], f: KycFilters): KycValidation[] => items.filter((v) => matchesFilters(v, f));

/** The status words to offer, taken from the checks already loaded: the back end publishes no list of them. */
export function resultOptions(items: readonly KycValidation[]): string[] {
  const seen = new Set<string>();
  for (const v of items) if (v.status.raw) seen.add(v.status.raw.toUpperCase());
  return [...seen].sort();
}

/** True when a filter the back end cannot apply is set, so the screen has to read further pages itself to fill one. */
export const needsOwnPaging = (f: KycFilters) => f.result !== "";

/** How many matches to gather before stopping, and the most pages to read for them in one go. */
export const AUTO_PAGE_TARGET = 20;
export const AUTO_PAGE_MAX = 8;

export interface PagingInput {
  matches: number;
  pages: number;
  hasMore: boolean;
  filters: KycFilters;
  target?: number;
  max?: number;
}

/**
 * Should another page be read straight away? Only for a filter the back end ignores, only while it says there is more, and never more than `max`
 * pages in one go: the list route allows thirty calls a minute per person, and each one is a row in the access log.
 */
export function shouldKeepPaging({ matches, pages, hasMore, filters, target = AUTO_PAGE_TARGET, max = AUTO_PAGE_MAX }: PagingInput): boolean {
  if (!hasMore || !needsOwnPaging(filters)) return false;
  return matches < target && pages < max;
}
