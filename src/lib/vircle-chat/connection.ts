// ============================================================
// The two lookups every "Halo tells the gateway something" call needs
// (read ticks, typing): who the conversation's Vircle user is, and the
// workspace's usable connection to the gateway.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findConfigForAccount, openConfig } from './config'
import { vircleChatEnabled } from './feature'
import type { GatewayConnection } from './gateway'

export interface VircleTarget {
  conversationId: string
  walletId: string
}

/**
 * The Vircle user a conversation belongs to, or null when the conversation is not in this
 * workspace, is not a Vircle Chat conversation (unless `requireVircleChannel` is false: a
 * merged conversation may have moved on to another channel while Vircle messages remain), or
 * its contact has no wallet id. Pass the caller's own (row level security) client to also
 * prove the caller can see it.
 */
export async function findVircleTarget(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  { requireVircleChannel = true }: { requireVircleChannel?: boolean } = {},
): Promise<VircleTarget | null> {
  const { data, error } = await db
    .from('conversations')
    .select('id, last_channel_type, contact:contacts(wallet_id)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as unknown as {
    id: string
    last_channel_type: string | null
    contact: { wallet_id: string | null } | { wallet_id: string | null }[] | null
  }
  if (requireVircleChannel && row.last_channel_type !== 'vircle_chat') return null
  const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact
  const walletId = contact?.wallet_id
  return walletId ? { conversationId: row.id, walletId } : null
}

/**
 * The connection to call the gateway with, or null when the workspace has none, has paused it,
 * or the operator has switched Vircle Chat off. Needs the service role (the secrets are encrypted).
 */
export async function openGatewayConnection(admin: SupabaseClient, accountId: string): Promise<GatewayConnection | null> {
  const cfg = await findConfigForAccount(admin, accountId)
  if (!cfg || cfg.enabled === false) return null
  if (!(await vircleChatEnabled(admin, accountId))) return null
  return { baseUrl: cfg.gateway_base_url, apiToken: openConfig(cfg).apiToken }
}
