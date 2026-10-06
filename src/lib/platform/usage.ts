// ============================================================
// Usage against plan limits (migration 152).
//
// The operator sets limits per workspace (`account_platform.limits`); the
// numbers they are measured against come from account_usage(). One rule for
// every limit, so a customer can predict it:
//
//   - no limit set      -> unlimited
//   - 80% and over      -> "warn": the workspace's admins see a notice and the
//                          operator sees the workspace flagged
//   - 100% and over     -> "over": the app refuses to create MORE of that thing
//                          (a contact added by a person, an outbound message,
//                          an AI call). A customer writing in is never refused.
//
// Storage is measured and flagged but not blocked (browsers upload straight
// to storage). Lookups fail open and are cached for a minute: a limit check
// must never be the thing that takes replies down.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import type { PlatformLimit } from './features'

export const USAGE_WARN_FRACTION = 0.8

/** The limits that are measured against usage, in display order. */
export const USAGE_METERS = [
  'contacts',
  'messages_per_month',
  'ai_tokens_per_month',
  'storage_mb',
  'seats',
  'sign_documents_per_month',
] as const
export type UsageMeterKey = (typeof USAGE_METERS)[number] & PlatformLimit

/** The shape of account_usage(). */
export interface AccountUsage {
  contacts: number
  members: number
  conversations: number
  messages_month: number
  ai_tokens_month: number
  storage_bytes: number
  storage_measured_at: string | null
  limits: Record<string, number>
  /** Documents sent for signing this month (Doc Sign, migration 157). Absent on older readings. */
  sign_documents_month?: number
}

export type UsageState = 'ok' | 'warn' | 'over'

export interface UsageMeter {
  key: UsageMeterKey
  used: number
  /** null = unlimited */
  limit: number | null
  /** 0..1+, null when unlimited */
  fraction: number | null
  state: UsageState
}

const MIB = 1024 * 1024

