// ============================================================
// POST /api/widget/media-url
//
// The chat-media bucket is private, so a file in a conversation (a visitor's
// own upload, a photo or voice note an agent sent) cannot be shown from the
// stored `messages.media_url` any more; that string is only an identifier.
// The widget reads `messages` straight from Supabase, so it asks here for a
// short-lived signed link for each file it is about to show.
//
// Request:  { conversationId, urls: string[] }   (max 25 urls)
// Response: { urls: { [storedUrl]: signedUrl } }
//
// A signed link is a bearer credential for one object, so a URL is only
// signed when a visible message of THIS visitor's own conversation carries
// exactly that media_url (the client never names a file the server has not
// already attached to the conversation) and signMediaUrl agrees the file is
// inside the workspace's folder. Anything that fails either check is left out
// of the answer, not an error: the widget shows the message without a link.
// ============================================================
import { NextResponse } from 'next/server'

import { RATE_LIMITS } from '@/lib/rate-limit'
import { VIEW_URL_TTL_SECONDS } from '@/lib/storage/media-urls'
import { signMediaUrl } from '@/lib/storage/sign-media'
import { corsPreflight, withCors } from '@/lib/widget/cors'
import { authenticateVisitorRequest, loadOwnedConversation, widgetError } from '@/lib/widget/visitor-auth'

const MAX_URLS = 25
const MAX_URL_LENGTH = 2048

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const auth = await authenticateVisitorRequest(request, {
    logTag: 'widget/media-url',
    rate: { key: 'widget:media-url:{visitor}', options: RATE_LIMITS.widgetMediaUrl },
  })
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const { admin, corsOrigin, accountId } = ctx

  const body = (await request.json().catch(() => null)) as { conversationId?: unknown; urls?: unknown } | null
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
  if (!conversationId) return widgetError(400, 'conversationId is required', 'bad_request', corsOrigin)

  const raw = body?.urls
  if (!Array.isArray(raw) || raw.length > MAX_URLS) {
    return widgetError(400, `urls must be an array of at most ${MAX_URLS} strings`, 'bad_request', corsOrigin)
  }
  if (raw.some((u) => typeof u !== 'string' || u.length === 0 || u.length > MAX_URL_LENGTH)) {
    return widgetError(400, 'urls must be non-empty strings', 'bad_request', corsOrigin)
  }
  const urls = [...new Set(raw as string[])]

  let conversation
  try {
    conversation = await loadOwnedConversation(ctx, conversationId)
  } catch (err) {
    console.error('[widget/media-url] conversation lookup error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
  if (!conversation) return widgetError(404, 'Conversation not found', 'not_found', corsOrigin)

  if (urls.length === 0) return withCors(NextResponse.json({ urls: {} }), corsOrigin)

  // Which of the named files does this conversation really carry? Internal
  // notes are never the visitor's to see, so they do not count.
  const { data: rows, error } = await admin
    .from('messages')
    .select('media_url')
    .eq('conversation_id', conversation.id)
    .eq('is_internal', false)
    .in('media_url', urls)
  if (error) {
    console.error('[widget/media-url] message lookup error:', error)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
  const attached = new Set((rows ?? []).map((r) => (r as { media_url: string | null }).media_url))

  const signed: Record<string, string> = {}
  await Promise.all(
    urls
      .filter((u) => attached.has(u))
      .map(async (u) => {
        const link = await signMediaUrl(admin, u, accountId, VIEW_URL_TTL_SECONDS).catch(() => null)
        if (link) signed[u] = link
      }),
  )

  return withCors(NextResponse.json({ urls: signed }), corsOrigin)
}
