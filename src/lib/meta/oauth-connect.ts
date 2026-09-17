import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/whatsapp/encryption'
import type { MetaOAuthChannel, MetaPage } from './oauth'

/**
 * `oauth_pending_connections` CRUD, shared by the Messenger and
 * Instagram OAuth route sets (migration 055). One state token per
 * connection attempt: it's both the CSRF guard on the OAuth redirect
 * and the callback's lookup key.
 */

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

export async function createPendingConnection(
  db: SupabaseClient,
  args: { accountId: string; userId: string; channel: MetaOAuthChannel },
): Promise<{ id: string; state: string }> {
  const state = generateOAuthState()
  const { data, error } = await db
    .from('oauth_pending_connections')
    .insert({
      account_id: args.accountId,
      initiated_by_user_id: args.userId,
      channel: args.channel,
      state,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to start OAuth connection: ${error?.message ?? 'unknown error'}`)
  }
  return { id: data.id, state }
}

export interface PendingConnectionRow {
  id: string
  account_id: string
  initiated_by_user_id: string
  channel: MetaOAuthChannel
  state: string
  long_lived_user_token: string | null
  pages_json: MetaPage[] | null
  status: 'pending' | 'awaiting_page_selection' | 'completed' | 'expired' | 'failed'
  expires_at: string
}

export async function findPendingConnectionByState(
  db: SupabaseClient,
  state: string,
): Promise<PendingConnectionRow | null> {
  const { data, error } = await db
    .from('oauth_pending_connections')
    .select('*')
    .eq('state', state)
    .maybeSingle()
  if (error || !data) return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data as PendingConnectionRow
}

export async function findPendingConnectionById(
  db: SupabaseClient,
  id: string,
): Promise<PendingConnectionRow | null> {
  const { data, error } = await db
    .from('oauth_pending_connections')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data as PendingConnectionRow
}

export async function storeLongLivedToken(
  db: SupabaseClient,
  id: string,
  accessToken: string,
): Promise<void> {
  await db
    .from('oauth_pending_connections')
    .update({ long_lived_user_token: encrypt(accessToken) })
    .eq('id', id)
}

export async function markAwaitingPageSelection(
  db: SupabaseClient,
  id: string,
  pages: MetaPage[],
): Promise<void> {
  await db
    .from('oauth_pending_connections')
    .update({ pages_json: pages, status: 'awaiting_page_selection' })
    .eq('id', id)
}

export async function markCompleted(db: SupabaseClient, id: string): Promise<void> {
  await db.from('oauth_pending_connections').update({ status: 'completed' }).eq('id', id)
}

export async function markFailed(db: SupabaseClient, id: string): Promise<void> {
  await db.from('oauth_pending_connections').update({ status: 'failed' }).eq('id', id)
}
