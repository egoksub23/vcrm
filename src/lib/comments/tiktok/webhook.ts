import { createHmac, timingSafeEqual } from 'node:crypto'

// ============================================================
// TikTok webhook: signature check + a payload parser that keeps the
// 19-digit ids intact. TikTok sends them as JSON NUMBERS, which are above
// 2^53 — JSON.parse would silently round them. We quote them in the raw
// text before parsing (they also appear inside the stringified `content`,
// escaped), so an id is always an exact string.
// ============================================================

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

/**
 * Verify `Tiktok-Signature: t=<unix seconds>,s=<hex>`: HMAC-SHA256 of
 * `t + "." + rawBody` keyed with the app secret. The raw request bytes are
 * used (not a re-serialised body), compared in constant time.
 */
export function verifyTikTokSignature(args: {
  rawBody: string
  header: string | null
  secret: string
  nowSeconds?: number
}): boolean {
  if (!args.header) return false
  const parts = Object.fromEntries(
    args.header.split(',').map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()]
    }),
  )
  const t = parts.t
  const s = parts.s
  if (!t || !s || !/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(s)) return false
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false

  const expected = createHmac('sha256', args.secret).update(`${t}.${args.rawBody}`).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(s.toLowerCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export type TikTokCommentAction =
  | 'insert'
  | 'delete'
  | 'set_to_hidden'
  | 'set_to_friends_only'
  | 'set_to_public'

export interface TikTokCommentEvent {
  /** The connected account's open_id — our tenant routing key. */
  userOpenId: string
  commentId: string
  videoId: string
  parentCommentId: string | null
  commentType: 'comment' | 'reply'
  action: TikTokCommentAction
  uniqueIdentifier: string | null
  text: string | null
  /** Epoch milliseconds. */
  timestamp: number
}

const ID_KEYS = 'comment_id|video_id|parent_comment_id'

/** Quote big numeric ids in raw JSON text, plain and escaped-in-a-string. */
export function quoteBigIds(raw: string): string {
  return raw
    .replace(new RegExp(`\\\\"(${ID_KEYS})\\\\":\\s*(\\d{10,})`, 'g'), '\\"$1\\":\\"$2\\"')
    .replace(new RegExp(`"(${ID_KEYS})":\\s*(\\d{10,})`, 'g'), '"$1":"$2"')
}

/** Parse a `comment.update` delivery; null for anything else. */
export function parseTikTokCommentEvent(rawBody: string): TikTokCommentEvent | null {
  let outer: Record<string, unknown>
  try {
    outer = JSON.parse(quoteBigIds(rawBody))
  } catch {
    return null
  }
  if (outer.event !== 'comment.update') return null

  let content: Record<string, unknown>
  try {
    content =
      typeof outer.content === 'string'
        ? JSON.parse(outer.content)
        : ((outer.content as Record<string, unknown>) ?? {})
  } catch {
    return null
  }

  const commentId = content.comment_id != null ? String(content.comment_id) : ''
  const videoId = content.video_id != null ? String(content.video_id) : ''
  const userOpenId = typeof outer.user_openid === 'string' ? outer.user_openid : ''
  if (!commentId || !videoId || !userOpenId) return null

  return {
    userOpenId,
    commentId,
    videoId,
    parentCommentId: content.parent_comment_id != null ? String(content.parent_comment_id) : null,
    commentType: content.comment_type === 'reply' ? 'reply' : 'comment',
    action: (content.comment_action as TikTokCommentAction) ?? 'insert',
    uniqueIdentifier: typeof content.unique_identifier === 'string' ? content.unique_identifier : null,
    text: typeof content.text === 'string' ? content.text : null,
    timestamp: typeof content.timestamp === 'number' ? content.timestamp : Date.now(),
  }
}
