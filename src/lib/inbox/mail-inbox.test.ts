import { describe, expect, it } from 'vitest'

import { composerChannels, mailInboxOffChannels } from './mail-inbox'

// The Inbox does not offer email as a channel to reply on when the mailbox is switched off as the customer care inbox (migration 179).

describe('which email channels the Inbox does not offer', () => {
  it('is none when both mailboxes are used for the inbox, or are not connected', () => {
    expect(mailInboxOffChannels({})).toEqual([])
    expect(mailInboxOffChannels({ email_config: null, gmail_config: null })).toEqual([])
    expect(mailInboxOffChannels({ email_config: { inbox_enabled: true }, gmail_config: { inbox_enabled: true } })).toEqual([])
  })

  it('is the channel of each mailbox switched off, independently', () => {
    expect(mailInboxOffChannels({ email_config: { inbox_enabled: false } })).toEqual(['email'])
    expect(mailInboxOffChannels({ gmail_config: { inbox_enabled: false } })).toEqual(['gmail'])
    expect(mailInboxOffChannels({ email_config: { inbox_enabled: false }, gmail_config: { inbox_enabled: false } })).toEqual(['email', 'gmail'])
    expect(mailInboxOffChannels({ email_config: { inbox_enabled: true }, gmail_config: { inbox_enabled: false } })).toEqual(['gmail'])
  })

  it('treats a row without the column, or with NULL, as on (only === false counts)', () => {
    expect(mailInboxOffChannels({ email_config: {}, gmail_config: { inbox_enabled: null } })).toEqual([])
  })
})

describe('the channels the composer offers', () => {
  it('lists every channel the conversation has used when nothing is switched off', () => {
    expect(composerChannels({ used: ['whatsapp', 'email'], last: 'email', off: [] })).toEqual({ channels: ['whatsapp', 'email'], initial: 'email' })
  })

  it('does not offer a switched-off email channel when there is another one, and starts on the other one', () => {
    expect(composerChannels({ used: ['whatsapp', 'email'], last: 'email', off: ['email'] })).toEqual({ channels: ['whatsapp'], initial: 'whatsapp' })
    expect(composerChannels({ used: ['email', 'gmail'], last: 'gmail', off: ['gmail'] })).toEqual({ channels: ['email'], initial: 'email' })
  })

  it('keeps starting on the last channel when that one is still open', () => {
    expect(composerChannels({ used: ['whatsapp', 'email'], last: 'whatsapp', off: ['email'] })).toEqual({ channels: ['whatsapp'], initial: 'whatsapp' })
  })

  it('keeps the only channel there is, so the composer can show its read-only notice', () => {
    expect(composerChannels({ used: ['email'], last: 'email', off: ['email'] })).toEqual({ channels: ['email'], initial: 'email' })
    expect(composerChannels({ used: [], last: 'gmail', off: ['gmail'] })).toEqual({ channels: ['gmail'], initial: 'gmail' })
  })

  it('always includes the conversation\'s last channel even before its messages have loaded', () => {
    expect(composerChannels({ used: [], last: 'whatsapp', off: ['email'] })).toEqual({ channels: ['whatsapp'], initial: 'whatsapp' })
  })
})
