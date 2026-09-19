import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { claimWebhookEvent, ingestComment, setCommentStatusByExternalId, type IncomingPost } from './ingest'
import { getFacebookPost, getInstagramMedia } from './meta-comments'

// ============================================================
// Comment events from Meta's webhooks:
//   object "page"      → entry.changes[].field "feed"   (Facebook, incl. ads)
//   object "instagram" → entry.changes[].field "comments" / "live_comments"
// Both arrive on the same webhook URLs the DM channels already use, so the
// Messenger / Instagram routes hand `entry.changes` here.
// ============================================================

export interface MetaEntryWithChanges {
  id: string
  time?: number
  changes?: { field?: string; value?: Record<string, unknown> }[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** created_time / entry.time are epoch seconds (sometimes ISO). */
function toDate(v: unknown, fallbackSeconds?: number): Date {
  if (typeof v === 'number') return new Date(v * 1000)
  if (typeof v === 'string' && v) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date((fallbackSeconds ?? Date.now() / 1000) * 1000)
}

/** Does this webhook entry carry anything for the comments module? */
export function hasCommentChanges(entry: MetaEntryWithChanges): boolean {
  return (entry.changes ?? []).some(
    (c) => c.field === 'feed' || c.field === 'comments' || c.field === 'live_comments',
  )
}

export async function processMetaCommentChanges(
  db: SupabaseClient,
  object: 'page' | 'instagram',
  entry: MetaEntryWithChanges,
): Promise<void> {
  try {
    if (object === 'page') await processFacebook(db, entry)
    else await processInstagram(db, entry)
  } catch (err) {
    console.error(`[comments] ${object} change processing failed:`, err)
  }
}

async function postExists(db: SupabaseClient, accountId: string, provider: string, externalPostId: string) {
  const { data } = await db
    .from('comment_posts')
    .select('id')
    .eq('account_id', accountId)
    .eq('provider', provider)
    .eq('external_post_id', externalPostId)
    .maybeSingle()
  return !!data
}

async function processFacebook(db: SupabaseClient, entry: MetaEntryWithChanges) {
  const { data: cfg } = await db
    .from('messenger_config')
    .select('account_id, page_id, page_access_token, comments_enabled_at')
    .eq('page_id', entry.id)
    .eq('status', 'connected')
    .maybeSingle()
  if (!cfg) return
  const accountId = cfg.account_id as string
  const pageId = cfg.page_id as string

  for (const change of entry.changes ?? []) {
    if (change.field !== 'feed') continue
    const v = change.value ?? {}
    if (v.item !== 'comment') continue

    const commentId = str(v.comment_id)
    const postId = str(v.post_id)
    if (!commentId || !postId) continue
    const verb = str(v.verb) ?? 'add'
    const created = toDate(v.created_time, entry.time)

    if (!(await claimWebhookEvent(db, 'facebook', `${commentId}:${verb}:${created.getTime()}`))) continue

    if (verb === 'remove' || verb === 'delete') {
      await setCommentStatusByExternalId(db, accountId, 'facebook', commentId, 'deleted')
      continue
    }
    if (verb === 'hide' || verb === 'hidden') {
      await setCommentStatusByExternalId(db, accountId, 'facebook', commentId, 'hidden')
      continue
    }
    if (verb === 'unhide') {
      await setCommentStatusByExternalId(db, accountId, 'facebook', commentId, 'visible')
      continue
    }

    const from = obj(v.from)
    const authorId = str(from.id)
    const parent = str(v.parent_id)
    const post: IncomingPost = { provider: 'facebook', channelRefId: pageId, externalPostId: postId }

    // First time we see this post: pull its caption / picture / link (and
    // whether it is an ad, i.e. an unpublished "dark" post).
    if (!(await postExists(db, accountId, 'facebook', postId))) {
      try {
        const info = await getFacebookPost({ postId, token: decrypt(cfg.page_access_token as string) })
        if (info) {
          post.message = info.message ?? null
          post.permalinkUrl = info.permalink_url ?? null
          post.mediaUrl = info.full_picture ?? null
          post.postedAt = info.created_time ? new Date(info.created_time) : null
          if (info.is_published === false) post.source = 'ad'
        }
      } catch (err) {
        console.error('[comments] facebook post lookup failed:', err)
      }
    }

    await ingestComment(db, accountId, post, {
      externalCommentId: commentId,
      // A top-level comment's parent is the post itself.
      parentExternalId: parent && parent !== postId ? parent : null,
      direction: authorId === pageId ? 'outbound' : 'inbound',
      authorExternalId: authorId,
      authorName: str(from.name),
      text: str(v.message),
      attachmentUrl: str(v.photo) ?? str(v.video),
      providerCreatedAt: created,
    })
  }
}

async function processInstagram(db: SupabaseClient, entry: MetaEntryWithChanges) {
  const { data: cfg } = await db
    .from('instagram_config')
    .select('account_id, ig_business_account_id, page_access_token')
    .or(`ig_business_account_id.eq.${entry.id},page_id.eq.${entry.id}`)
    .eq('status', 'connected')
    .maybeSingle()
  if (!cfg) return
  const accountId = cfg.account_id as string
  const igId = cfg.ig_business_account_id as string

  for (const change of entry.changes ?? []) {
    if (change.field !== 'comments' && change.field !== 'live_comments') continue
    const v = change.value ?? {}
    const commentId = str(v.id)
    const media = obj(v.media)
    const mediaId = str(media.id)
    if (!commentId || !mediaId) continue
    const created = toDate(undefined, entry.time)

    if (!(await claimWebhookEvent(db, 'instagram', `${commentId}:${change.field}:${entry.time ?? 0}`))) continue

    const from = obj(v.from)
    const authorId = str(from.id)
    const post: IncomingPost = {
      provider: 'instagram',
      channelRefId: igId,
      externalPostId: mediaId,
      mediaType: str(media.media_product_type)?.toLowerCase() ?? null,
    }
    if (!(await postExists(db, accountId, 'instagram', mediaId))) {
      try {
        const info = await getInstagramMedia({ mediaId, token: decrypt(cfg.page_access_token as string) })
        if (info) {
          post.message = info.caption ?? null
          post.permalinkUrl = info.permalink ?? null
          post.mediaUrl = info.thumbnail_url ?? info.media_url ?? null
          post.postedAt = info.timestamp ? new Date(info.timestamp) : null
        }
      } catch (err) {
        console.error('[comments] instagram media lookup failed:', err)
      }
    }

    await ingestComment(db, accountId, post, {
      externalCommentId: commentId,
      parentExternalId: str(v.parent_id),
      direction: authorId === igId ? 'outbound' : 'inbound',
      authorExternalId: authorId,
      authorUsername: str(from.username),
      authorName: str(from.username),
      text: str(v.text),
      providerCreatedAt: created,
    })
  }
}
