// ============================================================
// `user.typing` (docs/vircle-chat-contract.md, section 3.4): the Vircle user is typing.
//
// Ephemeral by design: nothing is stored and the event id is not remembered. Halo finds the
// user's conversation and broadcasts a Supabase Realtime message on
// `vircle-typing:<haloConversationId>` that an open Inbox thread listens to.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { createSupabaseIdentityStore } from '@/lib/widget/identity-resolve'

import type { TypingEvent } from './contract'
import { TYPING_EVENT, typingChannelName } from './typing-channel'

export type TypingResult = { status: 'broadcast'; conversationId: string } | { status: 'unknown_user' }

/**
 * Tell every agent looking at this user's conversation that the user is typing. A user or
 * conversation Halo has not seen yet is ignored (there is nobody to show it to). Throws only
 * when the broadcast itself fails; the caller answers 200 either way, because a typing signal is
 * never retried.
 */
export async function broadcastUserTyping(admin: SupabaseClient, accountId: string, ev: TypingEvent): Promise<TypingResult> {
  const contact = await createSupabaseIdentityStore(admin).findByWallet(accountId, ev.walletId)
  if (!contact) return { status: 'unknown_user' }

  const { data, error } = await admin
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(error.message)
  const conversationId = ((data ?? [])[0] as { id: string } | undefined)?.id
  if (!conversationId) return { status: 'unknown_user' }

  // A REST broadcast: the server never subscribes, so there is no socket to open or leave behind.
  const channel = admin.channel(typingChannelName(conversationId))
  try {
    await channel.httpSend(TYPING_EVENT, { at: new Date().toISOString() })
  } finally {
    await admin.removeChannel(channel)
  }
  return { status: 'broadcast', conversationId }
}
