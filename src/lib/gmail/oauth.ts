/**
 * Google OAuth 2.0 (web server flow) — "Connect Gmail" for the Gmail
 * channel. Structurally close to `src/lib/ms365/oauth.ts`, with one
 * real difference: Google does NOT rotate the refresh token on every
 * use the way Microsoft does — `src/lib/gmail/token.ts` only rewrites
 * the stored refresh token on the (documented but uncommon) occasions
 * Google actually returns a new one.
 *
 * `access_type=offline&prompt=consent` is required to reliably get a
 * refresh_token back — Google only issues one on the FIRST consent for
 * a given user+app+scope set unless `prompt=consent` forces the
 * dialog every time, which matters here since a disconnect+reconnect
 * must produce a usable refresh token again.
 */

import { GmailApiError, throwGmailError } from './errors'

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

function clientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID
  if (!id) throw new Error('GOOGLE_CLIENT_ID is not configured')
  return id
}

function clientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!secret) throw new Error('GOOGLE_CLIENT_SECRET is not configured')
  return secret
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
]

export function buildGoogleOAuthUrl(args: { state: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: args.state,
    access_type: 'offline',
    prompt: 'consent',
  })
  return `${AUTH_BASE}?${params.toString()}`
}

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

export interface GoogleTokenSet {
  accessToken: string
  /** Only set when Google actually returned a (new) refresh token —
   *  absent on an ordinary access-token refresh, since Google doesn't
   *  rotate it on every use. */
  refreshToken?: string
  expiresInSeconds: number
}

async function requestToken(body: URLSearchParams): Promise<GoogleTokenSet> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    let message = `Google OAuth token request failed: ${response.status}`
    let status: string | null = null
    try {
      const data = (await response.json()) as { error?: string; error_description?: string }
      status = data.error ?? null
      if (data.error_description) message = data.error_description
    } catch {
      // keep the fallback
    }
    throw new GmailApiError(message, { httpStatus: response.status, status })
  }
  const data = (await response.json()) as GoogleTokenResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: data.expires_in,
  }
}

export async function exchangeCodeForTokens(args: {
  code: string
  redirectUri: string
}): Promise<GoogleTokenSet & { refreshToken: string }> {
  const tokens = await requestToken(
    new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: args.redirectUri,
      grant_type: 'authorization_code',
      code: args.code,
    }),
  )
  if (!tokens.refreshToken) {
    throw new Error(
      'Google did not return a refresh_token — was access_type=offline / prompt=consent applied?',
    )
  }
  return { ...tokens, refreshToken: tokens.refreshToken }
}

export async function refreshAccessToken(args: { refreshToken: string }): Promise<GoogleTokenSet> {
  return requestToken(
    new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
    }),
  )
}

export async function getUserEmailAddress(args: { accessToken: string }): Promise<string> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })
  if (!response.ok) {
    await throwGmailError(response, `Failed to fetch Google user info: ${response.status}`)
  }
  const data = (await response.json()) as { email?: string }
  if (!data.email) throw new Error('Google user info response had no email address')
  return data.email
}

/** Same NEXT_PUBLIC_SITE_URL-preferred resolution as the other
 *  channels' OAuth base-URL helpers, duplicated rather than imported
 *  so this module has zero dependency on the Meta/Microsoft channel
 *  code. */
export function getOAuthBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) {
    const reqProto = new URL(request.url).protocol.replace(':', '')
    return `${reqProto}://${host}`
  }

  throw new Error('Could not determine base URL for OAuth redirect — set NEXT_PUBLIC_SITE_URL')
}
