// ============================================================
// What happens to a verified Vircle Chat webhook event
// (docs/vircle-chat-contract.md, section 3 and 6).
//
//   message.inbound   find or create the contact (the gateway vouches for the
//                     identity, so the match is a VERIFIED one and may merge
//                     two records of the same person), find the one
//                     conversation, store the message, mirror any file into
//                     private storage, and run what every inbound message
//                     runs: unread counts, automations, AI replies and
//                     outbound webhooks.
//   message.receipt   move a sent message forward: delivered, read or failed.
//
// Both are safe to run twice for the same event: the gateway's message id is
// unique per conversation and a status only ever moves forward.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { findOrCreateConversation } from '@/lib/conversations/find-or-create'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { createSupabaseIdentityStore, resolveIdentityContact } from '@/lib/widget/identity-resolve'
import { normalizeEmail, normalizeIdentityPhone } from '@/lib/widget/identity-token'
import { isFirstCustomerMessage, runWidgetInboundFanout } from '@/lib/widget/inbound'

import type { InboundEvent, ReceiptEvent } from './contract'
import type { VircleChatConfigRow } from './config'
import { mirrorUserFile } from './media'

export const DEFAULT_CONTACT_NAME = 'Vircle user'
export const DROPPED_FILE_NOTE = '[Attachment not received]'

// ------------------------------------------------------------
// Who wrote
// ------------------------------------------------------------

/**
 * The one contact for a Vircle user. The gateway vouches for the identity, so the
 * match is a VERIFIED one (two records of the same person may be merged). The wallet id
 * is the channel's own key: `resolveIdentityContact` only falls back to it when the
 * phone and email match nothing, so when they match a DIFFERENT contact the wallet's
 * contact is folded into that one afterwards (the wallet id moves with the merge).
 */
export async function resolveVircleContact(
  admin: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  user: InboundEvent['user'],
): Promise<{ contactId: string; created: boolean }> {
  const store = createSupabaseIdentityStore(admin)
  const walletContact = await store.findByWallet(accountId, user.walletId)
  const result = await resolveIdentityContact(store, {
    accountId,
    ownerUserId,
    verified: true,
    identity: {
      phone: normalizeIdentityPhone(user.phone),
      email: normalizeEmail(user.email),
      walletId: user.walletId,
      name: user.name ?? DEFAULT_CONTACT_NAME,
    },
  })
  if (walletContact && walletContact.id !== result.contactId) {
    const merged = await store.mergeContacts(accountId, result.contactId, walletContact.id)
    if (!merged) await store.recordSuggestion(accountId, result.contactId, walletContact.id)
  }
  return { contactId: result.contactId, created: result.created }
}

// ------------------------------------------------------------
// message.inbound
// ------------------------------------------------------------

export type InboundResult =
  | {
      status: 'stored'
      messageId: string
      contactId: string
      conversationId: string
      /** Reopen, unread counts, automations, AI replies and outbound webhooks. Run after the event is answered. */
      fanOut: () => Promise<void>
    }
  | { status: 'duplicate'; messageId: string | null }

