/**
 * Microsoft identity platform v2.0 OAuth (delegated permissions) —
 * "Connect Microsoft 365" for the Email channel. Structurally mirrors
 * `src/lib/meta/oauth.ts`, but talks to Microsoft's endpoints and uses
 * a real refresh-token dance (Graph access tokens expire in ~1 hour —
 * see `src/lib/ms365/token.ts` for the refresh side of this).
 *
 * `MS365_TENANT_ID` defaults to `common`, which accepts sign-in from
 * any Microsoft work/school or personal account — the right default
 * for a CRM operator connecting their own mailbox, not a multi-tenant
 * ISV scenario. An operator whose org restricts consent to a specific
 * tenant can override it.
 */

import { GraphApiError, throwGraphError } from './errors'

const AUTHORITY_BASE = 'https://login.microsoftonline.com'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

function tenant(): string {
  return process.env.MS365_TENANT_ID?.trim() || 'common'
}

function clientId(): string {
  const id = process.env.MS365_CLIENT_ID
  if (!id) throw new Error('MS365_CLIENT_ID is not configured')
  return id
}

function clientSecret(): string {
  const secret = process.env.MS365_CLIENT_SECRET
  if (!secret) throw new Error('MS365_CLIENT_SECRET is not configured')
  return secret
}

// offline_access is what earns a refresh_token in the response.
// Calendars.ReadWrite is for Sembang "Schedule a meeting" (P4) — an
// already-connected account only picks this up on its next reconnect,
// since Microsoft won't grant a new scope to an existing consent grant
// without the user going through it again.
const SCOPES = ['offline_access', 'Mail.Read', 'Mail.Send', 'User.Read', 'Calendars.ReadWrite']

export function buildMs365OAuthUrl(args: { state: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: args.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state: args.state,
    // Always show the account picker — the admin connecting a mailbox
    // may be signed into a different Microsoft account in their browser.
    prompt: 'select_account',
  })
  return `${AUTHORITY_BASE}/${tenant()}/oauth2/v2.0/authorize?${params.toString()}`
}

interface Ms365TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

export interface Ms365TokenSet {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
}

async function requestToken(body: URLSearchParams): Promise<Ms365TokenSet> {
  const response = await fetch(`${AUTHORITY_BASE}/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    // Microsoft's token endpoint uses `{error, error_description}`, not
    // Graph's `{error: {code, message}}` envelope — read it directly
    // rather than forcing it through readGraphError's shape.
    let message = `Microsoft OAuth token request failed: ${response.status}`
    let code: string | null = null
    try {
      const data = (await response.json()) as { error?: string; error_description?: string }
      code = data.error ?? null
      if (data.error_description) message = data.error_description
    } catch {
      // keep the fallback
    }
    throw new GraphApiError(message, { code, httpStatus: response.status })
  }
  const data = (await response.json()) as Ms365TokenResponse
  if (!data.refresh_token) {
    throw new Error(
      'Microsoft did not return a refresh_token — was the offline_access scope granted?',
    )
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: data.expires_in,
  }
}

export async function exchangeCodeForTokens(args: {
  code: string
  redirectUri: string
}): Promise<Ms365TokenSet> {
  return requestToken(
    new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: args.redirectUri,
      grant_type: 'authorization_code',
      code: args.code,
      scope: SCOPES.join(' '),
    }),
  )
}

/**
 * Refreshes an access token. Microsoft rotates refresh tokens on every
 * use — the returned `refreshToken` MUST replace the stored one, not
 * just the access token, or the next refresh will fail.
 */
export async function refreshAccessToken(args: { refreshToken: string }): Promise<Ms365TokenSet> {
  return requestToken(
    new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
      scope: SCOPES.join(' '),
    }),
  )
}

export interface Ms365MailboxProfile {
  id: string
  address: string
}

export async function getMailboxProfile(args: { accessToken: string }): Promise<Ms365MailboxProfile> {
  const response = await fetch(`${GRAPH_BASE}/me?$select=id,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })
  if (!response.ok) {
    await throwGraphError(response, `Failed to fetch mailbox profile: ${response.status}`)
  }
  const data = (await response.json()) as { id: string; mail?: string; userPrincipalName?: string }
  const address = data.mail || data.userPrincipalName
  if (!address) {
    throw new Error('Microsoft account has neither a mail address nor a userPrincipalName')
  }
  return { id: data.id, address }
}

/**
 * Absolute origin for the OAuth `redirect_uri` — must exactly match a
 * Redirect URI registered on the Azure AD app registration. Same
 * `NEXT_PUBLIC_SITE_URL`-preferred resolution as `src/lib/meta/oauth.ts`'s
 * `getOAuthBaseUrl`, duplicated here rather than imported so this
 * module has zero dependency on the Meta channel code.
 */
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
