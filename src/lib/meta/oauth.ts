/**
 * Meta "Connect with Facebook" OAuth (Facebook Login for Business) —
 * shared by the Messenger and Instagram DM connect flows.
 *
 * Uses the SAME Meta App as WhatsApp (`META_APP_ID`/`META_APP_SECRET`,
 * already required for the WhatsApp integration) — Messenger/Instagram
 * are just additional products + permission scopes added to that one
 * app in Meta for Developers, not a second App ID.
 *
 * `META_APP_SECRET` may hold several comma-separated secrets (multi-
 * WABA support, see `src/lib/whatsapp/webhook-signature.ts`). OAuth code
 * exchange authenticates as ONE specific app, so this always uses the
 * first configured secret — the common case (docs/multi-waba.md's
 * "Setup A") is a single app anyway.
 */

import { MetaApiError, throwMetaError } from './errors'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`
const OAUTH_DIALOG_BASE = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`

function appId(): string {
  const id = process.env.META_APP_ID
  if (!id) throw new Error('META_APP_ID is not configured')
  return id
}

function appSecret(): string {
  const raw = process.env.META_APP_SECRET
  const first = raw?.split(',')[0]?.trim()
  if (!first) throw new Error('META_APP_SECRET is not configured')
  return first
}

export type MetaOAuthChannel = 'messenger' | 'instagram'

const MESSENGER_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_read_engagement',
  'business_management',
]
const INSTAGRAM_SCOPES = [
  'pages_show_list',
  'instagram_basic',
  'instagram_manage_messages',
  'pages_read_engagement',
  'business_management',
]

export function buildMetaOAuthUrl(args: {
  channel: MetaOAuthChannel
  state: string
  redirectUri: string
}): string {
  const scopes = args.channel === 'messenger' ? MESSENGER_SCOPES : INSTAGRAM_SCOPES
  const params = new URLSearchParams({
    client_id: appId(),
    redirect_uri: args.redirectUri,
    state: args.state,
    scope: scopes.join(','),
    response_type: 'code',
  })
  return `${OAUTH_DIALOG_BASE}?${params.toString()}`
}

interface MetaTokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
}

export async function exchangeCodeForUserToken(args: {
  code: string
  redirectUri: string
}): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: args.redirectUri,
    code: args.code,
  })
  const response = await fetch(`${META_API_BASE}/oauth/access_token?${params.toString()}`)
  if (!response.ok) {
    await throwMetaError(response, `Meta OAuth code exchange failed: ${response.status}`)
  }
  const data = (await response.json()) as MetaTokenResponse
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 0 }
}

export async function exchangeForLongLivedToken(args: {
  shortLivedToken: string
}): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId(),
    client_secret: appSecret(),
    fb_exchange_token: args.shortLivedToken,
  })
  const response = await fetch(`${META_API_BASE}/oauth/access_token?${params.toString()}`)
  if (!response.ok) {
    await throwMetaError(response, `Meta long-lived token exchange failed: ${response.status}`)
  }
  const data = (await response.json()) as MetaTokenResponse
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 0 }
}

export interface MetaPage {
  id: string
  name: string
}

/** Page id/name only — never a token. See file header + oauth_pending_connections. */
export async function listUserPages(args: { userAccessToken: string }): Promise<MetaPage[]> {
  const params = new URLSearchParams({ fields: 'id,name', access_token: args.userAccessToken })
  const response = await fetch(`${META_API_BASE}/me/accounts?${params.toString()}`)
  if (!response.ok) {
    await throwMetaError(response, `Failed to list Pages: ${response.status}`)
  }
  const data = (await response.json()) as { data: MetaPage[] }
  return data.data ?? []
}

/**
 * Fetches ONE Page's access token on demand — never cached alongside
 * the id/name list in `listUserPages`. Called once, at `finalize` time,
 * for the specific Page the admin picked.
 */
export async function getPageAccessToken(args: {
  userAccessToken: string
  pageId: string
}): Promise<{ id: string; name: string; accessToken: string } | null> {
  const params = new URLSearchParams({
    fields: 'id,name,access_token',
    access_token: args.userAccessToken,
  })
  const response = await fetch(`${META_API_BASE}/me/accounts?${params.toString()}`)
  if (!response.ok) {
    await throwMetaError(response, `Failed to fetch Page token: ${response.status}`)
  }
  const data = (await response.json()) as {
    data: Array<{ id: string; name: string; access_token: string }>
  }
  const match = data.data?.find((p) => p.id === args.pageId)
  if (!match) return null
  return { id: match.id, name: match.name, accessToken: match.access_token }
}

export async function getInstagramBusinessAccount(args: {
  pageId: string
  pageAccessToken: string
}): Promise<{ id: string; username?: string } | null> {
  const params = new URLSearchParams({
    fields: 'instagram_business_account{id,username}',
    access_token: args.pageAccessToken,
  })
  const response = await fetch(`${META_API_BASE}/${args.pageId}?${params.toString()}`)
  if (!response.ok) {
    await throwMetaError(response, `Failed to resolve Instagram account: ${response.status}`)
  }
  const data = (await response.json()) as {
    instagram_business_account?: { id: string; username?: string }
  }
  if (!data.instagram_business_account) return null
  return data.instagram_business_account
}

/**
 * Absolute origin for building the OAuth `redirect_uri` — this value
 * must exactly match a URI registered in the Meta App's Facebook Login
 * for Business settings, so `NEXT_PUBLIC_SITE_URL` (explicit operator
 * config, already used for invite links — see
 * `src/app/api/account/invitations/route.ts`) is preferred over
 * guessing from request headers.
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

export { MetaApiError }
