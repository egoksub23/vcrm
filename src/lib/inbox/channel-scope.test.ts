import { describe, it, expect } from 'vitest'
import { tabForChannel, unreadConversationCounts } from './channel-scope'

describe('tabForChannel', () => {
  it('puts Gmail and Microsoft 365 under Emails and every other channel under Chats', () => {
    expect(tabForChannel('gmail')).toBe('emails')
    expect(tabForChannel('email')).toBe('emails')
    for (const c of ['whatsapp', 'web_widget', 'messenger', 'instagram'] as const) {
      expect(tabForChannel(c)).toBe('chats')
    }
  })
})

describe('unreadConversationCounts', () => {
  it('counts conversations with unread messages per tab, not messages', () => {
    expect(
      unreadConversationCounts([
        { last_channel_type: 'whatsapp', unread_count: 5 },
        { last_channel_type: 'messenger', unread_count: 1 },
        { last_channel_type: 'instagram', unread_count: 0 },
        { last_channel_type: 'gmail', unread_count: 3 },
        { last_channel_type: 'email', unread_count: 0 },
      ]),
    ).toEqual({ chats: 2, emails: 1 })
  })

  it('is zero for an empty inbox', () => {
    expect(unreadConversationCounts([])).toEqual({ chats: 0, emails: 0 })
  })
})
