import { NextResponse } from 'next/server';

import { limitFor, type AccountPlatform } from '@/lib/platform/features';
import { BROADCAST_RECIPIENTS_WINDOW_MS } from '@/lib/rate-limit';
import { checkSharedRateLimit } from '@/lib/rate-limit-shared';

export type RecipientCapResult =
  | { ok: true }
  | { ok: false; cap: number; remaining: number; retryAfterSeconds: number; message: string };

/**
 * The operator's per-day broadcast recipient cap for a workspace
 * (`limits.broadcast_per_day` in account_platform, set in the Platform
 * console). Unset means no cap. Recipients are counted when a batch is
 * accepted, against a rolling 24 hours shared by every app instance; a batch
 * that does not fit is refused whole and spends nothing.
 *
 */
export async function checkBroadcastRecipientCap(
  accountId: string,
  platform: AccountPlatform | undefined,
  recipients: number,
): Promise<RecipientCapResult> {
  const cap = limitFor(platform, 'broadcast_per_day');
  if (cap === null || recipients < 1) return { ok: true };

  // A cap of 0 blocks broadcasts altogether; the shared counter needs limit >= 1.
  if (cap === 0) return refused(0, Date.now() + BROADCAST_RECIPIENTS_WINDOW_MS, 0);

  const result = await checkSharedRateLimit(
    `broadcast-recipients:${accountId}`,
    { limit: cap, windowMs: BROADCAST_RECIPIENTS_WINDOW_MS },
    recipients,
  );
  return result.success ? { ok: true } : refused(cap, result.reset, result.remaining);
}

/** The same check as a ready 429 response for the dashboard routes, or null when allowed. */
export async function enforceBroadcastRecipientCap(
  accountId: string,
  platform: AccountPlatform | undefined,
  recipients: number,
): Promise<NextResponse | null> {
  const r = await checkBroadcastRecipientCap(accountId, platform, recipients);
  if (r.ok) return null;
  return NextResponse.json(
    {
      error: r.message,
      code: 'broadcast_daily_limit',
      limit: r.cap,
      remaining: r.remaining,
      retry_after_seconds: r.retryAfterSeconds,
    },
    { status: 429, headers: { 'Retry-After': String(r.retryAfterSeconds) } },
  );
}

function refused(cap: number, resetMs: number, remaining: number): RecipientCapResult {
  return {
    ok: false,
    cap,
    remaining,
    retryAfterSeconds: Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)),
    message:
      cap === 0
        ? 'Broadcasts are not enabled for this workspace. Please contact support.'
        : `This workspace's daily broadcast limit of ${cap} recipients would be exceeded (${remaining} left today). Try a smaller audience or wait until it resets.`,
  };
}
