import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { refreshAccessToken } from './oauth'
import { GmailApiError } from './errors'

export interface GmailConfigRow {
  id: string
  account_id: string
  access_token: string
  access_token_expires_at: string
  refresh_token: string
  [key: string]: unknown
}

// Refresh a bit before actual expiry — same 5-minute skew as the
// Microsoft 365 channel's token.ts, against the same ~60 minute token.
const REFRESH_SKEW_MS = 5 * 60 * 1000

/**
 * Returns a valid (unexpired) Gmail access token for this config row,
 * refreshing and persisting a new one first if the stored token is at
 * or near expiry. Unlike Microsoft 365's equivalent, Google usually
 * does NOT return a new refresh_token on an ordinary refresh — only
 * the access token (and its expiry) gets rewritten in that case; the
 * refresh_token column is only touched when Google actually sends a
 * new one.
 *
 * Always writes via the service-role admin client, regardless of what
 * client the caller otherwise uses — same reasoning as
 * `src/lib/ms365/token.ts`: a token refresh is an internal system
 * operation, not something gated by the signed-in user's role, and the
 * dashboard's send path may hand this an RLS-scoped agent-level client
 * that can't UPDATE `gmail_config` per migration 058's admin-only
 * write policy.
 *
 * On a refresh failure caused by a dead refresh token (revoked, or the
 * user removed the app's access from their Google account), flips
 * `needs_reauth` on the row and rethrows — callers (the send path, the
 * webhook's message fetch) surface this as a normal channel error,
 * same as every other channel's reauth handling.
 */
export async function getValidAccessToken(config: GmailConfigRow): Promise<string> {
  const expiresAt = new Date(config.access_token_expires_at).getTime()
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return decrypt(config.access_token)
  }

  const admin = supabaseAdmin()
  const refreshToken = decrypt(config.refresh_token)
  try {
    const tokens = await refreshAccessToken({ refreshToken })
    const expiresAtIso = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString()
    const update: Record<string, unknown> = {
      access_token: encrypt(tokens.accessToken),
      access_token_expires_at: expiresAtIso,
      needs_reauth: false,
    }
    // Google usually omits refresh_token on a plain refresh — only
    // overwrite the stored one on the occasions it sends a new one.
    if (tokens.refreshToken) {
      update.refresh_token = encrypt(tokens.refreshToken)
    }
    await admin.from('gmail_config').update(update).eq('id', config.id)
    return tokens.accessToken
  } catch (err) {
    if (err instanceof GmailApiError && err.isAuthError) {
      await admin.from('gmail_config').update({ needs_reauth: true }).eq('id', config.id)
    }
    throw err
  }
}
