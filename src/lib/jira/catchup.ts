// ============================================================
// The catch-up poll and the queue's retry maths. Pure.
//
// Every ~5 minutes the cron endpoint asks Jira, in ONE search per chunk,
// which linked issues changed recently, then re-syncs those. It is the safety
// net for a webhook that never arrived (or for a Jira site that never
// delivers them, see docs/jira-setup.md).
//
// The window is written as a RELATIVE JQL time (`updated >= -12m`), not a
// clock time: JQL date literals are read in the connecting user's time zone,
// which Vircle does not know, and a wrong zone would silently miss changes.
// ============================================================

import { JiraRateLimitError, JiraError } from "./errors";

/** Overlap added to the window so a change at the edge is never missed. */
export const CATCHUP_OVERLAP_MINUTES = 2;
/** Beyond this gap the time clause is dropped and every linked issue is re-read. */
export const CATCHUP_MAX_WINDOW_MINUTES = 24 * 60;

/**
 * The relative window in minutes for a catch-up since `lastCatchup`, or null
 * when there was none (or the gap is too long to trust): re-read everything.
 */
export function catchupWindowMinutes(lastCatchup: Date | null, now: Date): number | null {
  if (!lastCatchup) return null;
  const gap = Math.ceil((now.getTime() - lastCatchup.getTime()) / 60_000);
  if (!Number.isFinite(gap) || gap < 0) return null;
  const minutes = gap + CATCHUP_OVERLAP_MINUTES;
  return minutes > CATCHUP_MAX_WINDOW_MINUTES ? null : Math.max(minutes, CATCHUP_OVERLAP_MINUTES + 1);
}

/** Split issue ids so a JQL stays short: at most `maxCount` ids and `maxChars` characters each. */
export function chunkIds(ids: readonly string[], maxCount = 100, maxChars = 1500): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const raw of ids) {
    const id = String(raw);
    if (!/^\d{1,20}$/.test(id)) continue; // ids are digits; anything else never reaches a JQL
    const add = id.length + 2;
    if (cur.length >= maxCount || (cur.length > 0 && len + add > maxChars)) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(id);
    len += add;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * The JQL for one chunk: `id in (10001,10002) AND updated >= -12m`. Issue ids
 * (not keys) so a moved issue is still found; the ids are digits only.
 */
export function buildCatchupJql(ids: readonly string[], windowMinutes: number | null): string {
  const list = ids.filter((i) => /^\d{1,20}$/.test(i)).join(",");
  const base = `id in (${list})`;
  return windowMinutes && windowMinutes > 0 ? `${base} AND updated >= -${Math.floor(windowMinutes)}m` : base;
}

/** The JQL a webhook registration uses: only issues in the allowed projects, or a project-wide fallback. */
export function buildWebhookJql(projectKeys: readonly string[]): string {
  const keys = projectKeys.filter((k) => /^[A-Za-z][A-Za-z0-9_]{0,9}$/.test(k));
  return keys.length > 0 ? `project in (${keys.join(",")})` : "";
}

// ------------------------------------------------------------
// Queue retry policy
// ------------------------------------------------------------

/** Seconds before retry number `attempts` (1-based): 30 s doubling to 30 min, with jitter. */
export function retryDelaySeconds(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(30 * 60, 30 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

export type JobOutcome = { outcome: "retry"; seconds: number } | { outcome: "dead" };

/** Retry what may pass (rate limit, Jira down); give up on what never will (403, gone, bad request, dead token). */
export function classifyJobError(err: unknown, attempts: number, random: () => number = Math.random): JobOutcome {
  if (err instanceof JiraRateLimitError) {
    return { outcome: "retry", seconds: Math.min(3600, Math.max(5, Math.ceil(err.retryAfterMs / 1000))) };
  }
  if (err instanceof JiraError) {
    return err.retryable ? { outcome: "retry", seconds: retryDelaySeconds(attempts, random) } : { outcome: "dead" };
  }
  // A bug or an unexpected error: retry a few times, the queue dead-letters it.
  return { outcome: "retry", seconds: retryDelaySeconds(attempts, random) };
}

// ------------------------------------------------------------
// The catch-up self-check
// ------------------------------------------------------------

/** A connection with live links whose catch-up has not succeeded for this long is "stalled". */
export const CATCHUP_STALL_MINUTES = 30;

export interface CatchupStall {
  stalled: boolean;
  /** Minutes since the last success (or since the first live link, whichever is later). */
  minutes: number | null;
}

/**
 * Has the catch-up stopped working? The reference is the later of the last
 * successful catch-up and the moment the OLDEST live link appeared: a link
 * created a minute ago cannot have missed a catch-up yet, and a connection
 * with no live links has nothing to catch up. Pure.
 */
export function catchupStall(args: {
  lastCatchupAt: string | null | undefined;
  liveLinkCreatedAt: readonly string[];
  now: number;
  thresholdMinutes?: number;
}): CatchupStall {
  const created = args.liveLinkCreatedAt.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t));
  if (created.length === 0) return { stalled: false, minutes: null };
  const last = args.lastCatchupAt ? Date.parse(args.lastCatchupAt) : NaN;
  const reference = Math.max(Number.isFinite(last) ? last : 0, Math.min(...created));
  const minutes = Math.max(0, Math.floor((args.now - reference) / 60_000));
  return { stalled: minutes > (args.thresholdMinutes ?? CATCHUP_STALL_MINUTES), minutes };
}
