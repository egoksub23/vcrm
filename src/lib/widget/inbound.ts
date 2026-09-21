// ============================================================
// Web Widget v2 — persisting a visitor's message and running the inbound
// fan-out. Shared by POST /api/widget/message and POST /api/widget/enquiry
// so both fire exactly what the message route always fired (automations,
// AI auto-reply, outbound webhooks) and route/assign the same way.
//
// Flows (the visual IVR builder) are still not dispatched for widget
// conversations: its send nodes call Meta directly and would error against
// a contact with no phone (see docs/web-chat-widget.md).
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import type { WidgetMediaKind } from '@/lib/widget/media'

export type WidgetContentType = 'text' | WidgetMediaKind

export interface InboundMedia {
  url: string
  kind: WidgetMediaKind
  mimeType: string
}

export interface InsertedWidgetMessage {
  id: string
  created_at: string
  status: string
}

/** True when this conversation has no customer message yet (BEFORE the insert). */
export async function isFirstCustomerMessage(admin: SupabaseClient, conversationId: string): Promise<boolean> {
  const { count } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
  return (count ?? 0) === 0
}

/** `messages.message_id` key for a widget client id (dedupes a retried send). */
export function clientMessageKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return id ? `wc:${id}` : null
}

/**
 * Insert the customer message. `status` starts 'sent' (the widget contract).
 * A `clientMessageId` makes the insert idempotent: a retried request (the
 * first response was lost) returns the original row with `duplicate: true`
 * instead of creating a second message. The key lives in `message_id`, whose
 * (conversation_id, message_id) unique index (migration 037) enforces it.
 */
export async function insertWidgetCustomerMessage(
  admin: SupabaseClient,
  args: { conversationId: string; text: string; media?: InboundMedia | null; clientMessageId?: unknown },
): Promise<(InsertedWidgetMessage & { duplicate: boolean }) | null> {
  const { conversationId, text, media } = args
  const key = clientMessageKey(args.clientMessageId)

  const findExisting = async () => {
    if (!key) return null
    const { data } = await admin
      .from('messages')
      .select('id, created_at, status')
      .eq('conversation_id', conversationId)
      .eq('message_id', key)
      .maybeSingle()
    return (data as InsertedWidgetMessage | null) ?? null
  }

  const prior = await findExisting()
  if (prior) return { ...prior, duplicate: true }

  const { data, error } = await admin
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: media ? media.kind : 'text',
      content_text: text || null,
      media_url: media?.url ?? null,
      media_type: media?.mimeType ?? null,
      channel_type: 'web_widget',
      status: 'sent',
      message_id: key,
    })
    .select('id, created_at, status')
    .single()
  if (error || !data) {
    if (isUniqueViolation(error)) {
      const raced = await findExisting()
      if (raced) return { ...raced, duplicate: true }
    }
    console.error('[widget/inbound] message insert error:', error)
    return null
  }
  return { ...(data as InsertedWidgetMessage), duplicate: false }
}

/** What the inbox list shows as the last message. */
export function previewText(text: string, media?: InboundMedia | null): string {
  return text || (media ? `[${media.kind}]` : '')
}

export interface FanoutArgs {
  accountId: string
  contactId: string
  conversation: { id: string; status?: string | null }
  ownerUserId: string
  messageId: string
  text: string
  media?: InboundMedia | null
  isFirstInboundMessage: boolean
  visitorId?: string
}

/** Everything that happens after a customer message row exists. */
export async function runWidgetInboundFanout(admin: SupabaseClient, args: FanoutArgs): Promise<void> {
  const { accountId, contactId, conversation, ownerUserId, messageId, text, media, isFirstInboundMessage } = args
  const conversationId = conversation.id

  await admin.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversationId,
    p_last_message_text: previewText(text, media),
    p_channel_type: 'web_widget',
  })

  await reopenClosedConversation(admin, conversation)
  if (args.visitorId) {
    await admin
      .from('widget_visitors')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', args.visitorId)
  }

  const triggers: ('first_inbound_message' | 'new_message_received' | 'keyword_match')[] = [
    'new_message_received',
    'keyword_match',
  ]
  if (isFirstInboundMessage) triggers.unshift('first_inbound_message')

  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: { message_text: text, conversation_id: conversationId },
    }).catch((err) => console.error('[widget/inbound] automations dispatch failed:', err))
  }

  if (text) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId: ownerUserId,
      inboundMessageId: messageId,
    })
  }

  await dispatchWebhookEvent(admin, accountId, 'message.received', {
    conversation_id: conversationId,
    contact_id: contactId,
    content_type: media ? media.kind : 'text',
    text,
    ...(media ? { media_url: media.url } : {}),
  })
}
