import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { claimWebhookEvent, ingestComment, setCommentStatusByExternalId, type IncomingPost } from '../ingest'
import {
  listTikTokComments,
  listTikTokVideos,
  refreshTikTokToken,
  TikTokApiError,
  type TikTokComment,
  type TikTokVideo,
} from './api'
import type { TikTokCommentEvent } from './webhook'

// ============================================================
// A connected TikTok account: keeping its token fresh, pulling comments
// (Sync button and the webhook's follow-up lookups), and applying
// `comment.update` events.
// ============================================================

/** Refresh when fewer than this many ms of access-token life remain. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export class TikTokReauthRequired extends Error {
  constructor() {
    super('TikTok needs to be reconnected.')
    this.name = 'TikTokReauthRequired'
  }
}

export interface TikTokAccess {
  accountId: string
  openId: string
  token: string
}

/**
 * The account's TikTok token, refreshed first when it is close to expiring
 * (access tokens only live a day). A failed refresh flags the connection
 * for reconnect instead of retrying forever.
 */
export async function getTikTokAccess(db: SupabaseClient, accountId: string): Promise<TikTokAccess | null> {
  const { data: cfg } = await db
    .from('tiktok_config')
    .select('open_id, access_token, refresh_token, access_expires_at, refresh_expires_at, needs_reauth, status, enabled')
    .eq('account_id', accountId)
    .maybeSingle()
  // `enabled` (migration 097) is a manual pause, independent of `status`.
  if (!cfg || cfg.status !== 'connected' || !cfg.enabled) return null
  if (cfg.needs_reauth) throw new TikTokReauthRequired()

  const openId = cfg.open_id as string
  const expiresAt = new Date(cfg.access_expires_at as string).getTime()
  if (expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return { accountId, openId, token: decrypt(cfg.access_token as string) }
  }

  try {
    if (new Date(cfg.refresh_expires_at as string).getTime() <= Date.now()) throw new TikTokReauthRequired()
    const t = await refreshTikTokToken({ refreshToken: decrypt(cfg.refresh_token as string), openId })
    await db
      .from('tiktok_config')
      .update({
        access_token: encrypt(t.accessToken),
        refresh_token: encrypt(t.refreshToken),
        access_expires_at: t.accessExpiresAt.toISOString(),
        refresh_expires_at: t.refreshExpiresAt.toISOString(),
        needs_reauth: false,
      })
      .eq('account_id', accountId)
    return { accountId, openId, token: t.accessToken }
  } catch (err) {
    console.error('[tiktok] token refresh failed:', err)
    await db.from('tiktok_config').update({ needs_reauth: true }).eq('account_id', accountId)
    throw new TikTokReauthRequired()
  }
}

function videoToPost(openId: string, v: TikTokVideo): IncomingPost {
  return {
    provider: 'tiktok',
    source: v.is_ad ? 'ad' : 'organic',
    channelRefId: openId,
    externalPostId: String(v.item_id),
    message: v.caption ?? null,
    permalinkUrl: v.share_url ?? null,
    mediaUrl: v.thumbnail_url ?? null,
    mediaType: v.media_type?.toLowerCase() ?? 'video',
    postedAt: v.create_time ? new Date(v.create_time * 1000) : null,
  }
}

/** Save a batch of videos as posts (without touching last_comment_at). */
async function upsertVideos(db: SupabaseClient, accountId: string, openId: string, videos: TikTokVideo[]) {
  if (videos.length === 0) return
  const rows = videos.map((v) => {
    const p = videoToPost(openId, v)
    return {
      account_id: accountId,
      provider: 'tiktok',
      source: p.source,
      channel_ref_id: openId,
      external_post_id: p.externalPostId,
      message: p.message,
      permalink_url: p.permalinkUrl,
      media_url: p.mediaUrl,
      media_type: p.mediaType,
      posted_at: p.postedAt?.toISOString() ?? null,
    }
  })
  const { error } = await db.from('comment_posts').upsert(rows, { onConflict: 'account_id,provider,external_post_id' })
  if (error) console.error('[tiktok] post upsert failed:', error)
}

async function ingestTikTokComment(
  db: SupabaseClient,
  a: TikTokAccess,
  videoId: string,
  c: TikTokComment,
  post: IncomingPost,
) {
  return ingestComment(db, a.accountId, post, {
    externalCommentId: String(c.comment_id),
    parentExternalId: c.parent_comment_id ? String(c.parent_comment_id) : null,
    direction: c.owner ? 'outbound' : 'inbound',
    authorExternalId: c.unique_identifier ?? null,
    authorName: c.display_name ?? c.username ?? null,
    authorUsername: c.username ?? null,
    authorAvatarUrl: c.profile_image ?? null,
    text: c.text ?? null,
    attachmentUrl: c.image_url ?? null,
    status: c.status === 'HIDDEN' ? 'hidden' : 'visible',
    providerCreatedAt: c.create_time ? new Date(Number(c.create_time) * 1000) : new Date(),
  })
}

