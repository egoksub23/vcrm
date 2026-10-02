// ============================================================
// A workspace's Vircle Chat connection (`vircle_chat_config`, migration 147).
//
// Halo generates the three values the gateway team needs, shows the secrets
// once, and keeps them encrypted:
//   workspace_key   public; the gateway puts it in every event so Halo knows
//                   which workspace an event is for
//   signing secret  the gateway signs every event with it (contract section 2)
//   API token       Halo presents it when it calls the gateway
// ============================================================

import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

export interface VircleChatConfigRow {
  id: string
  account_id: string
  workspace_key: string
  gateway_base_url: string
  signing_secret: string
  api_token: string
  push_alerts_enabled: boolean
  enabled: boolean
  last_inbound_at: string | null
  last_error: string | null
  connected_by_user_id: string | null
  created_at: string
  updated_at: string
}

/** What the settings screen may see: never a secret, not even encrypted. */
export interface VircleChatConfigView {
  workspaceKey: string
  gatewayBaseUrl: string
  pushAlertsEnabled: boolean
  enabled: boolean
  lastInboundAt: string | null
  lastError: string | null
  createdAt: string
}

export function toConfigView(row: VircleChatConfigRow): VircleChatConfigView {
  return {
    workspaceKey: row.workspace_key,
    gatewayBaseUrl: row.gateway_base_url,
    pushAlertsEnabled: row.push_alerts_enabled,
    enabled: row.enabled,
    lastInboundAt: row.last_inbound_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  }
}

const token = (prefix: string, bytes: number) => `${prefix}${randomBytes(bytes).toString('base64url')}`

export function generateWorkspaceKey(): string {
  return token('vcw_', 18)
}
export function generateSigningSecret(): string {
  return token('vcs_', 32)
}
export function generateApiToken(): string {
  return token('vct_', 32)
}

export const WORKSPACE_KEY_PATTERN = /^vcw_[A-Za-z0-9_-]{16,64}$/

/** Encrypt a freshly generated secret for storage. */
export function sealSecret(plain: string): string {
  return encrypt(plain)
}

/** The connection with its secrets decrypted, for the webhook (verify) and the send path (call). */
export interface OpenConfig {
  row: VircleChatConfigRow
  signingSecret: string
  apiToken: string
}

export function openConfig(row: VircleChatConfigRow): OpenConfig {
  return { row, signingSecret: decrypt(row.signing_secret), apiToken: decrypt(row.api_token) }
}

/** The connection a webhook names, by workspace key. Null when there is none. */
export async function findConfigByKey(admin: SupabaseClient, workspaceKey: string): Promise<VircleChatConfigRow | null> {
  if (!WORKSPACE_KEY_PATTERN.test(workspaceKey)) return null
  const { data, error } = await admin.from('vircle_chat_config').select('*').eq('workspace_key', workspaceKey).maybeSingle()
  if (error) throw error
  return (data as VircleChatConfigRow | null) ?? null
}

export async function findConfigForAccount(admin: SupabaseClient, accountId: string): Promise<VircleChatConfigRow | null> {
  const { data, error } = await admin.from('vircle_chat_config').select('*').eq('account_id', accountId).maybeSingle()
  if (error) throw error
  return (data as VircleChatConfigRow | null) ?? null
}
