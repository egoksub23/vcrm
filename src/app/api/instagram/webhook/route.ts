// ============================================================
// Instagram DM webhook — same structure as
// src/app/api/messenger/webhook/route.ts (which itself mirrors the
// WhatsApp webhook). See that file's header for the `is_echo` and
// unauthenticated-media-download notes, which apply identically here.
//
// Tenant resolution note: `entry.id` is looked up against
// `instagram_config.ig_business_account_id`. Meta's Instagram Messaging
// webhook payload shape has changed which id lands in `entry.id` across
// Graph API versions — this was NOT verified against a live payload
// during this pass (no test IG account available); confirm against a
// real webhook delivery before relying on this in production, and swap
// to a `page_id` lookup here if it turns out to send the linked Page's
// id instead.
// ============================================================
import { NextResponse, after } from 'next/server'
import { hasCommentChanges, processMetaCommentChanges, type MetaEntryWithChanges } from '@/lib/comments/meta-webhook'
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

interface InstagramAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'template' | 'fallback' | 'story_mention' | 'share'
  payload?: { url?: string }
}

interface InstagramMessage {
  mid: string
  text?: string
  attachments?: InstagramAttachment[]
  is_echo?: boolean
}

interface InstagramMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp: number
  message?: InstagramMessage
  postback?: unknown
}

interface InstagramWebhookEntry {
  id: string
  time: number
  messaging?: InstagramMessagingEvent[]
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
      .from('instagram_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('[instagram webhook] error fetching configs for verification:', configError)
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
          .from('instagram_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[instagram webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[instagram webhook] error in GET verification:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[instagram webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: InstagramWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('[instagram webhook] error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: InstagramWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    // Post comments arrive as `changes` (field "comments" / "live_comments").
    if (hasCommentChanges(entry as unknown as MetaEntryWithChanges)) {
      await processMetaCommentChanges(supabaseAdmin(), 'instagram', entry as unknown as MetaEntryWithChanges)
    }
    if (!entry.messaging || entry.messaging.length === 0) continue

    const igBusinessAccountId = entry.id

    const { data: configRows, error: configError } = await supabaseAdmin()
      .from('instagram_config')
      .select('*')
      .eq('ig_business_account_id', igBusinessAccountId)

    if (configError) {
      console.error(
        '[instagram webhook] error fetching instagram_config for account:',
        igBusinessAccountId,
        configError,
      )
      continue
    }
    if (!configRows || configRows.length === 0) {
      console.error('[instagram webhook] no config found for IG business account:', igBusinessAccountId)
      continue
    }
    if (configRows.length > 1) {
      console.error(
        `[instagram webhook] multiple configs (${configRows.length}) found for IG business account:`,
        igBusinessAccountId,
        '— inbound message dropped.',
      )
      continue
    }

    const config = configRows[0]

    // Manually paused (migration 097) — ack the webhook so Meta doesn't
    // retry, but don't store or process the message. The token stays
    // intact for when the channel is re-enabled.
    // === false, not falsy — undefined (a row read before this column
    // existed) means "not yet backfilled", not "paused".
    if (config.enabled === false) continue

    const pageAccessToken = decrypt(config.page_access_token)

    for (const event of entry.messaging) {
      await processMessagingEvent(event, config, pageAccessToken)
    }
  }
}

async function processMessagingEvent(
  event: InstagramMessagingEvent,
  config: { account_id: string; connected_by_user_id: string; ig_business_account_id: string },
  pageAccessToken: string,
) {
  const message = event.message
  if (!message) return
  // Filtering our own echoed sends — same requirement as Messenger.
  if (message.is_echo) return

  const accountId = config.account_id
  const configOwnerUserId = config.connected_by_user_id
  const igsid = event.sender.id

  const contactOutcome = await findOrCreateContactByExternalId(supabaseAdmin(), {
    accountId,
    configOwnerUserId,
    column: 'instagram_igsid',
    externalId: igsid,
    resolveDisplayName: async () => 'Instagram user',
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
    contentType =
      attachment.type === 'file'
        ? 'document'
        : attachment.type === 'image' || attachment.type === 'video' || attachment.type === 'audio'
          ? attachment.type
          : 'text'

    if (contentType !== 'text') {
      const mirrored = await mirrorInboundMedia({
        storage: supabaseAdmin().storage,
        accountId,
        mediaId: message.mid,
        downloadUrl: attachment.payload.url,
        accessToken: pageAccessToken,
        messageTimestamp: event.timestamp,
        download: downloadUnauthenticatedMedia,
      })
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
        channel_type: 'instagram',
        status: 'delivered',
        created_at: new Date(event.timestamp).toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[instagram webhook] error inserting message:', msgError)
    return
  }
  if (!insertedRows || insertedRows.length === 0) {
    console.info('[instagram webhook] duplicate inbound message ignored (idempotent replay):', message.mid)
    return
  }

  const { error: convError } = await supabaseAdmin().rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || `[${contentType}]`,
    p_channel_type: 'instagram',
  })
  if (convError) {
    console.error('[instagram webhook] error updating conversation:', convError)
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

  const triggersToFire = flowConsumed
    ? automationTriggers.filter((t) => t === 'new_contact_created' || t === 'first_inbound_message')
    : automationTriggers
  for (const triggerType of triggersToFire) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id as string,
      context: { message_text: inboundText, conversation_id: conversation.id },
    }).catch((err) => console.error('[instagram webhook] automations dispatch failed:', err))
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
