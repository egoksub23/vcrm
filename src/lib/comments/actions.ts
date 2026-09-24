import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaApiError } from '@/lib/meta/errors'
import { findOrCreateContactByExternalId } from '@/lib/meta/contact-identity'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { ingestComment } from './ingest'
import {
  deleteMetaComment,
  replyFacebookComment,
  replyInstagramComment,
  sendPrivateReply,
  setFacebookCommentHidden,
  setInstagramCommentHidden,
} from './meta-comments'
import {
  deleteTikTokComment,
  replyToTikTokComment,
  setTikTokCommentHidden,
  TikTokApiError,
} from './tiktok/api'
import { getTikTokAccess, TikTokReauthRequired } from './tiktok/connection'
import {
  commentCapabilities,
  REPLY_MAX_CHARS,
  type CommentAction,
  type CommentProvider,
  type CommentRow,
  type UnavailableReason,
} from './types'

// ============================================================
// What an agent does to a comment: reply, private reply, hide/unhide,
// delete. One entry point checks the rules, calls the provider, updates
// our copy, and writes an audit row.
//
// Sample comments (is_test) skip the provider call and just behave as if
// it had succeeded, so the screens can be tried before an account is
// connected.
// ============================================================

const PRIVATE_REPLY_MAX_CHARS = 1000

export type ActionResult =
  | { ok: true; comment: CommentRow; providerObjectId?: string | null }
  | { ok: false; status: number; error: string; reason?: UnavailableReason | 'notConnected' | 'reconnect' }

interface Ctx {
  accountId: string
  userId: string
}

const CAP_KEY: Record<CommentAction, 'reply' | 'privateReply' | 'hide' | 'unhide' | 'delete'> = {
  reply: 'reply',
  private_reply: 'privateReply',
  hide: 'hide',
  unhide: 'unhide',
  delete: 'delete',
}

interface MetaCreds {
  token: string
  /** Page id (Facebook) or Instagram business account id. */
  senderId: string
  ownerUserId: string
  table: 'messenger_config' | 'instagram_config'
}

async function loadMetaCreds(db: SupabaseClient, accountId: string, provider: 'facebook' | 'instagram'): Promise<MetaCreds | null> {
  const table = provider === 'facebook' ? 'messenger_config' : 'instagram_config'
  const cols =
    provider === 'facebook'
      ? 'page_id, page_access_token, connected_by_user_id'
      : 'page_id, ig_business_account_id, page_access_token, connected_by_user_id'
  const { data } = await db
    .from(table)
    .select(cols)
    .eq('account_id', accountId)
    .eq('status', 'connected')
    // Manually paused (migration 097) — comment actions blocked the same
    // way an outbound message send is.
    .eq('enabled', true)
    .maybeSingle()
  if (!data) return null
  const row = data as unknown as Record<string, string>
  return {
    token: decrypt(row.page_access_token),
    senderId: provider === 'facebook' ? row.page_id : row.ig_business_account_id,
    ownerUserId: row.connected_by_user_id,
    table,
  }
}

async function audit(
  db: SupabaseClient,
  ctx: Ctx,
  commentId: string,
  action: CommentAction,
  outcome: { ok: boolean; text?: string; objectId?: string | null; error?: string },
) {
  const { error } = await db.from('comment_actions').insert({
    account_id: ctx.accountId,
    comment_id: commentId,
    actor_user_id: ctx.userId,
    action,
    text: outcome.text ?? null,
    provider_object_id: outcome.objectId ?? null,
    status: outcome.ok ? 'success' : 'failed',
    error_message: outcome.error?.slice(0, 500) ?? null,
  })
  if (error) console.error('[comments] audit insert failed:', error)
}