export async function ingestInbound(
  admin: SupabaseClient,
  cfg: VircleChatConfigRow,
  ev: InboundEvent,
): Promise<InboundResult> {
  const accountId = cfg.account_id
  const m = ev.message

  // A message with this gateway id already stored (a retried event, or the same
  // message arriving in two events): nothing to do.
  const existing = await findMessageByServerId(admin, accountId, m.serverId)
  if (existing) return { status: 'duplicate', messageId: existing.id }

  const ownerUserId = await resolveAuditUserId(admin, accountId)
  const identity = await resolveVircleContact(admin, accountId, ownerUserId, ev.user)

  const resolved = await findOrCreateConversation(admin, accountId, ownerUserId, identity.contactId)
  if (!resolved) throw new Error('Could not resolve the conversation for a Vircle Chat message')
  const conversation = resolved.conversation as { id: string; status?: string | null; vircle_conversation_id?: string | null }

  if (ev.conversationId && conversation.vircle_conversation_id !== ev.conversationId) {
    await admin.from('conversations').update({ vircle_conversation_id: ev.conversationId }).eq('id', conversation.id)
  }

  // The user's file: copy it into private storage. A file that cannot be taken is noted in
  // the message instead of failing the event (a retry would not fix a refused type).
  let mediaUrl: string | null = null
  let mediaType: string | null = null
  let contentType: string = m.type
  let text = m.text
  if (m.type !== 'text' && m.media) {
    mediaUrl = await mirrorUserFile({
      storage: admin.storage as never,
      accountId,
      serverId: m.serverId,
      kind: m.type,
      media: m.media,
      sentAt: m.sentAt,
    })
    if (mediaUrl) {
      mediaType = m.media.mimeType
    } else {
      contentType = 'text'
      text = text ? `${text}\n\n${DROPPED_FILE_NOTE}` : DROPPED_FILE_NOTE
    }
  }

  // A reply (contract 1.2): link it to the message it quotes, when that message is in this conversation.
  // An id Halo does not know is ignored: the message is stored without a link.
  const replyToMessageId = m.replyToServerId ? await findReplyTarget(admin, conversation.id, m.replyToServerId) : null

  const isFirst = await isFirstCustomerMessage(admin, conversation.id)
  const { data, error } = await admin
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: text,
      media_url: mediaUrl,
      media_type: mediaType,
      ...(mediaUrl && m.media?.animated ? { media_animated: true } : {}),
      channel_type: 'vircle_chat',
      status: 'sent',
      message_id: m.serverId,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    })
    .select('id')
    .single()

  if (error || !data) {
    if (isUniqueViolation(error)) {
      const raced = await findMessageByServerId(admin, accountId, m.serverId)
      return { status: 'duplicate', messageId: raced?.id ?? null }
    }
    throw new Error(`Could not store the Vircle Chat message: ${error?.message ?? 'no row returned'}`)
  }

  const fanOut = async () => {
    await reopenClosedConversation(admin, conversation).catch((err) =>
      console.error('[vircle-chat] reopen failed:', err),
    )
    await runWidgetInboundFanout(admin, {
      accountId,
      contactId: identity.contactId,
      conversation,
      ownerUserId,
      messageId: data.id as string,
      text: text ?? '',
      media: mediaUrl
        ? { url: mediaUrl, kind: contentType as 'image' | 'video' | 'audio' | 'document', mimeType: mediaType ?? 'application/octet-stream' }
        : null,
      isFirstInboundMessage: isFirst,
      channelType: 'vircle_chat',
    })
  }

  return { status: 'stored', messageId: data.id as string, contactId: identity.contactId, conversationId: conversation.id, fanOut }
}

/** Halo's message for a gateway id, in THIS conversation only (a quote never reaches into another chat). */
async function findReplyTarget(admin: SupabaseClient, conversationId: string, serverId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('messages')
    .select('id')
    .eq('message_id', serverId)
    .eq('channel_type', 'vircle_chat')
    .eq('conversation_id', conversationId)
    .limit(1)
  // A lookup that fails only costs the quote, never the message.
  if (error) return null
  return ((data ?? [])[0] as { id: string } | undefined)?.id ?? null
}

async function findMessageByServerId(admin: SupabaseClient, accountId: string, serverId: string) {
  const { data, error } = await admin
    .from('messages')
    .select('id, status, conversation_id, conversations!inner(account_id)')
    .eq('message_id', serverId)
    .eq('channel_type', 'vircle_chat')
    .eq('conversations.account_id', accountId)
    .limit(1)
  if (error) throw error
  return ((data ?? [])[0] as { id: string; status: string; conversation_id: string } | undefined) ?? null
}

// ------------------------------------------------------------
// message.receipt
// ------------------------------------------------------------

const LADDER = ['sent', 'delivered', 'read'] as const

/** Can a message move from `current` to `incoming`? Forward only; `failed` only from `sent`. */
export function canMoveStatus(current: string, incoming: ReceiptEvent['status']): boolean {
  if (incoming === 'failed') return current === 'sent' || current === 'pending'
  if (current === 'failed') return false
  const ci = (LADDER as readonly string[]).indexOf(current)
  const ii = (LADDER as readonly string[]).indexOf(incoming)
  return ii > ci
}

export type ReceiptResult = { status: 'updated' | 'ignored' | 'unknown_message' }

export async function applyReceipt(admin: SupabaseClient, cfg: VircleChatConfigRow, ev: ReceiptEvent): Promise<ReceiptResult> {
  const msg = await findMessageByServerId(admin, cfg.account_id, ev.serverId)
  if (!msg) return { status: 'unknown_message' }
  if (!canMoveStatus(msg.status, ev.status)) return { status: 'ignored' }

  const update: Record<string, unknown> = { status: ev.status }
  if (ev.status === 'failed') {
    update.error_code = ev.error?.code ?? 'unknown'
    update.error_title = ev.error?.message || 'The app reported the message as not delivered'
  }
  const { data: changed, error } = await admin
    .from('messages')
    .update(update)
    .eq('id', msg.id)
    .eq('status', msg.status)
    .select('id')
  if (error) throw new Error(`Could not update the message status: ${error.message}`)
  // A message the app reported as not delivered raises the same "Not sent" marker a failed send does.
  if (ev.status === 'failed' && (changed ?? []).length > 0) {
    await admin.from('conversations').update({ last_message_failed: true }).eq('id', msg.conversation_id)
  }
  return { status: 'updated' }
}
