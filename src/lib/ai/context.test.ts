import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().eq().neq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops an empty / whitespace-only text message with no recognised media type', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ', content_type: 'text' },
        { sender_type: 'customer', content_text: null, content_type: 'text' },
        { sender_type: 'customer', content_text: 'real', content_type: 'text' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('represents a captionless media message as a placeholder instead of dropping it', async () => {
    // fakeDb (like the real query) is fed newest-first; the function reverses it.
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: null, content_type: 'location' },
        { sender_type: 'agent', content_text: null, content_type: 'document' },
        { sender_type: 'customer', content_text: null, content_type: 'audio' },
        { sender_type: 'customer', content_text: null, content_type: 'video' },
        { sender_type: 'customer', content_text: null, content_type: 'image' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: '[Photo]' },
      { role: 'user', content: '[Video]' },
      { role: 'user', content: '[Voice message]' },
      { role: 'assistant', content: '[Document]' },
      { role: 'user', content: '[Location]' },
    ])
  })

  it('uses a media message\'s caption when it has one, instead of the placeholder', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'customer', content_text: 'here is the receipt', content_type: 'image' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'here is the receipt' }])
  })

  it('regression: keeps an earlier unanswered customer turn visible instead of silently merging it into the latest one', async () => {
    // The reported bug: a customer asked to reset a password, got no reply,
    // then sent a photo and a voice note (previously dropped from context
    // entirely, closing the gap), then asked an unrelated new question. The
    // auto-reply answered BOTH questions as if they were one, because the
    // dropped media made the two questions look adjacent. They must now
    // both appear, in order, as two separate, clearly turns apart.
    // fakeDb (like the real query) is fed newest-first; the function reverses it.
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: 'Hi, how to withdraw money from child account', content_type: 'text' },
        { sender_type: 'customer', content_text: null, content_type: 'audio' }, // a voice note
        { sender_type: 'agent', content_text: null, content_type: 'image' }, // an unrelated broadcast/marketing image
        { sender_type: 'customer', content_text: "hi, can you reset my daughter's login password?", content_type: 'text' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: "hi, can you reset my daughter's login password?" },
      { role: 'assistant', content: '[Photo]' },
      { role: 'user', content: '[Voice message]' },
      { role: 'user', content: 'Hi, how to withdraw money from child account' },
    ])
    // The model is left able to see there were two turns in between — it is
    // the system prompt (see defaults.test.ts) that now tells it to answer
    // only this last one.
  })
})

describe('getPreferredLanguage', () => {
  const dbReturning = (result: unknown, shouldThrow = false) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => (shouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve({ data: result })),
          }),
        }),
      }),
    }) as never

  it('reads the contact language, tolerating an array-shaped embed', async () => {
    const { getPreferredLanguage } = await import('./context')
    expect(await getPreferredLanguage(dbReturning({ contact: { language: 'ms' } }), 'c1')).toBe('ms')
    expect(await getPreferredLanguage(dbReturning({ contact: [{ language: 'zh' }] }), 'c1')).toBe('zh')
    expect(await getPreferredLanguage(dbReturning({ contact: { language: null } }), 'c1')).toBeNull()
    expect(await getPreferredLanguage(dbReturning(null), 'c1')).toBeNull()
  })

  it('resolves to null when the lookup fails', async () => {
    const { getPreferredLanguage } = await import('./context')
    expect(await getPreferredLanguage(dbReturning(null, true), 'c1')).toBeNull()
  })
})