/**
 * Pull recent comments for the newest videos. Used by the Sync button and
 * as a safety net for missed webhook events. Kept small: TikTok allows
 * 40 calls a minute per endpoint.
 */
export async function syncTikTokComments(
  db: SupabaseClient,
  accountId: string,
  opts: { videoLimit?: number } = {},
): Promise<{ videos: number; comments: number; newComments: number }> {
  const access = await getTikTokAccess(db, accountId)
  if (!access) return { videos: 0, comments: 0, newComments: 0 }

  const videos = (await listTikTokVideos({ token: access.token, openId: access.openId, maxCount: 20 })).slice(
    0,
    opts.videoLimit ?? 10,
  )
  await upsertVideos(db, accountId, access.openId, videos)

  let comments = 0
  let newComments = 0
  for (const v of videos) {
    const post = videoToPost(access.openId, v)
    let page
    try {
      page = await listTikTokComments({
        token: access.token,
        openId: access.openId,
        videoId: String(v.item_id),
        includeReplies: true,
        maxCount: 30,
      })
    } catch (err) {
      // One video failing (rate limit, removed) must not stop the rest.
      console.error(`[tiktok] comment list failed for video ${v.item_id}:`, err)
      if (err instanceof TikTokApiError && err.httpStatus === 401) throw new TikTokReauthRequired()
      continue
    }
    for (const c of page.comments) {
      const r = await ingestTikTokComment(db, access, String(v.item_id), c, post)
      comments++
      if (r?.isNew) newComments++
      // Replies come inline when requested.
      const replies = (c as unknown as { reply_list?: TikTokComment[] }).reply_list ?? []
      for (const reply of replies) {
        const rr = await ingestTikTokComment(db, access, String(v.item_id), { ...reply, parent_comment_id: c.comment_id }, post)
        comments++
        if (rr?.isNew) newComments++
      }
    }
  }
  await db.from('tiktok_config').update({ last_synced_at: new Date().toISOString() }).eq('account_id', accountId)
  return { videos: videos.length, comments, newComments }
}

/**
 * Apply one `comment.update` webhook event. The push carries only text and
 * an anonymous id, so a new comment is looked up for the commenter's name
 * and the video's details.
 */
export async function applyTikTokCommentEvent(db: SupabaseClient, event: TikTokCommentEvent): Promise<void> {
  const { data: cfg } = await db
    .from('tiktok_config')
    .select('account_id')
    .eq('open_id', event.userOpenId)
    .eq('status', 'connected')
    // Manually paused (migration 097) — ack the webhook, drop the event.
    .eq('enabled', true)
    .maybeSingle()
  if (!cfg) return
  const accountId = cfg.account_id as string

  if (!(await claimWebhookEvent(db, 'tiktok', `${event.commentId}:${event.action}:${event.timestamp}`))) return

  switch (event.action) {
    case 'delete':
      await setCommentStatusByExternalId(db, accountId, 'tiktok', event.commentId, 'deleted')
      return
    case 'set_to_hidden':
    case 'set_to_friends_only':
      await setCommentStatusByExternalId(db, accountId, 'tiktok', event.commentId, 'hidden')
      return
    case 'set_to_public':
      await setCommentStatusByExternalId(db, accountId, 'tiktok', event.commentId, 'visible')
      return
    case 'insert':
      break
    default:
      return
  }

  const access = await getTikTokAccess(db, accountId).catch(() => null)
  let post: IncomingPost = { provider: 'tiktok', channelRefId: event.userOpenId, externalPostId: event.videoId }
  let detail: TikTokComment | undefined

  if (access) {
    try {
      const { data: known } = await db
        .from('comment_posts')
        .select('id')
        .eq('account_id', accountId)
        .eq('provider', 'tiktok')
        .eq('external_post_id', event.videoId)
        .maybeSingle()
      if (!known) {
        const videos = await listTikTokVideos({ token: access.token, openId: access.openId, maxCount: 20 })
        await upsertVideos(db, accountId, access.openId, videos)
        const v = videos.find((x) => String(x.item_id) === event.videoId)
        if (v) post = videoToPost(access.openId, v)
      }
      const found = await listTikTokComments({
        token: access.token,
        openId: access.openId,
        videoId: event.videoId,
        commentIds: [event.commentId],
        maxCount: 1,
      })
      detail = found.comments[0]
    } catch (err) {
      console.error('[tiktok] webhook follow-up lookup failed:', err)
    }
  }

  await ingestComment(db, accountId, post, {
    externalCommentId: event.commentId,
    parentExternalId: event.parentCommentId,
    direction: detail?.owner ? 'outbound' : 'inbound',
    authorExternalId: detail?.unique_identifier ?? event.uniqueIdentifier,
    authorName: detail?.display_name ?? detail?.username ?? null,
    authorUsername: detail?.username ?? null,
    authorAvatarUrl: detail?.profile_image ?? null,
    text: detail?.text ?? event.text,
    attachmentUrl: detail?.image_url ?? null,
    status: detail?.status === 'HIDDEN' ? 'hidden' : 'visible',
    providerCreatedAt: new Date(event.timestamp),
  })
}
