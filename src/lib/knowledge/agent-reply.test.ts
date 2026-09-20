import { describe, it, expect } from 'vitest'
import { pickAgentReply, type ThreadMessage } from './agent-reply'

const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({
  sender_type: 'agent',
  content_type: 'text',
  content_text: 'Hello',
  is_internal: false,
  created_at: '2026-05-01T10:05:00Z',
  ...over,
})
const AFTER = '2026-05-01T10:00:00Z'

describe('pickAgentReply', () => {
  it('returns the first human text reply after the handoff', () => {
    expect(
      pickAgentReply(
        [
          msg({ content_text: 'Second', created_at: '2026-05-01T10:09:00Z' }),
          msg({ content_text: '  First  ', created_at: '2026-05-01T10:05:00Z' }),
        ],
        AFTER,
      ),
    ).toBe('First')
  })

  it('skips the bot, customers, internal notes, media and earlier messages', () => {
    expect(
      pickAgentReply(
        [
          msg({ sender_type: 'bot', content_text: 'bot' }),
          msg({ sender_type: 'customer', content_text: 'customer' }),
          msg({ is_internal: true, content_text: 'note' }),
          msg({ content_type: 'document', content_text: 'caption' }),
          msg({ content_text: 'before', created_at: '2026-05-01T09:00:00Z' }),
          msg({ content_text: '   ' }),
        ],
        AFTER,
      ),
    ).toBeNull()
  })

  it('returns null for an empty thread', () => {
    expect(pickAgentReply([], AFTER)).toBeNull()
  })
})
