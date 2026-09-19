/**
 * TikTok API for Business — Accounts API (organic comments).
 *
 * Built from TikTok's published docs; NOT yet exercised against a live
 * account (needs an approved developer app). Anything the docs left open
 * is noted where it matters.
 *
 * Auth: OAuth 2.0 authorization-code. Access tokens last 1 day, refresh
 * tokens 1 year. Calls send the token in an `Access-Token` header and
 * identify the account by `business_id` = the token response's `open_id`.
 * Ids (video, comment) are 19-digit numbers: always strings here, never
 * numbers.
 */

const BASE = 'https://business-api.tiktok.com/open_api/v1.3'

export class TikTokApiError extends Error {
  readonly code: number | null
  readonly requestId: string | null
  readonly httpStatus: number
  constructor(message: string, f: { code?: number | null; requestId?: string | null; httpStatus: number }) {
    super(message)
    this.name = 'TikTokApiError'
    this.code = f.code ?? null
    this.requestId = f.requestId ?? null
    this.httpStatus = f.httpStatus
  }
}

export function tiktokAppId(): string {
  const v = process.env.TIKTOK_APP_ID?.trim()
  if (!v) throw new Error('TIKTOK_APP_ID is not configured')
  return v
}

export function tiktokAppSecret(): string {
  const v = process.env.TIKTOK_APP_SECRET?.trim()
  if (!v) throw new Error('TIKTOK_APP_SECRET is not configured')
  return v
}

export function tiktokConfigured(): boolean {
  return !!process.env.TIKTOK_APP_ID?.trim() && !!process.env.TIKTOK_APP_SECRET?.trim()
}

export const TIKTOK_SCOPES = ['user.info.basic', 'video.list', 'comment.list', 'comment.list.manage']

/**
 * The URL to send the account owner to. TikTok shows each app its own
 * authorization URL in the developer portal; set it as TIKTOK_AUTH_URL and
 * we add `state` and `redirect_uri` to it. Without it we build the standard
 * shape from the app id.
 */
export function buildTikTokAuthUrl(args: { state: string; redirectUri: string }): string {
  const custom = process.env.TIKTOK_AUTH_URL?.trim()
  const url = new URL(custom || 'https://www.tiktok.com/v2/auth/authorize')
  if (!custom) {
    url.searchParams.set('client_key', tiktokAppId())
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', TIKTOK_SCOPES.join(','))
  }
  url.searchParams.set('state', args.state)
  url.searchParams.set('redirect_uri', args.redirectUri)
  return url.toString()
}

interface Envelope<T> {
  code?: number
  message?: string
  request_id?: string
  data?: T
}

