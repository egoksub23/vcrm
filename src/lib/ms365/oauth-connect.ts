import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * `oauth_pending_connections` CRUD for the email channel (migration
 * 056, widening migration 055's `channel` CHECK). A deliberately
 * smaller copy of `src/lib/meta/oauth-connect.ts` — not a shared
 * import — because a Microsoft 365 connection has no Page-picker
 * equivalent (it's always the signed-in user's own single mailbox), so
 * this never touches `pages_json` / `awaiting_page_selection` at all,
 * only `pending` -> `completed` | `failed`. Copied rather than
 * generalized for the same reason `src/lib/meta/errors.ts` was copied
 * from the WhatsApp module: keeping the well-tested Meta OAuth code
 * path untouched by a change made for a different channel.
 */

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

export async function createPendingEmailConnection(
  db: SupabaseClient,
  args: { accountId: string; userId: string },
): Promise<{ id: string; state: string }> {
  const state = generateOAuthState()
  const { data, error } = await db
    .from('oauth_pending_connections')
    .insert({
      account_id: args.accountId,
      initiated_by_user_id: args.userId,
      channel: 'email',
      state,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to start OAuth connection: ${error?.message ?? 'unknown error'}`)
  }
  return { id: data.id, state }
}

export interface PendingEmailConnectionRow {
  id: string
  account_id: string
  initiated_by_user_id: string
  channel: 'email'
  state: string
  status: 'pending' | 'completed' | 'failed'
  expires_at: string
}

export async function findPendingEmailConnectionByState(
  db: SupabaseClient,
  state: string,
): Promise<PendingEmailConnectionRow | null> {
  const { data, error } = await db
    .from('oauth_pending_connections')
    .select('*')
    .eq('state', state)
    .eq('channel', 'email')
    .maybeSingle()
  if (error || !data) return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data as PendingEmailConnectionRow
}

export async function markEmailConnectionCompleted(db: SupabaseClient, id: string): Promise<void> {
  await db.from('oauth_pending_connections').update({ status: 'completed' }).eq('id', id)
}

export async function markEmailConnectionFailed(db: SupabaseClient, id: string): Promise<void> {
  await db.from('oauth_pending_connections').update({ status: 'failed' }).eq('id', id)
}
