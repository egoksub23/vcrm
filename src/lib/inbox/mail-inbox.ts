import type { ChannelType } from '@/types'

/**
 * Which email channels the Inbox must not OFFER (migration 179): a connected mailbox can be switched off as the customer care inbox
 * (`inbox_enabled` false) while staying connected for Halo's own email. Its conversations stay in the Inbox as history, but nobody can reply by
 * email from them, and the channel picker does not list it. Pure, so the rule is tested without a screen.
 */

/** The channel of each mailbox table. */
const MAILBOX_CHANNEL = { email_config: 'email', gmail_config: 'gmail' } as const

export type MailboxTable = keyof typeof MAILBOX_CHANNEL

/**
 * The email channels switched off as the inbox, from the mailbox rows the account has (a row is absent when the mailbox is not connected; that is not
 * "switched off", it is "not connected", and sending says so itself). `=== false`, not falsy: a row read before the column existed has the inbox on.
 */
export function mailInboxOffChannels(rows: Partial<Record<MailboxTable, { inbox_enabled?: boolean | null } | null>>): ChannelType[] {
  const off: ChannelType[] = []
  for (const table of Object.keys(MAILBOX_CHANNEL) as MailboxTable[]) {
    if (rows[table] && rows[table]!.inbox_enabled === false) off.push(MAILBOX_CHANNEL[table])
  }
  return off
}

/**
 * The channels the composer offers for a conversation, and the one it starts on. A switched-off email channel is not offered while the conversation
 * has another channel to reply on; when it is the conversation's only channel it stays (the composer then shows a read-only notice instead of a box).
 * The starting channel is the conversation's last one, unless that one is switched off and another is available.
 */
export function composerChannels(args: { used: readonly ChannelType[]; last: ChannelType; off: readonly ChannelType[] }): { channels: ChannelType[]; initial: ChannelType } {
  const used = Array.from(new Set<ChannelType>([...args.used, args.last]))
  const open = used.filter((c) => !args.off.includes(c))
  const channels = open.length > 0 ? open : used
  const initial = args.off.includes(args.last) && open.length > 0 ? open[0] : args.last
  return { channels, initial }
}
