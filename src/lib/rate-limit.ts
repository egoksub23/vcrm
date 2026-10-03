/**
 * In-memory per-key rate limiter.
 *
 * Fixed-window counter (not token bucket): every identifier gets a
 * fresh N-request budget each window. Simple, allocation-light, and
 * fine for a single-instance VPS — which is how forkers of this
 * template will usually deploy.
 *
 * Trade-off: a single Node process holds the Map, so horizontal scale
 * (multiple regions, multiple nodes, serverless fan-out) silently
 * defeats the limit. The budgets that protect the platform from one
 * workspace (RATE_LIMITS.*Account, *Token) therefore use
 * checkSharedRateLimit in ./rate-limit-shared, which counts in Postgres
 * (migration 138) and falls back to this limiter if the database call
 * fails. What stays here is the cheap per-user / per-IP checking.
 *
 * Memory: entries are ~50 bytes each. With LIGHT_SWEEP below, expired
 * keys get cleared opportunistically on every ~1 000th call, so a
 * healthy instance stays in the low-MB range even with thousands of
 * distinct users. No background timer — works in serverless edge
 * runtimes that don't keep timers alive across requests.
 */

import { NextResponse } from 'next/server';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

// Opportunistic cleanup. Running a sweep on every call would be
// quadratic; running it 1-in-N lets the Map self-drain without a
// background timer.
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

export function checkRateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

/**
 * True when `key`'s current window is already used up. Does not count a call:
 * pair it with checkRateLimit to count only some events (for example failures),
 * so ordinary traffic is never limited but a stream of failures is.
 */
