import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/conversations/comment-write', () => ({ postInternalComment: h.post }))

import { postSourcesNote, sourcesNoteText } from './sources-note'

const db = {} as SupabaseClient

beforeEach(() => {
  h.post.mockReset()
  h.post.mockResolvedValue({})
})

describe('sourcesNoteText', () => {
  it('lists the article titles', () => {
    expect(sourcesNoteText([{ id: '1', title: 'Business hours' }, { id: '2', title: 'Refunds' }])).toBe(
      'AI answered from: Business hours, Refunds',
    )
  })
  it('tidies whitespace, clips long titles and caps the list', () => {
    const long = 'x'.repeat(100)
    const text = sourcesNoteText([
      { id: '1', title: '  A \n B ' },
      { id: '2', title: long },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, title: `N${i}` })),
    ])
    expect(text.startsWith('AI answered from: A B, ')).toBe(true)
    expect(text).toContain('x'.repeat(79) + '…')
    expect(text.split(', ')).toHaveLength(5)
  })
})

describe('postSourcesNote', () => {
  it('posts an internal note as the bot with links to the articles', async () => {
    await postSourcesNote(db, 'acct', 'conv', [{ id: 'd1', title: 'Refunds' }])
    expect(h.post).toHaveBeenCalledWith(db, {
      accountId: 'acct',
      conversationId: 'conv',
      userId: null,
      senderType: 'bot',
      text: 'AI answered from: Refunds',
      kbSources: [{ id: 'd1', title: 'Refunds' }],
    })
  })
  it('does nothing without sources', async () => {
    await postSourcesNote(db, 'acct', 'conv', [])
    expect(h.post).not.toHaveBeenCalled()
  })
  it('never throws', async () => {
    h.post.mockRejectedValue(new Error('db down'))
    await expect(postSourcesNote(db, 'acct', 'conv', [{ id: 'd1', title: 'R' }])).resolves.toBeUndefined()
  })
})
