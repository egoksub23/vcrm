import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isMirroredPostMedia, mirrorPostMedia } from './mirror-post-media'
import { getFacebookPost, getInstagramMedia } from './meta-comments'

// ============================================================
// Put a post's picture back when its stored link has died.
//
// Meta hands out a fresh picture link every time the post is asked for, so, unlike a WhatsApp attachment, a dead thumbnail can be recovered: ask
// again with the workspace's own page token, keep a copy in our storage, and point the post at the copy. Called when a thumbnail fails to load.
// ============================================================

export type RefreshResult =
  | { ok: true; mediaUrl: string; changed: boolean }
  | { ok: false; reason: 'not_found' | 'unsupported' | 'not_connected' | 'unavailable' }

interface PostRow {
  id: string
  provider: string
  channel_ref_id: string | null
  external_post_id: string
  media_url: string | null
}

/** The post's own page token: Facebook posts belong to a Messenger page, Instagram posts to the Instagram business account. */
async function tokenFor(db: SupabaseClient, accountId: string, post: PostRow): Promise<string | null> {
  if (!post.channel_ref_id) return null
  const [table, column] = post.provider === 'facebook' ? ['messenger_config', 'page_id'] : ['instagram_config', 'ig_business_account_id']
  const { data } = await db
    .from(table)
    .select('page_access_token')
    .eq('account_id', accountId)
    .eq(column, post.channel_ref_id)
    .eq('status', 'connected')
    .maybeSingle()
  const sealed = (data as { page_access_token?: string } | null)?.page_access_token
  if (!sealed) return null
  try {
    return decrypt(sealed)
  } catch {
    return null
  }
}

export async function refreshPostMedia(db: SupabaseClient, accountId: string, postId: string): Promise<RefreshResult> {
  const { data } = await db
    .from('comment_posts')
    .select('id, provider, channel_ref_id, external_post_id, media_url')
    .eq('account_id', accountId)
    .eq('id', postId)
    .maybeSingle()
  const post = data as PostRow | null
  if (!post) return { ok: false, reason: 'not_found' }
  // Our own copy does not expire, so there is nothing to ask Meta for (and a broken image here is not a stale link).
  if (isMirroredPostMedia(post.media_url, accountId)) return { ok: true, mediaUrl: post.media_url as string, changed: false }
  if (post.provider !== 'facebook' && post.provider !== 'instagram') return { ok: false, reason: 'unsupported' }

  const token = await tokenFor(db, accountId, post)
  if (!token) return { ok: false, reason: 'not_connected' }

  let fresh: string | null = null
  if (post.provider === 'facebook') {
    fresh = (await getFacebookPost({ postId: post.external_post_id, token }))?.full_picture ?? null
  } else {
    const info = await getInstagramMedia({ mediaId: post.external_post_id, token })
    fresh = info?.thumbnail_url ?? info?.media_url ?? null
  }
  if (!fresh) return { ok: false, reason: 'unavailable' }

  // A copy of our own when it can be made; otherwise the fresh link, which is at least good for a while.
  const kept = (await mirrorPostMedia({ db, accountId, provider: post.provider, externalPostId: post.external_post_id, sourceUrl: fresh })) ?? fresh
  const { error } = await db.from('comment_posts').update({ media_url: kept }).eq('account_id', accountId).eq('id', post.id)
  if (error) return { ok: false, reason: 'unavailable' }
  return { ok: true, mediaUrl: kept, changed: kept !== post.media_url }
}
