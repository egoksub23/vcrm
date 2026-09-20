/**
 * Graph API calls for Facebook Page and Instagram comments. Named-params
 * objects, like the other Meta wrappers. Every failure throws MetaApiError
 * (code 190 = expired token, which callers turn into "reconnect").
 */
import { throwMetaError } from '@/lib/meta/errors'

const META_API_VERSION = 'v21.0'
const BASE = `https://graph.facebook.com/${META_API_VERSION}`

async function graph<T>(
  path: string,
  args: { token: string; method?: 'GET' | 'POST' | 'DELETE'; body?: Record<string, unknown>; query?: Record<string, string> },
): Promise<T> {
  const qs = args.query ? `?${new URLSearchParams(args.query).toString()}` : ''
  const res = await fetch(`${BASE}/${path}${qs}`, {
    method: args.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${args.token}`,
      ...(args.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: args.body ? JSON.stringify(args.body) : undefined,
  })
  if (!res.ok) await throwMetaError(res, `Graph API error: ${res.status}`)
  return (await res.json().catch(() => ({}))) as T
}

/** Public reply under a Facebook comment. */
export async function replyFacebookComment(a: { commentId: string; token: string; message: string }) {
  const r = await graph<{ id: string }>(`${a.commentId}/comments`, {
    token: a.token, method: 'POST', body: { message: a.message },
  })
  return { id: r.id }
}

/** Public reply under an Instagram comment (top-level comments only). */
export async function replyInstagramComment(a: { commentId: string; token: string; message: string }) {
  const r = await graph<{ id: string }>(`${a.commentId}/replies`, {
    token: a.token, method: 'POST', body: { message: a.message },
  })
  return { id: r.id }
}

/**
 * One private DM to the commenter (once per comment, within 7 days).
 * `senderId` is the Page id (Facebook) or Instagram business account id.
 * `recipientId` in the result is the commenter's PSID / IGSID.
 */
export async function sendPrivateReply(a: { senderId: string; commentId: string; token: string; text: string }) {
  const r = await graph<{ recipient_id?: string; message_id?: string }>(`${a.senderId}/messages`, {
    token: a.token,
    method: 'POST',
    body: { recipient: { comment_id: a.commentId }, message: { text: a.text } },
  })
  return { recipientId: r.recipient_id ?? null, messageId: r.message_id ?? null }
}

export async function setFacebookCommentHidden(a: { commentId: string; token: string; hidden: boolean }) {
  await graph(a.commentId, { token: a.token, method: 'POST', body: { is_hidden: a.hidden } })
}

export async function setInstagramCommentHidden(a: { commentId: string; token: string; hidden: boolean }) {
  await graph(a.commentId, { token: a.token, method: 'POST', body: { hide: a.hidden } })
}

export async function deleteMetaComment(a: { commentId: string; token: string }) {
  await graph(a.commentId, { token: a.token, method: 'DELETE' })
}

/** The Facebook post a comment is under (caption, link, picture). */
export async function getFacebookPost(a: { postId: string; token: string }) {
  const r = await graph<{
    message?: string
    permalink_url?: string
    full_picture?: string
    created_time?: string
    is_published?: boolean
  }>(a.postId, {
    token: a.token,
    query: { fields: 'message,permalink_url,full_picture,created_time,is_published' },
  }).catch(() => null)
  return r
}

/** The Instagram post a comment is under. */
export async function getInstagramMedia(a: { mediaId: string; token: string }) {
  const r = await graph<{
    caption?: string
    permalink?: string
    media_url?: string
    thumbnail_url?: string
    media_type?: string
    media_product_type?: string
    timestamp?: string
  }>(a.mediaId, {
    token: a.token,
    query: { fields: 'caption,permalink,media_url,thumbnail_url,media_type,media_product_type,timestamp' },
  }).catch(() => null)
  return r
}

/** Permissions the connecting user actually granted (status "granted"). */
export async function getGrantedPermissions(a: { token: string }): Promise<string[]> {
  const r = await graph<{ data?: { permission?: string; status?: string }[] }>('me/permissions', { token: a.token })
  return (r.data ?? []).filter((p) => p.status === 'granted' && p.permission).map((p) => p.permission as string)
}

/**
 * Subscribe a Page to more webhook fields WITHOUT dropping the ones it
 * already has (POST replaces the list, so send the union).
 */
export async function subscribePageFields(a: { pageId: string; token: string; add: string[] }) {
  let current: string[] = []
  try {
    const r = await graph<{ data?: { subscribed_fields?: string[] }[] }>(`${a.pageId}/subscribed_apps`, { token: a.token })
    current = r.data?.flatMap((d) => d.subscribed_fields ?? []) ?? []
  } catch {
    // Reading is best-effort; fall through and subscribe to what we need.
  }
  const fields = Array.from(new Set([...current, ...a.add]))
  await graph<{ success?: boolean }>(`${a.pageId}/subscribed_apps`, {
    token: a.token,
    method: 'POST',
    body: { subscribed_fields: fields.join(',') },
  })
  return fields
}
