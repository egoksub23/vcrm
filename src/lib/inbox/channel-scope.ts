import type { ChannelType } from '@/types'

/**
 * The Email/Chat inbox split (user-requested Sep 19, 2026): two sidebar
 * menu entries filtering the same omnichannel `conversations`/`messages`
 * data by `last_channel_type` — not a new inbox architecture. Email
 * channels are `'email'` (Microsoft 365, migration 056) and `'gmail'`
 * (migration 058); everything else stays under Chat Inbox.
 */
export const EMAIL_CHANNELS: ChannelType[] = ['email', 'gmail']
export const CHAT_CHANNELS: ChannelType[] = ['whatsapp', 'web_widget', 'messenger', 'instagram']
export const ALL_CHANNELS: ChannelType[] = [...CHAT_CHANNELS, ...EMAIL_CHANNELS]
