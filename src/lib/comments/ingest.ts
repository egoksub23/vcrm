import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommentProvider, CommentStatus } from './types'

// ============================================================
// Writing comments into the database, whatever provider they came from
// (webhook, sync, or a sample). Service-role client expected.
// ============================================================

export interface IncomingPost {
  provider: CommentProvider
  source?: 'organic' | 'ad'
  /** Page id | Instagram business account id | TikTok open_id. */
  channelRefId: string
  externalPostId: string
  message?: string | null
  permalinkUrl?: string | null
  mediaUrl?: string | null
  mediaType?: string | null
  postedAt?: Date | null
}

export interface IncomingComment {
  externalCommentId: string
  parentExternalId?: string | null
  direction?: 'inbound' | 'outbound'
  authorExternalId?: string | null
  authorName?: string | null
  authorUsername?: string | null
  authorAvatarUrl?: string | null
  text?: string | null
  attachmentUrl?: string | null
  status?: CommentStatus
  providerCreatedAt: Date
  isTest?: boolean
}

export interface IngestResult {
  commentId: string
  postId: string
  /** True the first time we see this comment (drives notifications). */
  isNew: boolean
}

/** Drop undefined keys so an update never blanks a column the incoming
 *  payload simply didn't mention. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** The contact this commenter already is, when we have their DM identity. */
async function matchContact(
  db: SupabaseClient,
  accountId: string,
  provider: CommentProvider,
  authorExternalId: string | null | undefined,
): Promise<string | null> {
  if (!authorExternalId || provider === 'tiktok') return null
  const column = provider === 'facebook' ? 'messenger_psid' : 'instagram_igsid'
  const { data } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq(column, authorExternalId)
    .limit(1)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/**
 * Insert or update a comment (and the post it sits under). Re-delivery is
 * safe: the same external comment id updates in place, and an update never
 * resets the agent's handled status or assignee.
 */
export async function ingestComment(
  db: SupabaseClient,
  accountId: string,
  post: IncomingPost,
  comment: IncomingComment,
): Promise<IngestResult | null> {
  const commentedAt = comment.providerCreatedAt.toISOString()

  const { data: postRow, error: postErr } = await db
    .from('comment_posts')
    .upsert(
      {
        account_id: accountId,
        provider: post.provider,
        source: post.source ?? 'organic',
        channel_ref_id: post.channelRefId,
        external_post_id: post.externalPostId,
        ...defined({
          message: post.message,
          permalink_url: post.permalinkUrl,
          media_url: post.mediaUrl,
          media_type: post.mediaType,
          posted_at: post.postedAt?.toISOString(),
        }),
        last_comment_at: commentedAt,
      },
      { onConflict: 'account_id,provider,external_post_id' },
    )
    .select('id')
    .single()
  if (postErr || !postRow) {
    console.error('[comments ingest] post upsert failed:', postErr)
    return null
  }

  const { data: existing } = await db
    .from('comments')
    .select('id')
    .eq('account_id', accountId)
    .eq('provider', post.provider)
    .eq('external_comment_id', comment.externalCommentId)
    .maybeSingle()

  let parentId: string | null = null
  if (comment.parentExternalId) {
    const { data: parent } = await db
      .from('comments')
      .select('id')
      .eq('account_id', accountId)
      .eq('provider', post.provider)
      .eq('external_comment_id', comment.parentExternalId)
      .maybeSingle()
    parentId = (parent?.id as string | undefined) ?? null
  }

  const direction = comment.direction ?? 'inbound'
  if (existing) {
    const { error } = await db
      .from('comments')
      .update(
        defined({
          text: comment.text,
          status: comment.status,
          author_name: comment.authorName,
          author_username: comment.authorUsername,
          author_avatar_url: comment.authorAvatarUrl,
          attachment_url: comment.attachmentUrl,
          parent_comment_id: parentId ?? undefined,
        }),
      )
      .eq('id', existing.id)
    if (error) console.error('[comments ingest] update failed:', error)
    return { commentId: existing.id as string, postId: postRow.id as string, isNew: false }
  }

  const contactId = await matchContact(db, accountId, post.provider, comment.authorExternalId)
  const { data: created, error } = await db
    .from('comments')
    .insert({
      account_id: accountId,
      post_id: postRow.id,
      provider: post.provider,
      external_comment_id: comment.externalCommentId,
      parent_comment_id: parentId,
      parent_external_id: comment.parentExternalId ?? null,
      direction,
      author_external_id: comment.authorExternalId ?? null,
      author_name: comment.authorName ?? null,
      author_username: comment.authorUsername ?? null,
      author_avatar_url: comment.authorAvatarUrl ?? null,
      contact_id: contactId,
      text: comment.text ?? null,
      attachment_url: comment.attachmentUrl ?? null,
      status: comment.status ?? 'visible',
      // Our own words never wait for an answer.
      handled_status: direction === 'outbound' ? 'resolved' : 'open',
      is_test: comment.isTest ?? false,
      provider_created_at: commentedAt,
    })
    .select('id')
    .single()

  if (error || !created) {
    // A concurrent delivery inserted it first — treat as the existing row.
    if ((error as { code?: string } | null)?.code === '23505') {
      const { data: raced } = await db
        .from('comments')
        .select('id')
        .eq('account_id', accountId)
        .eq('provider', post.provider)
        .eq('external_comment_id', comment.externalCommentId)
        .maybeSingle()
      if (raced) return { commentId: raced.id as string, postId: postRow.id as string, isNew: false }
    }
    console.error('[comments ingest] insert failed:', error)
    return null
  }

  // Replies that arrived before their parent: link any now.
  await db
    .from('comments')
    .update({ parent_comment_id: created.id })
    .eq('account_id', accountId)
    .eq('provider', post.provider)
    .eq('parent_external_id', comment.externalCommentId)
    .is('parent_comment_id', null)

  return { commentId: created.id as string, postId: postRow.id as string, isNew: true }
}

/** A provider told us a comment was removed or its visibility changed. */
export async function setCommentStatusByExternalId(
  db: SupabaseClient,
  accountId: string,
  provider: CommentProvider,
  externalCommentId: string,
  status: CommentStatus,
): Promise<void> {
  const { error } = await db
    .from('comments')
    .update({ status })
    .eq('account_id', accountId)
    .eq('provider', provider)
    .eq('external_comment_id', externalCommentId)
  if (error) console.error('[comments ingest] status update failed:', error)
}

/**
 * Claim a webhook event so a redelivery is processed once. Returns true
 * the first time a key is seen.
 */
export async function claimWebhookEvent(
  db: SupabaseClient,
  provider: string,
  dedupeKey: string,
): Promise<boolean> {
  const { error } = await db
    .from('comment_webhook_events')
    .insert({ provider, dedupe_key: dedupeKey })
  if (!error) return true
  if ((error as { code?: string }).code === '23505') return false
  // If the dedupe table misbehaves, process rather than drop the comment
  // (ingest itself is idempotent).
  console.error('[comments ingest] dedupe claim failed:', error)
  return true
}
