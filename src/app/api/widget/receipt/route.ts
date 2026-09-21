// ============================================================
// POST /api/widget/receipt
//
// The widget reporting that it RECEIVED ('delivered') or DISPLAYED ('read')
// agent / bot messages. The dashboard's existing tick icons then show it.
//
// Only messages in the visitor's own conversation, sent on the web widget,
// by an agent or bot, and not internal comments can change. A status only
// ever moves forward: sent -> delivered -> read; a late 'delivered' never
// downgrades a 'read'. (failed / sending are never touched.)
//
// Visitor -> agent ticks are not reported here: a customer message starts
// 'sent' and flips to 'read' when an agent opens the conversation (a
// database trigger on conversations.unread_count, migration 092).
//
// Request:  { conversationId, messageIds: string[], status: 'delivered' | 'read' }
// Response: { updated: number }
// ============================================================
import { NextResponse } from 'next/server'

import { RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, withCors } from '@/lib/widget/cors'
import { receiptFromStatuses, parseReceiptBody } from '@/lib/widget/receipt'
import { authenticateVisitorRequest, loadOwnedConversation, widgetError } from '@/lib/widget/visitor-auth'

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const auth = await authenticateVisitorRequest(request, {
    logTag: 'widget/receipt',
    rate: { key: 'widget:receipt:{visitor}', options: RATE_LIMITS.widgetReceipt },
  })
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const { admin, corsOrigin } = ctx

  const parsed = parseReceiptBody(await request.json().catch(() => null))
  if (!parsed.ok) return widgetError(400, parsed.error, 'bad_request', corsOrigin)
  const { conversationId, messageIds, status } = parsed.value

  let conversation
  try {
    conversation = await loadOwnedConversation(ctx, conversationId)
  } catch (err) {
    console.error('[widget/receipt] conversation lookup error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
  if (!conversation) return widgetError(404, 'Conversation not found', 'not_found', corsOrigin)

  const { data, error } = await admin
    .from('messages')
    .update({ status })
    .eq('conversation_id', conversationId)
    .in('id', messageIds)
    .in('sender_type', ['agent', 'bot'])
    .eq('channel_type', 'web_widget')
    .in('status', receiptFromStatuses(status))
    .or('is_internal.is.null,is_internal.eq.false')
    .select('id')

  if (error) {
    console.error('[widget/receipt] update error:', error)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }

  return withCors(NextResponse.json({ updated: data?.length ?? 0 }), corsOrigin)
}