async function call<T>(
  path: string,
  a: {
    method?: 'GET' | 'POST'
    token?: string
    query?: Record<string, string | number | undefined>
    body?: Record<string, unknown>
  },
): Promise<T> {
  const qs = a.query
    ? '?' +
      new URLSearchParams(
        Object.entries(a.query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : ''
  const res = await fetch(`${BASE}/${path}${qs}`, {
    method: a.method ?? (a.body ? 'POST' : 'GET'),
    headers: {
      ...(a.token ? { 'Access-Token': a.token } : {}),
      ...(a.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: a.body ? JSON.stringify(a.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let env: Envelope<T> = {}
  try {
    env = JSON.parse(text) as Envelope<T>
  } catch {
    // not JSON
  }
  if (!res.ok || (typeof env.code === 'number' && env.code !== 0)) {
    throw new TikTokApiError(env.message || `TikTok API error: ${res.status}`, {
      code: env.code,
      requestId: env.request_id,
      httpStatus: res.status,
    })
  }
  return (env.data ?? ({} as T)) as T
}

export interface TikTokTokens {
  accessToken: string
  refreshToken: string
  accessExpiresAt: Date
  refreshExpiresAt: Date
  openId: string
  scopes: string
}

interface TokenData {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_token_expires_in: number
  open_id?: string
  scope?: string
}

function toTokens(d: TokenData, fallbackOpenId?: string): TikTokTokens {
  const now = Date.now()
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    accessExpiresAt: new Date(now + d.expires_in * 1000),
    refreshExpiresAt: new Date(now + d.refresh_token_expires_in * 1000),
    openId: d.open_id ?? fallbackOpenId ?? '',
    scopes: d.scope ?? '',
  }
}

export async function exchangeTikTokCode(a: { code: string; redirectUri: string }): Promise<TikTokTokens> {
  const d = await call<TokenData>('tt_user/oauth2/token/', {
    body: {
      client_id: tiktokAppId(),
      client_secret: tiktokAppSecret(),
      grant_type: 'authorization_code',
      auth_code: a.code,
      redirect_uri: a.redirectUri,
    },
  })
  if (!d.open_id) throw new TikTokApiError('TikTok did not return an account id.', { httpStatus: 200 })
  return toTokens(d)
}

/** Refreshing returns a NEW refresh token; store it. */
export async function refreshTikTokToken(a: { refreshToken: string; openId: string }): Promise<TikTokTokens> {
  const d = await call<TokenData>('tt_user/oauth2/refresh_token/', {
    body: {
      client_id: tiktokAppId(),
      client_secret: tiktokAppSecret(),
      grant_type: 'refresh_token',
      refresh_token: a.refreshToken,
    },
  })
  return toTokens(d, a.openId)
}

export interface TikTokAccountInfo {
  displayName: string | null
  username: string | null
}

/** Best effort: the connected account's name for the Settings panel. */
export async function getTikTokAccountInfo(a: { token: string; openId: string }): Promise<TikTokAccountInfo> {
  try {
    const d = await call<{ display_name?: string; username?: string }>('business/get/', {
      token: a.token,
      query: { business_id: a.openId, fields: JSON.stringify(['username', 'display_name']) },
    })
    return { displayName: d.display_name ?? null, username: d.username ?? null }
  } catch {
    return { displayName: null, username: null }
  }
}

export interface TikTokVideo {
  item_id: string
  caption?: string
  share_url?: string
  thumbnail_url?: string
  create_time?: number
  media_type?: string
  is_ad?: boolean
}

export async function listTikTokVideos(a: { token: string; openId: string; maxCount?: number }): Promise<TikTokVideo[]> {
  const d = await call<{ videos?: TikTokVideo[] }>('business/video/list/', {
    token: a.token,
    query: {
      business_id: a.openId,
      fields: JSON.stringify(['item_id', 'create_time', 'caption', 'share_url', 'thumbnail_url', 'media_type', 'is_ad']),
      max_count: a.maxCount ?? 20,
    },
  })
  return d.videos ?? []
}

export interface TikTokComment {
  comment_id: string
  video_id: string
  parent_comment_id?: string
  unique_identifier?: string
  create_time?: string
  text?: string
  owner?: boolean
  status?: 'PUBLIC' | 'HIDDEN'
  username?: string
  display_name?: string
  profile_image?: string
  image_url?: string
}

export async function listTikTokComments(a: {
  token: string
  openId: string
  videoId: string
  commentIds?: string[]
  includeReplies?: boolean
  maxCount?: number
  cursor?: number
}): Promise<{ comments: TikTokComment[]; cursor?: number; hasMore: boolean }> {
  const d = await call<{ comments?: TikTokComment[]; cursor?: number; has_more?: boolean }>('business/comment/list/', {
    token: a.token,
    query: {
      business_id: a.openId,
      video_id: a.videoId,
      comment_ids: a.commentIds ? JSON.stringify(a.commentIds) : undefined,
      include_replies: a.includeReplies ? 'true' : undefined,
      sort_field: 'create_time',
      sort_order: 'desc',
      max_count: a.maxCount ?? 30,
      cursor: a.cursor,
    },
  })
  return { comments: d.comments ?? [], cursor: d.cursor, hasMore: !!d.has_more }
}

export async function replyToTikTokComment(a: {
  token: string
  openId: string
  videoId: string
  commentId: string
  text: string
}): Promise<{ commentId: string | null }> {
  const d = await call<{ comment_id?: string }>('business/comment/reply/create/', {
    token: a.token,
    body: { business_id: a.openId, video_id: a.videoId, comment_id: a.commentId, text: a.text },
  })
  return { commentId: d.comment_id ?? null }
}

export async function setTikTokCommentHidden(a: {
  token: string
  openId: string
  videoId: string
  commentId: string
  hidden: boolean
}): Promise<void> {
  await call('business/comment/hide/', {
    token: a.token,
    body: {
      business_id: a.openId,
      video_id: a.videoId,
      comment_id: a.commentId,
      action: a.hidden ? 'HIDE' : 'UNHIDE',
    },
  })
}

/** Only the account's own comments can be deleted. */
export async function deleteTikTokComment(a: { token: string; openId: string; commentId: string }): Promise<void> {
  await call('business/comment/delete/', {
    token: a.token,
    body: { business_id: a.openId, comment_id: a.commentId },
  })
}

/**
 * Tell TikTok where to push `comment.update` events. This is per developer
 * APP (not per account) and uses the app secret, no access token.
 */
export async function registerTikTokCommentWebhook(a: { callbackUrl: string }): Promise<void> {
  await call('business/webhook/update/', {
    body: {
      app_id: tiktokAppId(),
      secret: tiktokAppSecret(),
      event_type: 'COMMENT',
      callback_url: a.callbackUrl,
    },
  })
}
