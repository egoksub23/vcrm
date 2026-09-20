import { describe, it, expect } from 'vitest'
import { parseDocInput } from './knowledge-doc'

describe('parseDocInput (create)', () => {
  it('requires a title and content', () => {
    expect(parseDocInput({ title: 'T' }, { partial: false })).toEqual({ ok: false, error: 'title and content are required' })
    expect(parseDocInput({}, { partial: false }).ok).toBe(false)
    expect(parseDocInput(null, { partial: false }).ok).toBe(false)
  })

  it('accepts a full article and trims text', () => {
    const r = parseDocInput(
      { title: '  Refunds ', content: ' 30 days ', language: 'ms', kind: 'qa', use_in_ai: false, category: ' Billing ', review_by: '2026-12-01' },
      { partial: false },
    )
    expect(r).toEqual({
      ok: true,
      fields: { title: 'Refunds', content: '30 days', language: 'ms', kind: 'qa', use_in_ai: false, category: 'Billing', review_by: '2026-12-01' },
    })
  })

  it.each([
    [{ title: 'T', content: 'C', language: 'fr' }, 'language must be en, ms or zh'],
    [{ title: 'T', content: 'C', kind: 'faq' }, 'kind must be article or qa'],
    [{ title: 'T', content: 'C', status: 'archived' }, 'status must be draft or published'],
    [{ title: 'T', content: 'C', use_in_ai: 'yes' }, 'use_in_ai must be true or false'],
    [{ title: 'T', content: 'C', review_by: '01/12/2026' }, 'review_by must be a date (YYYY-MM-DD)'],
    [{ title: 'T', content: 'C', source_conversation_id: 'nope' }, 'source_conversation_id must be a conversation id'],
  ])('rejects %j', (body, error) => {
    expect(parseDocInput(body, { partial: false })).toEqual({ ok: false, error })
  })

  it('rejects an over-long title', () => {
    expect(parseDocInput({ title: 'x'.repeat(201), content: 'C' }, { partial: false }).ok).toBe(false)
  })

  it('clears optional fields with null or an empty string', () => {
    const r = parseDocInput({ title: 'T', content: 'C', category: '', review_by: null }, { partial: false })
    expect(r).toEqual({ ok: true, fields: { title: 'T', content: 'C', category: null, review_by: null } })
  })
})

describe('parseDocInput (update)', () => {
  it('accepts any single field', () => {
    expect(parseDocInput({ status: 'published' }, { partial: true })).toEqual({ ok: true, fields: { status: 'published' } })
  })
  it('rejects an empty update', () => {
    expect(parseDocInput({}, { partial: true })).toEqual({ ok: false, error: 'Nothing to update' })
  })
  it('rejects blanking the title', () => {
    expect(parseDocInput({ title: '   ' }, { partial: true }).ok).toBe(false)
  })
})

describe('parseDocInput (rich text and collections)', () => {
  it('derives plain content from sanitised html and ignores the client content', () => {
    const r = parseDocInput(
      { title: 'T', content: 'client-supplied text', content_html: '<p>Hello <strong>world</strong></p><script>x</script>' },
      { partial: false },
    )
    expect(r).toEqual({
      ok: true,
      fields: { title: 'T', content: 'Hello world', content_html: '<p>Hello <strong>world</strong></p>' },
    })
  })

  it('accepts html alone on create', () => {
    const r = parseDocInput({ title: 'T', content_html: '<ul><li>a</li></ul>' }, { partial: false })
    expect(r).toEqual({ ok: true, fields: { title: 'T', content: '- a', content_html: '<ul><li>a</li></ul>' } })
  })

  it('rejects html with no text in it', () => {
    expect(parseDocInput({ title: 'T', content_html: '<p></p><script>x</script>' }, { partial: false })).toEqual({
      ok: false,
      error: 'content cannot be empty',
    })
  })

  it('rejects oversized html and non-text html', () => {
    expect(parseDocInput({ title: 'T', content_html: 'x'.repeat(200001) }, { partial: false }).ok).toBe(false)
    expect(parseDocInput({ title: 'T', content_html: 5 }, { partial: false }).ok).toBe(false)
    expect(parseDocInput({ title: 'T', content_html: '<p>' + 'x'.repeat(20001) + '</p>' }, { partial: false }).ok).toBe(false)
  })

  it('allows clearing the rich version on update', () => {
    expect(parseDocInput({ content_html: null }, { partial: true })).toEqual({ ok: true, fields: { content_html: null } })
  })

  it('validates collection_id', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(parseDocInput({ collection_id: id }, { partial: true })).toEqual({ ok: true, fields: { collection_id: id } })
    expect(parseDocInput({ collection_id: null }, { partial: true })).toEqual({ ok: true, fields: { collection_id: null } })
    expect(parseDocInput({ collection_id: '' }, { partial: true })).toEqual({ ok: true, fields: { collection_id: null } })
    expect(parseDocInput({ collection_id: 'nope' }, { partial: true })).toEqual({
      ok: false,
      error: 'collection_id must be a collection id',
    })
  })
})
