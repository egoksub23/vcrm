// ============================================================
// GET /api/widget/messages?conversationId=X[&before=Y]
//
// Returns one page (up to 50) of messages for an authenticated widget
// visitor, replacing the direct Supabase PostgREST / RLS query the
// widget bundle previously made. `before` is an ISO created_at cursor
// for the oldest row already shown, used to page backwards in history.
//
// Rows are returned newest-first (the widget reverses them for display).
// is_internal messages are excluded, matching the former RLS policy.
//
// Auth: same bearer-JWT flow as every other widget route.
// ============================================================
import { NextResponse } from 'next/server'

import { RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, withCors } from '@/lib/widget/cors'
import { authenticateVisitorRequest, loadOwnedConversation, widgetError } from '@/lib/widget/visitor-auth'

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

const MESSAGE_COLUMNS =
  'id, sender_type, content_text, content_type, media_url, status, created_at, is_internal'
const PAGE_SIZE = 50

export async function GET(request: Request) {
  const auth = await authenticateVisitorRequest(request, {
    logTag: 'widget/messages',
    rate: { key: 'widget:messages:{visitor}', options: RATE_LIMITS.widgetMessage },
  })
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const { admin, corsOrigin } = ctx

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId') ?? ''
  const before = url.searchParams.get('before') ?? undefined

  if (!conversationId) return widgetError(400, 'conversationId is required', 'bad_request', corsOrigin)

  let conversation
  try {
    conversation = await loadOwnedConversation(ctx, conversationId)
  } catch (err) {
    console.error('[widget/messages] conversation lookup error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
  if (!conversation) return widgetError(404, 'Conversation not found', 'not_found', corsOrigin)

  let q = admin
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)
  if (before) q = q.lt('created_at', before)

  const { data, error } = await q
  if (error) {
    console.error('[widget/messages] query error:', error)
    return widgetError(500, 'Failed to load messages', undefined, corsOrigin)
  }

  // Filter is_internal in JS: SQL != null handling differs by driver, and
  // the former RLS policy treated NULL as not-internal (IS NOT TRUE).
  const rows = (data ?? []).filter((m: Record<string, unknown>) => !m.is_internal)

  return withCors(
    NextResponse.json({ rows, hasMore: (data ?? []).length >= PAGE_SIZE }),
    corsOrigin,
  )
}