export async function performCommentAction(
  db: SupabaseClient,
  ctx: Ctx,
  commentId: string,
  action: CommentAction,
  rawText?: string,
): Promise<ActionResult> {
  const { data: row } = await db
    .from('comments')
    .select('*, post:comment_posts(*)')
    .eq('id', commentId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!row) return { ok: false, status: 404, error: 'Comment not found' }

  const comment = row as unknown as CommentRow & {
    parent_external_id: string | null
    post: { external_post_id: string; provider: CommentProvider; channel_ref_id: string; source: 'organic' | 'ad' }
  }
  const provider = comment.provider
  const caps = commentCapabilities(comment)
  if (!caps[CAP_KEY[action]]) {
    return {
      ok: false,
      status: 409,
      error: 'That action is not available for this comment.',
      reason: caps.reasons[action],
    }
  }

  const needsText = action === 'reply' || action === 'private_reply'
  const text = (rawText ?? '').trim()
  if (needsText) {
    const max = action === 'reply' ? REPLY_MAX_CHARS[provider] : PRIVATE_REPLY_MAX_CHARS
    if (!text) return { ok: false, status: 400, error: 'Write something first.' }
    if (text.length > max) return { ok: false, status: 400, error: `Too long: ${provider} allows up to ${max} characters here.` }
  }

  const sim = comment.is_test
  // Replies attach to the top-level comment.
  const replyTo = comment.parent_external_id ?? comment.external_comment_id

  try {
    let objectId: string | null = null
    let privateRecipient: { id: string | null; messageId: string | null } | null = null
    let ownerUserId: string | null = null

    if (sim) {
      objectId = needsText ? `test-${randomUUID()}` : null
      if (action === 'private_reply') privateRecipient = { id: null, messageId: null }
    } else if (provider === 'tiktok') {
      const access = await getTikTokAccess(db, ctx.accountId)
      if (!access) return { ok: false, status: 409, error: 'TikTok is not connected.', reason: 'notConnected' }
      const videoId = comment.post.external_post_id
      if (action === 'reply') {
        const r = await replyToTikTokComment({ token: access.token, openId: access.openId, videoId, commentId: replyTo, text })
        objectId = r.commentId
      } else if (action === 'hide' || action === 'unhide') {
        await setTikTokCommentHidden({ token: access.token, openId: access.openId, videoId, commentId: comment.external_comment_id, hidden: action === 'hide' })
      } else if (action === 'delete') {
        await deleteTikTokComment({ token: access.token, openId: access.openId, commentId: comment.external_comment_id })
      }
    } else {
      const creds = await loadMetaCreds(db, ctx.accountId, provider)
      if (!creds) return { ok: false, status: 409, error: `${provider === 'facebook' ? 'Facebook' : 'Instagram'} is not connected.`, reason: 'notConnected' }
      ownerUserId = creds.ownerUserId
      try {
        if (action === 'reply') {
          const args = { commentId: replyTo, token: creds.token, message: text }
          objectId = (provider === 'facebook' ? await replyFacebookComment(args) : await replyInstagramComment(args)).id
        } else if (action === 'private_reply') {
          const r = await sendPrivateReply({ senderId: creds.senderId, commentId: comment.external_comment_id, token: creds.token, text })
          privateRecipient = { id: r.recipientId, messageId: r.messageId }
          objectId = r.messageId
        } else if (action === 'hide' || action === 'unhide') {
          const args = { commentId: comment.external_comment_id, token: creds.token, hidden: action === 'hide' }
          if (provider === 'facebook') await setFacebookCommentHidden(args)
          else await setInstagramCommentHidden(args)
        } else if (action === 'delete') {
          await deleteMetaComment({ commentId: comment.external_comment_id, token: creds.token })
        }
      } catch (err) {
        // Expired / revoked token → flag the channel for reconnect.
        if (err instanceof MetaApiError && err.code === 190) {
          await db.from(creds.table).update({ needs_reauth: true }).eq('account_id', ctx.accountId)
        }
        throw err
      }
    }

    // ---- our own copy -------------------------------------------------
    const update: Record<string, unknown> = {}
    if (action === 'hide') update.status = 'hidden'
    if (action === 'unhide') update.status = 'visible'
    if (action === 'delete') update.status = 'deleted'
    if (action === 'reply' || action === 'private_reply') {
      if (comment.handled_status === 'open') update.handled_status = 'replied'
    }
    if (action === 'private_reply') update.private_replied_at = new Date().toISOString()

    if (action === 'reply' && objectId) {
      await ingestComment(
        db,
        ctx.accountId,
        { provider, channelRefId: comment.post.channel_ref_id, externalPostId: comment.post.external_post_id },
        {
          externalCommentId: objectId,
          parentExternalId: replyTo,
          direction: 'outbound',
          text,
          providerCreatedAt: new Date(),
          isTest: sim,
        },
      )
    }

    if (action === 'private_reply' && !sim && privateRecipient?.id && ownerUserId) {
      try {
        const contactId = await linkPrivateReplyToChat(db, ctx, {
          provider: provider as 'facebook' | 'instagram',
          recipientId: privateRecipient.id,
          messageId: privateRecipient.messageId,
          authorName: comment.author_name,
          ownerUserId,
          text,
        })
        if (contactId) update.contact_id = contactId
      } catch (err) {
        // The DM itself was sent; failing to file it in the inbox must
        // not turn a delivered reply into an error.
        console.error('[comments] could not link private reply to a chat:', err)
      }
    }

    let saved = comment as unknown as CommentRow
    if (Object.keys(update).length > 0) {
      const { data: u } = await db.from('comments').update(update).eq('id', comment.id).select('*').single()
      if (u) saved = u as unknown as CommentRow
    }
    await audit(db, ctx, comment.id, action, { ok: true, text: needsText ? text : undefined, objectId })
    return { ok: true, comment: saved, providerObjectId: objectId }
  } catch (err) {
    const message =
      err instanceof TikTokReauthRequired
        ? 'TikTok needs to be reconnected in Settings → Channels.'
        : err instanceof MetaApiError || err instanceof TikTokApiError || err instanceof Error
          ? err.message
          : 'The provider rejected the request.'
    await audit(db, ctx, comment.id, action, { ok: false, text: needsText ? text : undefined, error: message })
    const reconnect =
      err instanceof TikTokReauthRequired || (err instanceof MetaApiError && err.code === 190)
    return { ok: false, status: reconnect ? 409 : 502, error: message, reason: reconnect ? 'reconnect' : undefined }
  }
}

