// ============================================================
// Facebook Messenger webhook — structural mirror of
// src/app/api/whatsapp/webhook/route.ts (GET handshake / POST +
// after()-deferred processWebhook / idempotent insert / four-call
// fan-out), adapted for Messenger's payload shape and PSID identity.
//
// Two things with NO WhatsApp precedent, both load-bearing:
//   - `message.is_echo` MUST be filtered. Meta echoes every Page-sent
//     message back through this same webhook with `is_echo: true` —
//     without the skip, every agent reply from Vircle's own composer
//     would round-trip back in and get inserted a second time as a
//     fake inbound customer message.
//   - Attachment URLs arrive already-resolved (no WhatsApp-style
//     getMediaUrl metadata fetch), and are pre-authorized CDN links —
//     mirrored via an UNAUTHENTICATED fetch (downloadUnauthenticatedMedia),
//     not WhatsApp's Bearer-token download.
// ============================================================
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { downloadUnauthenticatedMedia } from '@/lib/meta/media'
import { findOrCreateContactByExternalId } from '@/lib/meta/contact-identity'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { getMessengerUserProfile } from '@/lib/messenger/meta-api'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface MessengerAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'template' | 'fallback'
  payload?: { url?: string }
}

interface MessengerMessage {
  mid: string
  text?: string
  attachments?: MessengerAttachment[]
  /** Meta echoes every Page-sent message back through this webhook
   *  with this set — MUST be filtered, see file header. */
  is_echo?: boolean
}

interface MessengerMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp: number
  message?: MessengerMessage
  /** Postback/delivery/read receipts — out of v1 scope, logged and
   *  skipped rather than processed. */
  postback?: unknown
  delivery?: unknown
  read?: unknown
}

interface MessengerWebhookEntry {
  id: string
  time: number
  messaging?: MessengerMessagingEvent[]
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('messenger_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('[messenger webhook] error fetching configs for verification:', configError)
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('messenger_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[messenger webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[messenger webhook] error in GET verification:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[messenger webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: MessengerWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('[messenger webhook] error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: MessengerWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    if (!entry.messaging || entry.messaging.length === 0) continue

    const pageId = entry.id

    const { data: configRows, error: configError } = await supabaseAdmin()
      .from('messenger_config')
      .select('*')
      .eq('page_id', pageId)

    if (configError) {
      console.error('[messenger webhook] error fetching messenger_config for page:', pageId, configError)
      continue
    }
    if (!configRows || configRows.length === 0) {
      console.error('[messenger webhook] no config found for page:', pageId)
      continue
    }
    if (configRows.length > 1) {
      console.error(
        `[messenger webhook] multiple configs (${configRows.length}) found for page:`,
        pageId,
        '— inbound message dropped.',
      )
      continue
    }

    const config = configRows[0]
    const pageAccessToken = decrypt(config.page_access_token)

    for (const event of entry.messaging) {
      await processMessagingEvent(event, config, pageAccessToken)
    }
  }
}

async function processMessagingEvent(
  event: MessengerMessagingEvent,
  config: { account_id: string; connected_by_user_id: string; page_id: string },
  pageAccessToken: string,
) {
  const message = event.message
  // Postback / delivery / read receipts — no local row to react to yet.
  if (!message) return
  // Filtering our own echoed sends — see file header.
  if (message.is_echo) return

  const accountId = config.account_id
  const configOwnerUserId = config.connected_by_user_id
  const psid = event.sender.id

  const contactOutcome = await findOrCreateContactByExternalId(supabaseAdmin(), {
    accountId,
    configOwnerUserId,
    column: 'messenger_psid',
    externalId: psid,
    resolveDisplayName: async () => {
      const profile = await getMessengerUserProfile({ psid, pageAccessToken }).catch(() => null)
      const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ').trim()
      return name || 'Messenger user'
    },
  })
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    supabaseAdmin(),
    accountId,
    configOwnerUserId,
    contactRecord.id as string,
  )
  if (!convResult) return
  const conversation = convResult.conversation

  let contentType: string = 'text'
  let contentText: string | null = message.text ?? null
  let mediaUrl: string | null = null

  const attachment = message.attachments?.[0]
  if (attachment?.payload?.url) {
    // messages.content_type has no 'file' value — Messenger's generic
    // attachment type maps onto our existing 'document' bucket.
    contentType =
      attachment.type === 'file'
        ? 'document'
        : attachment.type === 'template' || attachment.type === 'fallback'
          ? 'text'
          : attachment.type

    if (contentType !== 'text') {
      const mirrored = await mirrorInboundMedia({
        storage: supabaseAdmin().storage,
        accountId,
        mediaId: message.mid,
        downloadUrl: attachment.payload.url,
        // Unused by downloadUnauthenticatedMedia — required by the
        // shared function's signature only.
        accessToken: pageAccessToken,
        messageTimestamp: event.timestamp,
        download: downloadUnauthenticatedMedia,
      })
      // No local proxy route for Messenger media (unlike WhatsApp's
      // metadata-fetch-based one) — fall back to Meta's own CDN link
      // directly rather than a broken pointer.
      mediaUrl = mirrored ?? attachment.payload.url
    } else {
      contentText = contentText ?? '[Unsupported attachment]'
    }
  }

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        message_id: message.mid,
        channel_type: 'messenger',
        status: 'delivered',
        created_at: new Date(event.timestamp).toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[messenger webhook] error inserting message:', msgError)
    return
  }
  if (!insertedRows || insertedRows.length === 0) {
    console.info('[messenger webhook] duplicate inbound message ignored (idempotent replay):', message.mid)
    return
  }

  const { error: convError } = await supabaseAdmin().rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || `[${contentType}]`,
    p_channel_type: 'messenger',
  })
  if (convError) {
    console.error('[messenger webhook] error updating conversation:', convError)
  }

  await reopenClosedConversation(supabaseAdmin(), conversation)

  const inboundText = contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = ['new_message_received', 'keyword_match']
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id as string,
    conversationId: conversation.id,
    message: { kind: 'text', text: inboundText, meta_message_id: message.mid },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  if (!flowConsumed) {
    for (const triggerType of automationTriggers) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contactRecord.id as string,
        context: { message_text: inboundText, conversation_id: conversation.id },
      }).catch((err) => console.error('[messenger webhook] automations dispatch failed:', err))
    }
  } else {
    // Relationship-level triggers still fire even when the flow
    // consumed the message — same rule as the WhatsApp webhook.
    for (const triggerType of automationTriggers.filter(
      (t) => t === 'new_contact_created' || t === 'first_inbound_message',
    )) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contactRecord.id as string,
        context: { message_text: inboundText, conversation_id: conversation.id },
      }).catch((err) => console.error('[messenger webhook] automations dispatch failed:', err))
    }
  }

  if (!flowConsumed && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id as string,
      configOwnerUserId,
      inboundMessageId: message.mid,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.mid,
    content_type: contentType,
    text: contentText,
  })
}
