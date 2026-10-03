// ============================================================
// "Read" ticks back to the app (docs/vircle-chat-contract.md, section 4.1).
//
// When an agent reads a Vircle user's messages, Halo tells the gateway which
// ones (`POST /v1/receipts`), so the app can show them as read. The database
// flips the customer messages to `read` when the agent opens the conversation
// (migration 150); `read_receipt_sent_at` remembers which of those the gateway
// has been told about, so every call sends each message once and a failed call
// is simply tried again the next time (the next open, bulk mark-as-read or
// agent reply).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findVircleTarget, openGatewayConnection } from './connection'
import { sendReadReceipts } from './gateway'

/** The contract's ceiling for one receipts call. */
export const RECEIPT_BATCH_MAX = 200

/**
 * Tell the gateway about this conversation's customer messages that are `read` in Halo and that it
 * has not been told about yet (the oldest 200 per call). Marks exactly the ones it sent as told, and
 * only when the gateway accepted the call. Safe to call at any time and any number of times: with
 * nothing to tell it does no gateway call, and it NEVER throws (a failure is logged and the messages
 * stay pending for a later try). Resolves with how many messages the gateway was told about.
 */
export async function notifyVircleReads(admin: SupabaseClient, accountId: string, conversationId: string): Promise<number> {
  try {
    const target = await findVircleTarget(admin, accountId, conversationId, { requireVircleChannel: false })
    if (!target) return 0

    const { data, error } = await admin
      .from('messages')
      .select('id, message_id')
      .eq('conversation_id', conversationId)
      .eq('channel_type', 'vircle_chat')
      .eq('sender_type', 'customer')
      .eq('status', 'read')
      .is('read_receipt_sent_at', null)
      .not('message_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(RECEIPT_BATCH_MAX)
    if (error) throw new Error(error.message)
    const pending = ((data ?? []) as { id: string; message_id: string | null }[]).filter((m) => !!m.message_id)
    if (pending.length === 0) return 0

    const conn = await openGatewayConnection(admin, accountId)
    if (!conn) return 0

    await sendReadReceipts(conn, target.walletId, pending.map((m) => m.message_id as string))

    const { error: markError } = await admin
      .from('messages')
      .update({ read_receipt_sent_at: new Date().toISOString() })
      .in('id', pending.map((m) => m.id))
      .is('read_receipt_sent_at', null)
    if (markError) throw new Error(markError.message)
    return pending.length
  } catch (err) {
    console.error('[vircle-chat] could not send read receipts:', err instanceof Error ? err.message : err)
    return 0
  }
}
