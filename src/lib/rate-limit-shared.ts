/**
 * Rate limits every app instance shares (migration 138, `rate_limit_hit`).
 *
 * `checkRateLimit` in ./rate-limit.ts counts inside one Node process, so it
 * cannot bound a workspace as a whole and resets on restart or a second
 * instance. This is the same fixed-window contract backed by Postgres, for the
 * budgets that protect the platform from one workspace (per-workspace sends,
 * broadcasts, API traffic, AI calls, widget traffic per token, the daily
 * broadcast recipient cap). Per-user and per-IP checks stay in memory.
 *
 * If the counter cannot be reached (an outage, or migration 138 not applied
 * yet) it falls back to the in-memory limiter: a database blip must not stop
 * customers sending.
 */

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  type RateLimitOptions,
  type RateLimitResult,
} from '@/lib/rate-limit';

interface HitRow {
  allowed: boolean;
  remaining: number;
  reset_at: string;
}

let warnedAt = 0;
function warnOnce(message: string) {
  // Once a minute, so an outage is visible without flooding the log.
  const now = Date.now();
  if (now - warnedAt < 60_000) return;
  warnedAt = now;
  console.warn(message);
}

/**
 * Spend `cost` units (default 1) from the shared budget for `key`. A refused
 * call spends nothing. `cost` above the whole limit is always refused.
 */
export async function checkSharedRateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
  cost = 1,
): Promise<RateLimitResult> {
  try {
    const { data, error } = await supabaseAdmin().rpc('rate_limit_hit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
      p_cost: Math.max(1, Math.ceil(cost)),
    });
    const row = (Array.isArray(data) ? data[0] : data) as HitRow | undefined;
    if (error || !row || typeof row.allowed !== 'boolean') {
      throw new Error(error?.message ?? 'empty response');
    }
    return {
      success: row.allowed,
      remaining: Math.max(0, Number(row.remaining) || 0),
      reset: new Date(row.reset_at).getTime(),
      limit,
    };
  } catch (err) {
    warnOnce(
      `[rate-limit] shared counter unavailable, using the in-process limiter: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // A weighted spend (recipients, not requests) has no meaningful in-process
    // equivalent, so it fails open rather than miscount.
    if (cost > 1) {
      return { success: true, remaining: limit, reset: Date.now() + windowMs, limit };
    }
    return checkRateLimit(key, { limit, windowMs });
  }
}
