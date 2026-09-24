// ============================================================
// Gmail push-notification webhook — receives Google Cloud Pub/Sub push
// messages (not a Gmail-specific format; Pub/Sub wraps whatever was
// published). Structurally the most different webhook route in this
// app:
//
//   - No GET handshake at all. Pub/Sub push subscriptions verify their
//     endpoint at creation time in the GCP Console/CLI, not via a
//     request this app has to answer — see docs/gmail-setup.md.
//   - Auth is a `?token=` query-string param on the push endpoint URL
//     itself (compared against gmail_config.pubsub_verify_token),
//     since Pub/Sub carries no per-message signature or echoed
//     verify-token the way Meta/Graph webhooks do.
//   - The notification payload (base64 JSON inside `message.data`) is
//     just `{emailAddress, historyId}` — a pointer, like every other
//     channel's "notification without resource data". Processing
//     always calls `GET users.history.list` from the mailbox's last-
//     seen historyId to find out WHAT changed, then fetches each new
//     message individually. No is_echo problem: the watch registration
//     (src/lib/gmail/gmail-api.ts's watchMailbox) is scoped to the
//     INBOX label only, and an outbound send never gets that label.
// ============================================================
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { findOrCreateContactByExternalId } from '@/lib/meta/contact-identity'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { getValidAccessToken } from '@/lib/gmail/token'
import {
  getMessage,
  listHistory,
  getCurrentHistoryId,
  downloadAttachmentBytes,
} from '@/lib/gmail/gmail-api'

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

interface PubSubPushBody {
  message?: { data?: string; messageId?: string }
  subscription?: string
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 401 })
  }

  let body: PubSubPushBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data = body.message?.data
  if (!data) {
    // Pub/Sub sometimes sends empty verification pings — ack them so
    // it stops retrying, there's nothing to process.
    return NextResponse.json({ status: 'no-op' }, { status: 200 })
  }

  let payload: { emailAddress?: string; historyId?: string | number }
  try {
    payload = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'))
  } catch {
    return NextResponse.json({ error: 'Invalid Pub/Sub payload' }, { status: 400 })
  }

  if (!payload.emailAddress) {
    return NextResponse.json({ status: 'no-op' }, { status: 200 })
  }

  after(async () => {
    try {
      await processNotification(payload.emailAddress!, token)
    } catch (error) {
      console.error('[gmail webhook] error processing notification:', error)
    }
  })

  // Pub/Sub retries on anything outside 200-299 — ack immediately, the
  // same after()-deferred pattern every other webhook route here uses.
  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processNotification(emailAddress: string, token: string) {
  const admin = supabaseAdmin()

  const { data: config, error: configError } = await admin
    .from('gmail_config')
    .select('*')
    .eq('email_address', emailAddress)
    .maybeSingle()

  if (configError) {
    console.error('[gmail webhook] error fetching gmail_config:', configError)
    return
  }
  if (!config) {
    console.warn('[gmail webhook] no config for emailAddress:', emailAddress)
    return
  }
  if (config.pubsub_verify_token !== token) {
    console.warn('[gmail webhook] token mismatch for:', emailAddress)
    return
  }
  // Manually paused (migration 097) — ack Pub/Sub so it doesn't retry,
  // but don't fetch or store the message. The watch/token stay intact
  // for when the channel is re-enabled.
  // === false, not falsy — undefined (a row read before this column
  // existed) means "not yet backfilled", not "paused".
  if (config.enabled === false) return

  let accessToken: string
  try {
    accessToken = await getValidAccessToken(config)
  } catch (err) {
    console.error('[gmail webhook] token refresh failed:', err instanceof Error ? err.message : err)
    return
  }

  if (!config.history_id) {
    // First notification after a connect that skipped watch (no
    // GMAIL_PUBSUB_TOPIC configured at the time) — nothing to diff
    // against yet. Baseline from here and wait for the next one.
    const historyId = await getCurrentHistoryId({ accessToken }).catch(() => null)
    if (historyId) await admin.from('gmail_config').update({ history_id: historyId }).eq('id', config.id)
    return
  }

  const history = await listHistory({ accessToken, startHistoryId: config.history_id }).catch((err) => {
    console.error('[gmail webhook] listHistory failed:', err instanceof Error ? err.message : err)
    return null
  })
  if (!history) return

  if (history.historyExpired) {
    console.warn('[gmail webhook] history expired for', emailAddress, '— re-baselining historyId');
    const historyId = await getCurrentHistoryId({ accessToken }).catch(() => null)
    if (historyId) await admin.from('gmail_config').update({ history_id: historyId }).eq('id', config.id)
    return
  }

  for (const messageId of history.newMessageIds) {
    await processMessage(admin, config, accessToken, messageId)
  }

  await admin.from('gmail_config').update({ history_id: history.latestHistoryId }).eq('id', config.id)
}