/**
 * A private reply starts a real DM conversation: find or create the
 * contact from the recipient id, and file the message we sent in their
 * chat, so their answer lands in the same thread. Returns the contact id.
 */
async function linkPrivateReplyToChat(
  db: SupabaseClient,
  ctx: Ctx,
  a: {
    provider: 'facebook' | 'instagram'
    recipientId: string
    messageId: string | null
    authorName: string | null
    ownerUserId: string
    text: string
  },
): Promise<string | null> {
  const channel = a.provider === 'facebook' ? 'messenger' : 'instagram'
  const found = await findOrCreateContactByExternalId(db, {
    accountId: ctx.accountId,
    configOwnerUserId: a.ownerUserId,
    column: a.provider === 'facebook' ? 'messenger_psid' : 'instagram_igsid',
    externalId: a.recipientId,
    resolveDisplayName: async () => a.authorName || (a.provider === 'facebook' ? 'Facebook user' : 'Instagram user'),
  })
  if (!found) return null
  const conv = await findOrCreateConversation(db, ctx.accountId, a.ownerUserId, found.contact.id)
  if (conv) {
    await db.from('messages').insert({
      conversation_id: conv.conversation.id,
      sender_type: 'agent',
      sender_id: ctx.userId,
      content_type: 'text',
      content_text: a.text,
      channel_type: channel,
      message_id: a.messageId,
      status: 'sent',
    })
    await db
      .from('conversations')
      .update({
        last_message_text: a.text,
        last_message_at: new Date().toISOString(),
        last_channel_type: channel,
        awaiting_response: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conv.conversation.id)
  }
  return found.contact.id
}
