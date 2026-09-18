import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * `oauth_pending_connections` CRUD for the Gmail channel (migration
 * 058, widening migration 055/056's `channel` CHECK). A deliberately
 * smaller copy of `src/lib/meta/oauth-connect.ts` / `src/lib/ms365/oauth-connect.ts`
 * — not a shared import, for the same "don't risk a working channel's
 * code for a different channel's change" reasoning both of those give.
 * Like Microsoft 365, Gmail connects the signed-in Google account's
 * own single mailbox — no Page-picker equivalent — so this never
 * touches anything beyond `pending` -> `completed` | `failed`.
 */

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

export async function createPendingGmailConnection(
  db: SupabaseClient,
  args: { accountId: string; userId: string },
): Promise<{ id: string; state: string }> {
  const state = generateOAuthState()
  const { data, error } = await db
    .from('oauth_pending_connections')
    .insert({
      account_id: args.accountId,
      initiated_by_user_id: args.userId,
      channel: 'gmail',
      state,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to start OAuth connection: ${error?.message ?? 'unknown error'}`)
  }
  return { id: data.id, state }
}

export interface PendingGmailConnectionRow {
  id: string
  account_id: string
  initiated_by_user_id: string
  channel: 'gmail'
  state: string
  status: 'pending' | 'completed' | 'failed'
  expires_at: string
}

export async function findPendingGmailConnectionByState(
  db: SupabaseClient,
  state: string,
): Promise<PendingGmailConnectionRow | null> {
  const { data, error } = await db
    .from('oauth_pending_connections')
    .select('*')
    .eq('state', state)
    .eq('channel', 'gmail')
    .maybeSingle()
  if (error || !data) return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data as PendingGmailConnectionRow
}

export async function markGmailConnectionCompleted(db: SupabaseClient, id: string): Promise<void> {
  await db.from('oauth_pending_connections').update({ status: 'completed' }).eq('id', id)
}

export async function markGmailConnectionFailed(db: SupabaseClient, id: string): Promise<void> {
  await db.from('oauth_pending_connections').update({ status: 'failed' }).eq('id', id)
}
