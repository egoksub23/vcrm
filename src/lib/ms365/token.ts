import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { refreshAccessToken } from './oauth'
import { GraphApiError } from './errors'

export interface EmailConfigRow {
  id: string
  account_id: string
  access_token: string
  access_token_expires_at: string
  refresh_token: string
  [key: string]: unknown
}

// Refresh a bit before actual expiry so a slow request never crosses
// the line mid-flight — 5 minutes of slack against a ~60 minute token.
const REFRESH_SKEW_MS = 5 * 60 * 1000

/**
 * Returns a valid (unexpired) Graph access token for this config row,
 * refreshing and persisting a new access/refresh token pair first if
 * the stored one is at or near expiry. Microsoft rotates the refresh
 * token on every use, so both columns are rewritten together — which
 * means this persistence is load-bearing for every send/webhook fetch
 * after the first: skip it and the NEXT refresh attempt reuses an
 * already-spent refresh token, which Microsoft rejects outright.
 *
 * Always writes via the service-role admin client, regardless of what
 * client the caller otherwise uses (the dashboard's send path may hand
 * this an RLS-scoped agent-level client that can't UPDATE `email_config`
 * per migration 056's admin-only write policy) — a token refresh is an
 * internal system operation, not something that should be gated by the
 * signed-in user's role.
 *
 * On a refresh failure caused by a dead refresh token (revoked,
 * expired, or the user removed the app's access from their Microsoft
 * account), flips `needs_reauth` on the row and rethrows — callers
 * (the send path, the webhook's message fetch) surface this as a
 * normal channel error, same as Messenger/Instagram's `code === 190`
 * handling.
 */
export async function getValidAccessToken(config: EmailConfigRow): Promise<string> {
  const expiresAt = new Date(config.access_token_expires_at).getTime()
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return decrypt(config.access_token)
  }

  const admin = supabaseAdmin()
  const refreshToken = decrypt(config.refresh_token)
  try {
    const tokens = await refreshAccessToken({ refreshToken })
    const expiresAtIso = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString()
    await admin
      .from('email_config')
      .update({
        access_token: encrypt(tokens.accessToken),
        access_token_expires_at: expiresAtIso,
        refresh_token: encrypt(tokens.refreshToken),
        needs_reauth: false,
      })
      .eq('id', config.id)
    return tokens.accessToken
  } catch (err) {
    if (err instanceof GraphApiError && err.code === 'invalid_grant') {
      await admin.from('email_config').update({ needs_reauth: true }).eq('id', config.id)
    }
    throw err
  }
}
