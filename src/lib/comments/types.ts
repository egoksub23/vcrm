// ============================================================
// Comments module: shared types + the rules for what an agent can do to
// a given comment. Pure, so the rules are unit-tested and the UI and the
// action route agree on them.
// ============================================================

export const COMMENT_PROVIDERS = ['facebook', 'instagram', 'tiktok'] as const
export type CommentProvider = (typeof COMMENT_PROVIDERS)[number]

export type CommentAction = 'reply' | 'private_reply' | 'hide' | 'unhide' | 'delete'
export type CommentStatus = 'visible' | 'hidden' | 'deleted'
export type CommentHandled = 'open' | 'replied' | 'resolved' | 'spam'

export interface CommentPost {
  id: string
  provider: CommentProvider
  source: 'organic' | 'ad'
  external_post_id: string
  message: string | null
  permalink_url: string | null
  media_url: string | null
  media_type: string | null
  posted_at: string | null
}

export interface CommentRow {
  id: string
  post_id: string
  provider: CommentProvider
  external_comment_id: string
  parent_comment_id: string | null
  direction: 'inbound' | 'outbound'
  author_external_id: string | null
  author_name: string | null
  author_username: string | null
  author_avatar_url: string | null
  contact_id: string | null
  text: string | null
  attachment_url: string | null
  status: CommentStatus
  handled_status: CommentHandled
  assigned_to: string | null
  private_replied_at: string | null
  is_test: boolean
  provider_created_at: string
}

/** Longest reply each provider accepts. */
export const REPLY_MAX_CHARS: Record<CommentProvider, number> = {
  facebook: 8000,
  instagram: 2200,
  tiktok: 1200,
}

/** Meta lets a private reply go out within 7 days of the comment. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Why an action is unavailable — the UI turns each into a sentence. */
export type UnavailableReason =
  | 'deleted'
  | 'ownComment'
  | 'igReplyToReply'
  | 'igHidden'
  | 'privateUnsupported'
  | 'privateAlready'
  | 'privateExpired'
  | 'privateNoAuthor'
  | 'deleteTiktokOwnOnly'

export interface CommentCapabilities {
  reply: boolean
  privateReply: boolean
  hide: boolean
  unhide: boolean
  delete: boolean
  /** Reason for each action that is off. */
  reasons: Partial<Record<CommentAction, UnavailableReason>>
}

/**
 * What can be done to `comment` right now.
 *
 *  - Facebook: everything (private reply once, within 7 days).
 *  - Instagram: replies only go to top-level comments that are not hidden;
 *    otherwise like Facebook.
 *  - TikTok: no private reply (TikTok has no general way to message a
 *    commenter), and only our own comments can be deleted; anyone else's
 *    can be hidden instead.
 */
export function commentCapabilities(
  comment: Pick<
    CommentRow,
    | 'provider'
    | 'direction'
    | 'status'
    | 'parent_comment_id'
    | 'author_external_id'
    | 'private_replied_at'
    | 'provider_created_at'
  >,
  now: number = Date.now(),
): CommentCapabilities {
  const reasons: CommentCapabilities['reasons'] = {}
  const off = (a: CommentAction, why: UnavailableReason) => {
    reasons[a] = why
    return false
  }

  if (comment.status === 'deleted') {
    return {
      reply: off('reply', 'deleted'),
      privateReply: off('private_reply', 'deleted'),
      hide: off('hide', 'deleted'),
      unhide: off('unhide', 'deleted'),
      delete: off('delete', 'deleted'),
      reasons,
    }
  }

  const own = comment.direction === 'outbound'
  const isHidden = comment.status === 'hidden'

  let reply = true
  if (own) reply = off('reply', 'ownComment')
  else if (comment.provider === 'instagram' && comment.parent_comment_id) reply = off('reply', 'igReplyToReply')
  else if (comment.provider === 'instagram' && isHidden) reply = off('reply', 'igHidden')

  let privateReply = true
  if (own) privateReply = off('private_reply', 'ownComment')
  else if (comment.provider === 'tiktok') privateReply = off('private_reply', 'privateUnsupported')
  else if (!comment.author_external_id) privateReply = off('private_reply', 'privateNoAuthor')
  else if (comment.private_replied_at) privateReply = off('private_reply', 'privateAlready')
  else if (now - new Date(comment.provider_created_at).getTime() > PRIVATE_REPLY_WINDOW_MS) {
    privateReply = off('private_reply', 'privateExpired')
  }

  // Hiding someone else's comment works everywhere; hiding our own is pointless.
  const canHide = !own && !isHidden
  const canUnhide = !own && isHidden
  if (own) {
    off('hide', 'ownComment')
    off('unhide', 'ownComment')
  }

  let del = true
  if (comment.provider === 'tiktok' && !own) del = off('delete', 'deleteTiktokOwnOnly')

  return { reply, privateReply, hide: canHide, unhide: canUnhide, delete: del, reasons }
}

/** TikTok replies attach to a top-level comment; a reply to a reply goes to
 *  its parent. Facebook and Instagram do the same server-side. */
export function replyTargetExternalId(
  comment: Pick<CommentRow, 'external_comment_id'>,
  parentExternalId: string | null,
): string {
  return parentExternalId ?? comment.external_comment_id
}