export function isRateLimited(key: string, { limit }: RateLimitOptions): boolean {
  const entry = buckets.get(key);
  return !!entry && entry.resetAt > Date.now() && entry.count >= limit;
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch. NOT one call per campaign: the wizard fans a
   *  campaign out over `/api/whatsapp/broadcast` in batches of 10
   *  recipients, roughly one call every 1–2 s, so a 1 000-recipient
   *  send is ~100 calls over several minutes. This bucket was 5/min on
   *  the assumption of one call per campaign, which meant everything
   *  past the first ~50 recipients came back 429 and was recorded as a
   *  failed recipient (issue #472). 60/min per user carries the wizard's
   *  pacing with headroom while still bounding a script in a loop;
   *  Meta's own per-number limits remain the real throughput ceiling. */
  broadcast: { limit: 60, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. Like every bucket here it's per-process; a multi-
   *  instance deploy needs the Redis swap described at the top of
   *  this file (the per-key call sites don't change). */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** AI draft-reply generation, per user. 20/min is generous for an
   *  agent clicking "Draft with AI" while working a thread, and bounds
   *  spend on the account's own LLM key against an accidental
   *  hold-down / script. */
  aiDraft: { limit: 20, windowMs: 60_000 },
  /** AI draft-reply generation, per account. Caps the WHOLE team's
   *  draws on the one shared BYO provider key — without this, N agents
   *  each under their per-user limit could still stampede the account's
   *  key past the provider's own rate limit. 60/min ≈ three busy agents
   *  drafting flat-out. */
  aiDraftAccount: { limit: 60, windowMs: 60_000 },
  /** AI auto-reply generation, per account. The per-conversation cap
   *  (`auto_reply_max_per_conversation`) bounds one thread; this bounds
   *  the whole account across threads, so a burst of inbound from many
   *  customers at once can't run the BYO key past the provider's limit
   *  or the owner's budget. 30/min is generous for organic inbound while
   *  capping a stampede; excess inbounds simply don't get an auto-reply
   *  (they still land in the inbox for a human). */
  aiAutoReplyAccount: { limit: 30, windowMs: 60_000 },
  /** Public widget session bootstrap (`/api/widget/session`), keyed
   *  per widget_token+IP. Called once per page load (not per message),
   *  so 30/min comfortably covers a busy embedding site while bounding
   *  a script hammering the endpoint to enumerate/probe it. */
  widgetSession: { limit: 30, windowMs: 60_000 },
  /** Public widget message send (`/api/widget/message`), keyed per
   *  visitor (their anon auth.uid()). Same budget as an authenticated
   *  agent's `send` bucket — a live visitor typing should never hit it. */
  widgetMessage: { limit: 60, windowMs: 60_000 },
  /** Signed-link requests for the media in a visitor's own conversation
   *  (`/api/widget/media-url`), keyed per visitor uid. The widget batches up
   *  to 25 links per call and caches them for hours, so a normal session makes
   *  a handful; 30 a minute leaves room for a busy thread and a flaky socket
   *  retrying, and still caps how fast one visitor can mint links. */
  widgetMediaUrl: { limit: 30, windowMs: 60_000 },
  /** Typed identity claims on `/api/widget/session` ("I am an existing
   *  user"), keyed per visitor uid. Each claim can reveal, through
   *  `claimFound`, whether a phone/email belongs to a contact, so it is
   *  the enumeration surface: 5 per 10 minutes is far above what a
   *  person typing their own details needs. A valid signed token is a
   *  proof, not a probe, so it never spends this budget. */
  widgetIdentity: { limit: 5, windowMs: 10 * 60_000 },
  /** The same claims, keyed per client IP (first x-forwarded-for hop). */
  widgetIdentityIp: { limit: 20, windowMs: 10 * 60_000 },
  /** Upload tokens for widget attachments (`/api/widget/upload-url`),
   *  per visitor. */
  widgetUpload: { limit: 20, windowMs: 10 * 60_000 },
  /** Delivery/read receipts (`/api/widget/receipt`), per visitor. The
   *  widget batches, so this is generous. */
  widgetReceipt: { limit: 120, windowMs: 60_000 },
  /** Enquiry form submissions (`/api/widget/enquiry`), per visitor. */
  widgetEnquiry: { limit: 5, windowMs: 60 * 60_000 },
  /** Code-verification attempts (`/api/widget/verify-code`), per
   *  visitor — on top of the row's own `attempts` counter (migration
   *  110), which invalidates the code entirely after 5 tries. This is
   *  the belt to that suspenders: even a rapid-fire script against one
   *  browser's session is capped. */
  widgetVerifyCode: { limit: 10, windowMs: 10 * 60_000 },
  /** Webhook deliveries with a bad signature, per caller address. Only
   *  FAILURES count: Meta's real traffic is never limited, but an address
   *  that keeps failing is refused before the signature check does any
   *  database work. 120/min is far above what a misconfigured Meta app
   *  produces while it is being fixed. */
  webhookInvalid: { limit: 120, windowMs: 60_000 },
  /** Valid Vircle Chat events from one workspace's gateway (`/api/vircle-chat/webhook`),
   *  checked with checkSharedRateLimit. 1 200/min = 20 events a second, far above a
   *  customer-care chat; it only stops a runaway or hostile gateway. */
  vircleInbound: { limit: 1200, windowMs: 60_000 },
  /** "Typing..." signals an agent sends to a Vircle Chat user (`/api/vircle-chat/typing`):
   *  one per 3 seconds per agent and conversation (contract 4.2). A signal over the budget
   *  is dropped quietly, not refused: it is cosmetic and the composer fires it freely. */
  vircleTyping: { limit: 1, windowMs: 3000 },

  // ---- Per-workspace budgets (checked with checkSharedRateLimit, so every
  // app instance counts into the same bucket, migration 138). They bound a
  // WORKSPACE as a whole: per-user and per-key limits alone let one workspace
  // multiply its budget with more agents or more API keys.

  /** All message sends from one workspace. 1 200/min = 20/s, a little under
   *  WhatsApp's own 80/s ceiling, far above a busy human team. */
  sendAccount: { limit: 1200, windowMs: 60_000 },
  /** All broadcast batch calls from one workspace (see `broadcast`: the
   *  wizard sends ~1 call per 1-2 s per campaign). */
  broadcastAccount: { limit: 300, windowMs: 60_000 },
  /** All public REST API traffic from one workspace, whatever the number of
   *  keys it has issued (`publicApi` is per key). */
  publicApiAccount: { limit: 1200, windowMs: 60_000 },
  /** Every call to a web widget's session endpoint, per widget token. Keyed on
   *  the token alone: the Origin header is sent by the caller, so keying on it
   *  let a script pick a fresh bucket with every request. */
  widgetSessionToken: { limit: 600, windowMs: 60_000 },
  /** Typed identity claims, per widget token (see `widgetIdentity`). */
  widgetIdentityToken: { limit: 60, windowMs: 10 * 60_000 },
  /** Enquiry submissions, per widget token. */
  widgetEnquiryToken: { limit: 60, windowMs: 60 * 60_000 },
} as const;

/** Window for the per-workspace broadcast recipient cap: the operator's
 *  `broadcast_per_day` limit (account_platform.limits) per rolling day. */
export const BROADCAST_RECIPIENTS_WINDOW_MS = 24 * 60 * 60_000;

/** Test-only helper. Clears the in-memory state so unit tests don't
 *  leak buckets across files. Not wired up in production code. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}