async function processMessage(
  admin: ReturnType<typeof supabaseAdmin>,
  config: Record<string, unknown>,
  accessToken: string,
  messageId: string,
) {
  const accountId = config.account_id as string
  const configOwnerUserId = config.connected_by_user_id as string
  const mailboxAddress = (config.email_address as string).toLowerCase()

  const message = await getMessage({ accessToken, messageId }).catch((err) => {
    console.error('[gmail webhook] getMessage failed:', err instanceof Error ? err.message : err)
    return null
  })
  if (!message || !message.fromAddress) return

  // Defense in depth alongside the INBOX-only watch scope — never
  // treat a message from our own connected mailbox as inbound.
  if (message.fromAddress.toLowerCase() === mailboxAddress) return

  const contactOutcome = await findOrCreateContactByExternalId(admin, {
    accountId,
    configOwnerUserId,
    column: 'email',
    externalId: message.fromAddress,
    resolveDisplayName: async () => message.fromName || message.fromAddress!,
  })
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    admin,
    accountId,
    configOwnerUserId,
    contactRecord.id as string,
  )
  if (!convResult) return
  const conversation = convResult.conversation

  let contentType = 'text'
  let mediaUrl: string | null = null
  const contentText = message.bodyText || (message.subject ? `[${message.subject}]` : '[Email]')
  const createdAt = new Date(Number(message.internalDate) || Date.now()).toISOString()

  const firstAttachment = message.attachments[0]
  if (firstAttachment) {
    const bytes = await downloadAttachmentBytes({
      accessToken,
      messageId: message.id,
      attachmentId: firstAttachment.attachmentId,
    })
    if (bytes) {
      const mirrored = await mirrorInboundMedia({
        storage: admin.storage,
        accountId,
        mediaId: `${message.id}-${firstAttachment.attachmentId}`,
        messageTimestamp: Number(message.internalDate) || Date.now(),
        mimeType: firstAttachment.mimeType,
        fileName: firstAttachment.filename,
        downloadUrl: '',
        accessToken: '',
        download: async () => ({ buffer: bytes, contentType: firstAttachment.mimeType }),
      })
      if (mirrored) {
        mediaUrl = mirrored
        contentType = firstAttachment.mimeType.startsWith('image/') ? 'image' : 'document'
      }
    }
  }

  const { count: priorCustomerMsgCount } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: insertedRows, error: msgError } = await admin
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        content_html: message.bodyHtml,
        media_url: mediaUrl,
        message_id: message.id,
        channel_type: 'gmail',
        status: 'delivered',
        created_at: createdAt,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[gmail webhook] error inserting message:', msgError)
    return
  }
  if (!insertedRows || insertedRows.length === 0) {
    console.info('[gmail webhook] duplicate inbound message ignored (idempotent replay):', message.id)
    return
  }

  const { error: convError } = await admin.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText,
    p_channel_type: 'gmail',
  })
  if (convError) {
    console.error('[gmail webhook] error updating conversation:', convError)
  }

  await reopenClosedConversation(admin, conversation)

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
    message: { kind: 'text', text: contentText, meta_message_id: message.id },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  if (!flowConsumed) {
    for (const triggerType of automationTriggers) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contactRecord.id as string,
        context: { message_text: contentText, conversation_id: conversation.id },
      }).catch((err) => console.error('[gmail webhook] automations dispatch failed:', err))
    }
  } else {
    for (const triggerType of automationTriggers.filter(
      (t) => t === 'new_contact_created' || t === 'first_inbound_message',
    )) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contactRecord.id as string,
        context: { message_text: contentText, conversation_id: conversation.id },
      }).catch((err) => console.error('[gmail webhook] automations dispatch failed:', err))
    }
  }

  if (!flowConsumed && contentText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id as string,
      configOwnerUserId,
      inboundMessageId: message.id,
    })
  }

  await dispatchWebhookEvent(admin, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}
