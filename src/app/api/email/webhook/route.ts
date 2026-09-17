// ============================================================
// Microsoft Graph change-notification webhook for the Email channel.
// Structurally the odd one out among this repo's webhook routes:
//
//   - No GET handshake. Graph's equivalent validation step is a POST
//     carrying `?validationToken=` in the query string when a
//     subscription is first created; the correct response is to echo
//     that token back as `text/plain`, synchronously, within Graph's
//     10-second budget — handled inline below, before touching the DB.
//   - No HMAC signature. Graph notifications instead carry back
//     whatever `clientState` was set when the subscription was
//     created (this webhook's equivalent of WhatsApp/Messenger's
//     verify_token) — compared per-config, same decrypt-and-loop
//     pattern the Messenger webhook's GET handshake uses.
//   - The notification payload never contains the message itself (Graph
//     calls this a notification "without resource data" — the default,
//     and the only mode that doesn't require managing encryption
//     certificates). It's just `{subscriptionId, clientState, resource,
//     resourceData: {id}}` — a pointer. Processing always makes a
//     follow-up `GET /me/messages/{id}` call to fetch the actual
//     content, using the connected mailbox's (possibly refreshed)
//     access token.
//   - No is_echo filtering needed: the subscription (see
//     src/lib/ms365/mail-api.ts's createSubscription) is scoped to the
//     Inbox folder only, and an agent's own outbound replies never land
//     back in the Inbox — they go to Sent Items. Messenger/Instagram's
//     is_echo problem simply doesn't exist here.
// ============================================================
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { findOrCreateContactByExternalId } from '@/lib/meta/contact-identity'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { getValidAccessToken } from '@/lib/ms365/token'
import { getMessage, listAttachments, downloadAttachmentBytes } from '@/lib/ms365/mail-api'

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

interface GraphNotification {
  subscriptionId: string
  clientState?: string
  resourceData?: { id?: string }
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url)
  const validationToken = searchParams.get('validationToken')
  if (validationToken !== null) {
    // Subscription create/renew validation — must be answered
    // synchronously, plain text, before any DB work.
    return new Response(validationToken, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }

  let body: { value?: GraphNotification[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processNotifications(body)
    } catch (error) {
      console.error('[email webhook] error processing notifications:', error)
    }
  })

  // Graph expects a fast 202 — the same after()-deferred pattern every
  // other webhook route in this app already uses.
  return NextResponse.json({ status: 'received' }, { status: 202 })
}

async function processNotifications(body: { value?: GraphNotification[] }) {
  if (!body.value) return

  for (const notification of body.value) {
    if (!notification.resourceData?.id || !notification.clientState) continue

    const { data: configRows, error: configError } = await supabaseAdmin()
      .from('email_config')
      .select('*')
      .eq('subscription_id', notification.subscriptionId)

    if (configError) {
      console.error('[email webhook] error fetching email_config:', configError)
      continue
    }

    let config: Record<string, unknown> | null = null
    for (const row of configRows ?? []) {
      try {
        if (decrypt(row.client_state as string) === notification.clientState) {
          config = row
          break
        }
      } catch {
        // Malformed / wrong-key row — skip and keep checking.
      }
    }
    if (!config) {
      console.warn(
        '[email webhook] no matching config for subscription/clientState:',
        notification.subscriptionId,
      )
      continue
    }

    await processMessage(config, notification.resourceData.id)
  }
}

async function processMessage(config: Record<string, unknown>, graphMessageId: string) {
  const admin = supabaseAdmin()
  const accountId = config.account_id as string
  const configOwnerUserId = config.connected_by_user_id as string
  const mailboxAddress = (config.mailbox_address as string).toLowerCase()

  let accessToken: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessToken = await getValidAccessToken(config as any)
  } catch (err) {
    console.error('[email webhook] token refresh failed:', err instanceof Error ? err.message : err)
    return
  }

  const message = await getMessage({ accessToken, messageId: graphMessageId }).catch((err) => {
    console.error('[email webhook] getMessage failed:', err instanceof Error ? err.message : err)
    return null
  })
  if (!message || !message.fromAddress) return

  // Defense in depth alongside the Inbox-folder subscription scope —
  // never treat a message from our own connected mailbox as inbound.
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

  if (message.hasAttachments) {
    const attachments = await listAttachments({ accessToken, messageId: message.id }).catch(() => [])
    const first = attachments[0]
    if (first) {
      const downloaded = await downloadAttachmentBytes({
        accessToken,
        messageId: message.id,
        attachmentId: first.id,
      })
      if (downloaded) {
        const mirrored = await mirrorInboundMedia({
          storage: admin.storage,
          accountId,
          mediaId: `${message.id}-${first.id}`,
          messageTimestamp: new Date(message.receivedDateTime).getTime(),
          mimeType: downloaded.contentType,
          fileName: downloaded.name,
          // No download URL for a Graph attachment — bytes already sit
          // in hand from the JSON payload (downloadAttachmentBytes
          // above), so the `download` override just returns them
          // instead of doing a second fetch.
          downloadUrl: '',
          accessToken: '',
          download: async () => ({ buffer: downloaded.bytes, contentType: downloaded.contentType }),
        })
        if (mirrored) {
          mediaUrl = mirrored
          contentType = downloaded.contentType.startsWith('image/') ? 'image' : 'document'
        }
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
        media_url: mediaUrl,
        message_id: message.id,
        channel_type: 'email',
        status: 'delivered',
        created_at: message.receivedDateTime,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[email webhook] error inserting message:', msgError)
    return
  }
  if (!insertedRows || insertedRows.length === 0) {
    console.info('[email webhook] duplicate inbound message ignored (idempotent replay):', message.id)
    return
  }

  const { error: convError } = await admin.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText,
    p_channel_type: 'email',
  })
  if (convError) {
    console.error('[email webhook] error updating conversation:', convError)
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
      }).catch((err) => console.error('[email webhook] automations dispatch failed:', err))
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
      }).catch((err) => console.error('[email webhook] automations dispatch failed:', err))
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
