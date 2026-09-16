// ============================================================
// POST /api/widget/message
//
// Where a widget visitor's outbound text lands. Public, CORS-enabled,
// verified via the same anonymous-auth bearer JWT as
// POST /api/widget/session. Deliberately NOT a direct client insert
// into `messages` (even though RLS would allow the visitor to read
// their own conversation) — this route is the one synchronous place
// that also runs most of the inbound fan-out every WhatsApp message
// already gets (automations, AI auto-reply, outbound webhooks — see
// the Flows note below for the one deliberate exception), so a widget
// message plugs into that machinery unchanged instead of needing a
// parallel Postgres-trigger-based dispatch path.
// ============================================================
import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, resolveCorsOrigin, withCors } from '@/lib/widget/cors'

const TEXT_MAX_LEN = 4000

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const requestOrigin = request.headers.get('origin')
  const admin = supabaseAdmin()

  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) {
    return NextResponse.json({ error: 'Missing Authorization bearer token' }, { status: 401 })
  }

  const anonClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
  const { data: userData, error: userError } = await anonClient.auth.getUser(token)
  if (userError || !userData.user) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 })
  }
  const visitorId = userData.user.id

  const { data: visitor, error: visitorError } = await admin
    .from('widget_visitors')
    .select('account_id, contact_id, widget_config_id')
    .eq('id', visitorId)
    .maybeSingle()

  if (visitorError) {
    console.error('[widget/message] visitor lookup error:', visitorError)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!visitor) {
    return NextResponse.json({ error: 'No active widget session for this visitor' }, { status: 401 })
  }

  const { data: config } = await admin
    .from('web_widget_config')
    .select('allowed_origins, enabled')
    .eq('id', visitor.widget_config_id)
    .maybeSingle()

  const corsOrigin = resolveCorsOrigin(requestOrigin, config?.allowed_origins ?? [])
  if (!corsOrigin) {
    return NextResponse.json({ error: 'Origin not allowed for this widget' }, { status: 403 })
  }
  if (!config?.enabled) {
    return withCors(NextResponse.json({ error: 'Widget is disabled' }, { status: 403 }), corsOrigin)
  }

  const limit = checkRateLimit(`widget:message:${visitorId}`, RATE_LIMITS.widgetMessage)
  if (!limit.success) return withCors(rateLimitResponse(limit), corsOrigin)

  const body = (await request.json().catch(() => null)) as
    | { conversationId?: unknown; text?: unknown }
    | null
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''

  if (!conversationId) {
    return withCors(NextResponse.json({ error: 'conversationId is required' }, { status: 400 }), corsOrigin)
  }
  if (!text) {
    return withCors(NextResponse.json({ error: 'text is required' }, { status: 400 }), corsOrigin)
  }
  if (text.length > TEXT_MAX_LEN) {
    return withCors(
      NextResponse.json({ error: `text exceeds the ${TEXT_MAX_LEN}-character limit` }, { status: 400 }),
      corsOrigin,
    )
  }

  // The conversation must belong to THIS visitor's own contact — a
  // visitor can't guess another conversation's UUID and post into it.
  const { data: conversation, error: convError } = await admin
    .from('conversations')
    .select('id, account_id, contact_id, status')
    .eq('id', conversationId)
    .eq('account_id', visitor.account_id)
    .eq('contact_id', visitor.contact_id)
    .eq('channel_type', 'web_widget')
    .maybeSingle()

  if (convError) {
    console.error('[widget/message] conversation lookup error:', convError)
    return withCors(NextResponse.json({ error: 'Internal server error' }, { status: 500 }), corsOrigin)
  }
  if (!conversation) {
    return withCors(NextResponse.json({ error: 'Conversation not found' }, { status: 404 }), corsOrigin)
  }

  const accountId = visitor.account_id
  const contactId = visitor.contact_id

  // First-message check BEFORE the insert, same approach as the
  // WhatsApp webhook (src/app/api/whatsapp/webhook/route.ts).
  const { count: priorCustomerMsgCount } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: insertedMessage, error: msgError } = await admin
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: 'text',
      content_text: text,
      status: 'delivered',
    })
    .select('id')
    .single()

  if (msgError || !insertedMessage) {
    console.error('[widget/message] insert error:', msgError)
    return withCors(NextResponse.json({ error: 'Failed to send message' }, { status: 500 }), corsOrigin)
  }

  await admin.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversationId,
    p_last_message_text: text,
  })

  await reopenClosedConversation(admin, conversation)
  await admin
    .from('widget_visitors')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', visitorId)

  let ownerUserId: string
  try {
    ownerUserId = await resolveAuditUserId(admin, accountId)
  } catch (err) {
    if (err instanceof ContactError) {
      return withCors(NextResponse.json({ error: err.message }, { status: err.status }), corsOrigin)
    }
    throw err
  }

  // Flows (the visual IVR/menu builder) are not dispatched for widget
  // conversations in this pass: its send nodes call Meta directly
  // (src/lib/flows/meta-send.ts) rather than going through the
  // channel-aware sendMessageToConversation core, so a Flow with an
  // interactive-button/list node would error against a widget contact
  // that has no phone number. Plain Automations remain available (its
  // `send_message` step is channel-aware; `send_buttons`/`send_list`/
  // `send_template` steps are explicitly guarded to WhatsApp-only —
  // see assertWhatsappChannel in src/lib/automations/engine.ts).
  const flowConsumed = false

  const automationTriggers: ('first_inbound_message' | 'new_message_received' | 'keyword_match')[] = []
  if (!flowConsumed) automationTriggers.push('new_message_received', 'keyword_match')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: { message_text: text, conversation_id: conversationId },
    }).catch((err) => console.error('[widget/message] automations dispatch failed:', err))
  }

  if (!flowConsumed && text) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId: ownerUserId,
      inboundMessageId: insertedMessage.id,
    })
  }

  await dispatchWebhookEvent(admin, accountId, 'message.received', {
    conversation_id: conversationId,
    contact_id: contactId,
    content_type: 'text',
    text,
  })

  return withCors(NextResponse.json({ success: true, messageId: insertedMessage.id }), corsOrigin)
}
