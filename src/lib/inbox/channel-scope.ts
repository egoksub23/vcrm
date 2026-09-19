import type { ChannelType, Conversation } from '@/types'

/**
 * The inbox is one list split into two tabs — Chats and Emails — by
 * `last_channel_type`. Email channels are `'email'` (Microsoft 365,
 * migration 056) and `'gmail'` (migration 058); everything else is a chat.
 * Not a second inbox: both tabs read the same conversations.
 */
export const EMAIL_CHANNELS: ChannelType[] = ['email', 'gmail']
export const CHAT_CHANNELS: ChannelType[] = ['whatsapp', 'web_widget', 'messenger', 'instagram']

export type InboxTab = 'chats' | 'emails'

export const TAB_CHANNELS: Record<InboxTab, ChannelType[]> = {
  chats: CHAT_CHANNELS,
  emails: EMAIL_CHANNELS,
}

export function tabForChannel(channel: ChannelType): InboxTab {
  return EMAIL_CHANNELS.includes(channel) ? 'emails' : 'chats'
}

/** Conversations with at least one unread message, per tab — the number
 *  in each tab's bubble. Counts conversations, not messages, matching the
 *  green unread dot on each row. */
export function unreadConversationCounts(
  conversations: Pick<Conversation, 'last_channel_type' | 'unread_count'>[],
): Record<InboxTab, number> {
  const out: Record<InboxTab, number> = { chats: 0, emails: 0 }
  for (const c of conversations) {
    if (c.unread_count > 0) out[tabForChannel(c.last_channel_type)] += 1
  }
  return out
}
