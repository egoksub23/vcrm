// ============================================================
// "May background work run for this workspace?" for code paths that act
// on a workspace's behalf without a signed-in member: the automation
// engine, the AI auto-reply, scheduled jobs.
//
// A suspended workspace (migration 132) already has every channel paused,
// so inbound events are dropped at the door. This is the second line: a
// trigger that still reaches the engine (a tag event, a scheduled
// resume) must not act either. The database functions use
// account_is_active() for the same rule (migration 135).
//
// Fails open (active) when the answer cannot be read: a missing table
// means migration 132 is not applied, and a transient error must not stop
// an account's automations. Answers are cached for 30 seconds, so the
// extra lookup is at most one per workspace per half minute per process.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

const TTL_MS = 30_000
const cache = new Map<string, { active: boolean; at: number }>()

export async function isAccountActive(
  admin: SupabaseClient,
  accountId: string,
  now: () => number = Date.now,
): Promise<boolean> {
  const hit = cache.get(accountId)
  if (hit && now() - hit.at < TTL_MS) return hit.active

  try {
    const { data, error } = await admin
      .from('account_platform')
      .select('status')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) return true
    const active = (data as { status?: string } | null)?.status !== 'suspended'
    cache.set(accountId, { active, at: now() })
    return active
  } catch {
    return true
  }
}

/**
 * Every suspended workspace id, for jobs that sweep many workspaces in
 * one pass (the list is short). Fails open (empty) on any read error.
 */
export async function suspendedAccountIds(admin: SupabaseClient): Promise<Set<string>> {
  try {
    const { data, error } = await admin
      .from('account_platform')
      .select('account_id')
      .eq('status', 'suspended')
    if (error) return new Set()
    return new Set(((data ?? []) as { account_id: string }[]).map((r) => r.account_id))
  } catch {
    return new Set()
  }
}

/** For tests. */
export function __resetActiveCacheForTests(): void {
  cache.clear()
}