/** The numeric limit for `key` in a `limits` object, or null when unlimited. */
function limitOf(limits: Record<string, number> | null | undefined, key: PlatformLimit): number | null {
  const v = limits?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export function usageState(used: number, limit: number | null | undefined): UsageState {
  if (limit === null || limit === undefined || limit <= 0) return 'ok'
  if (used >= limit) return 'over'
  if (used / limit >= USAGE_WARN_FRACTION) return 'warn'
  return 'ok'
}

/** How much of each limit is used, from an account_usage() answer. Unlimited meters are included with `limit: null`. */
export function usageMeters(usage: AccountUsage | null | undefined): UsageMeter[] {
  if (!usage) return []
  const used: Record<UsageMeterKey, number> = {
    contacts: Number(usage.contacts) || 0,
    messages_per_month: Number(usage.messages_month) || 0,
    ai_tokens_per_month: Number(usage.ai_tokens_month) || 0,
    storage_mb: Math.ceil((Number(usage.storage_bytes) || 0) / MIB),
    seats: Number(usage.members) || 0,
    sign_documents_per_month: Number(usage.sign_documents_month) || 0,
  }
  return USAGE_METERS.filter(
    // Doc Sign's meter appears only for a workspace that has a limit on it or has sent something.
    (key) => key !== 'sign_documents_per_month' || limitOf(usage.limits, key) !== null || used[key] > 0,
  ).map((key) => {
    const limit = limitOf(usage.limits, key)
    return {
      key,
      used: used[key],
      limit,
      fraction: limit && limit > 0 ? used[key] / limit : null,
      state: usageState(used[key], limit),
    }
  })
}

/** The worst state across meters (for a banner or an operator flag). */
export function worstState(meters: UsageMeter[]): UsageState {
  if (meters.some((m) => m.state === 'over')) return 'over'
  if (meters.some((m) => m.state === 'warn')) return 'warn'
  return 'ok'
}

// ------------------------------------------------------------
// Live lookup for the app's own checks
// ------------------------------------------------------------

const TTL_MS = 60_000
const cache = new Map<string, { usage: AccountUsage | null; at: number }>()

/** The workspace's live usage and limits, cached for a minute. Null when it cannot be read (fail open). */
export async function loadAccountUsage(
  db: SupabaseClient,
  accountId: string,
  now: () => number = Date.now,
): Promise<AccountUsage | null> {
  const hit = cache.get(accountId)
  if (hit && now() - hit.at < TTL_MS) return hit.usage
  try {
    const { data, error } = await db.rpc('account_usage', { p_account: accountId })
    if (error || !data || typeof data !== 'object') return null
    const usage = data as AccountUsage
    cache.set(accountId, { usage, at: now() })
    return usage
  } catch {
    return null
  }
}

/** After something is created, the cached answer is stale; the next check reads again. */
export function forgetAccountUsage(accountId: string): void {
  cache.delete(accountId)
}

export class UsageLimitError extends Error {
  readonly code: 'message_limit_reached' | 'contact_limit_reached' | 'ai_limit_reached' | 'sign_limit_reached'
  readonly status = 429
  constructor(code: UsageLimitError['code'], message: string) {
    super(message)
    this.name = 'UsageLimitError'
    this.code = code
  }
}

export const LIMIT_MESSAGES = {
  message_limit_reached: "This workspace has reached its monthly message limit. Ask the account owner to contact support to raise it.",
  contact_limit_reached: "This workspace has reached its contact limit. Ask the account owner to contact support to raise it.",
  ai_limit_reached: "This workspace has used up its AI allowance for the month.",
  sign_limit_reached: "This workspace has reached its monthly limit of documents sent for signing. Ask the account owner to contact support to raise it.",
} as const

/**
 * Throws when sending one more outbound message would go over the monthly
 * limit. Returns quietly when there is no limit, no reading, or room.
 */
export async function assertCanSendMessage(db: SupabaseClient, accountId: string): Promise<void> {
  const usage = await loadAccountUsage(db, accountId)
  if (!usage) return
  const limit = limitOf(usage.limits, 'messages_per_month')
  if (limit !== null && (Number(usage.messages_month) || 0) >= limit) {
    throw new UsageLimitError('message_limit_reached', LIMIT_MESSAGES.message_limit_reached)
  }
}

/**
 * Throws when sending one more document for signing would go over the monthly limit (Doc Sign).
 * Only a document SENT counts, never a draft. Returns quietly when there is no limit, no reading,
 * or room; the count is the live one from account_usage(), so it is not cached across a send.
 */
export async function assertCanSendDocument(db: SupabaseClient, accountId: string): Promise<void> {
  forgetAccountUsage(accountId)
  const usage = await loadAccountUsage(db, accountId)
  if (!usage) return
  const limit = limitOf(usage.limits, 'sign_documents_per_month')
  if (limit !== null && (Number(usage.sign_documents_month) || 0) >= limit) {
    throw new UsageLimitError('sign_limit_reached', LIMIT_MESSAGES.sign_limit_reached)
  }
}

/**
 * How many more documents the workspace can send for signing this month, for a batch that must know up front
 * whether it fits (Doc Sign bulk send). `limit` is null when there is none, and `remaining` is then null
 * (unlimited). Reads the live count, and fails open like the other checks: no reading means no limit.
 */
export async function signSendHeadroom(
  db: SupabaseClient,
  accountId: string,
): Promise<{ limit: number | null; used: number; remaining: number | null }> {
  forgetAccountUsage(accountId)
  const usage = await loadAccountUsage(db, accountId)
  if (!usage) return { limit: null, used: 0, remaining: null }
  const limit = limitOf(usage.limits, 'sign_documents_per_month')
  const used = Number(usage.sign_documents_month) || 0
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) }
}

/**
 * Throws when adding one more contact by hand or through the API would go over
 * the workspace's contact limit. People adding contacts in the browser are
 * stopped by the database (contacts_limit_guard); this covers the API, which
 * runs as the service role. Counts exactly (no cache): the limit is a hard one.
 */
export async function assertCanAddContact(db: SupabaseClient, accountId: string): Promise<void> {
  try {
    const { data } = await db.from('account_platform').select('limits').eq('account_id', accountId).maybeSingle()
    const limit = limitOf((data as { limits?: Record<string, number> } | null)?.limits, 'contacts')
    if (limit === null) return
    const { count } = await db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('deleted_at', null)
    if (typeof count === 'number' && count >= limit) {
      throw new UsageLimitError('contact_limit_reached', LIMIT_MESSAGES.contact_limit_reached)
    }
  } catch (err) {
    if (err instanceof UsageLimitError) throw err
    // fail open
  }
}

/** The operator's AI token limit for the month, and what is used (cached); null when none is set. */
export async function aiAllowance(
  db: SupabaseClient,
  accountId: string,
): Promise<{ limit: number; used: number } | null> {
  const usage = await loadAccountUsage(db, accountId)
  if (!usage) return null
  const limit = limitOf(usage.limits, 'ai_tokens_per_month')
  if (limit === null) return null
  return { limit, used: Number(usage.ai_tokens_month) || 0 }
}

/** For tests. */
export function __resetUsageCacheForTests(): void {
  cache.clear()
}
