// ============================================================
// Rotating one of a workspace's two Vircle Chat secrets. The new value is
// generated here, stored only as ciphertext, and handed back once so the
// route can show it; the old value stops working immediately (the gateway
// team must be given the new one).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { generateApiToken, generateSigningSecret, sealSecret } from './config'

export type RotatableSecret = 'signing_secret' | 'api_token'

/** The new plaintext secret, or null when the workspace has no connection. Throws on a database error. */
export async function rotateConnectionSecret(
  admin: SupabaseClient,
  accountId: string,
  column: RotatableSecret,
): Promise<string | null> {
  const plain = column === 'signing_secret' ? generateSigningSecret() : generateApiToken()
  const { data, error } = await admin
    .from('vircle_chat_config')
    .update({ [column]: sealSecret(plain), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .select('id')
    .maybeSingle()
  if (error) throw error
  return data ? plain : null
}
