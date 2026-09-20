import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb, type FakeDb } from '@/lib/comments/fake-db'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  keepTranslationsCurrent: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/knowledge/translations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge/translations')>()),
  keepTranslationsCurrent: h.keepTranslationsCurrent,
}))

import { DELETE, GET, PATCH } from './route'

const ACCT = 'acct'
const NOW = '2026-09-20T10:00:00Z'
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'base',
  account_id: ACCT,
  title: 'Refunds',
  content: 'Refund in 14 days.',
  content_html: '<p>Refund in 14 days.</p>',
  kind: 'article',
  language: 'en',
  status: 'draft',
  use_in_ai: true,
  category: null,
  collection_id: null,
  review_by: null,
  updated_at: NOW,
  created_by: 'agent-1',
  source_conversation_id: null,
  source_id: null,
  translation_of: null,
  machine_translated: false,
  translated_from_at: null,
  ...over,
})

const att = (id: string, documentId: string) => ({
  id,
  account_id: ACCT,
  document_id: documentId,
  file_name: `${id}.pdf`,
  mime_type: 'application/pdf',
  size_bytes: 1,
  kind: 'document',
  storage_path: `account-${ACCT}/kb/${id}.pdf`,
  public_url: `https://cdn/${id}.pdf`,
  send_with_ai: true,
  position: 0,
})

function as(role: string, userId: string, fake: FakeDb) {
  const c = { supabase: fake.db, accountId: ACCT, userId, role }
  h.requireRole.mockResolvedValue(c)
  h.getCurrentAccount.mockResolvedValue(c)
}

const json = (method: string, body: unknown, url = 'http://localhost/api/knowledge/base') =>
  new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  h.requireRole.mockReset()
  h.getCurrentAccount.mockReset()
  h.keepTranslationsCurrent.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GET /api/knowledge/[id] with translations', () => {
  it('lists the translations of a base article with their flags', async () => {
    const fake = makeFakeDb({
      ai_knowledge_documents: [
        doc({ status: 'published', updated_at: '2026-09-20T12:00:00Z' }),
        doc({ id: 'ms1', language: 'ms', translation_of: 'base', machine_translated: true, translated_from_at: '2026-09-20T09:00:00Z', status: 'draft' }),
        doc({ id: 'zh1', language: 'zh', translation_of: 'base', translated_from_at: '2026-09-20T12:00:00Z', status: 'published' }),
      ],
    })
    as('admin', 'admin-1', fake)
    const article = await (await GET(new Request('http://x'), params('base'))).json()
    expect(article).toMatchObject({ translation_of: null, out_of_date: false, base: null, inherited_attachments: [] })
    expect(article.translations).toEqual([
      { language: 'ms', id: 'ms1', status: 'draft', out_of_date: true, machine_translated: true },
      { language: 'zh', id: 'zh1', status: 'published', out_of_date: false, machine_translated: false },
    ])
  })

  it('gives a translation its base, whether it is out of date and the base files it inherits', async () => {
    const fake = makeFakeDb({
      ai_knowledge_documents: [
        doc({ updated_at: '2026-09-20T12:00:00Z' }),
        doc({ id: 'ms1', language: 'ms', translation_of: 'base', machine_translated: true, translated_from_at: '2026-09-20T09:00:00Z' }),
      ],
      knowledge_attachments: [att('f1', 'base')],
    })
    as('admin', 'admin-1', fake)
    const article = await (await GET(new Request('http://x'), params('ms1'))).json()
    expect(article).toMatchObject({
      translation_of: 'base',
      machine_translated: true,
      out_of_date: true,
      translations: [],
      base: { id: 'base', title: 'Refunds', language: 'en', status: 'draft', created_by: 'agent-1' },
      attachments: [],
    })
    expect(article.inherited_attachments.map((f: { id: string }) => f.id)).toEqual(['f1'])
  })

  it('shows no inherited files once the translation has files of its own', async () => {
    const fake = makeFakeDb({
      ai_knowledge_documents: [doc(), doc({ id: 'ms1', language: 'ms', translation_of: 'base', translated_from_at: NOW })],
      knowledge_attachments: [att('f1', 'base'), att('own', 'ms1')],
    })
    as('admin', 'admin-1', fake)
    const article = await (await GET(new Request('http://x'), params('ms1'))).json()
    expect(article.attachments.map((f: { id: string }) => f.id)).toEqual(['own'])
    expect(article.inherited_attachments).toEqual([])
    expect(article.out_of_date).toBe(false)
  })
})

describe('PATCH /api/knowledge/[id] with translations', () => {
  it('clears machine_translated when a person saves the translation', async () => {
    const fake = makeFakeDb({
      ai_knowledge_documents: [doc(), doc({ id: 'ms1', language: 'ms', translation_of: 'base', machine_translated: true })],
    })
    as('agent', 'agent-1', fake)
    const res = await PATCH(json('PATCH', { title: 'Bayaran balik', content: 'Bayaran balik.' }), params('ms1'))
    expect(res.status).toBe(200)
    expect(fake.tables.ai_knowledge_documents.find((d) => d.id === 'ms1')).toMatchObject({
      title: 'Bayaran balik',
      machine_translated: false,
    })
  })

  it('does not touch the flag of a base article', async () => {
    const fake = makeFakeDb({ ai_knowledge_documents: [doc()] })
    as('agent', 'agent-1', fake)
    await PATCH(json('PATCH', { title: 'New title' }), params('base'))
    expect(fake.tables.ai_knowledge_documents[0].machine_translated).toBe(false)
  })

  it('refuses to change the language of a translation, allows the same one', async () => {
    const fake = makeFakeDb({
      ai_knowledge_documents: [doc(), doc({ id: 'ms1', language: 'ms', translation_of: 'base', machine_translated: true })],
    })
    as('agent', 'agent-1', fake)
    const bad = await PATCH(json('PATCH', { language: 'zh', title: 'x' }), params('ms1'))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/language of a translation/i)
    expect(fake.tables.ai_knowledge_documents.find((d) => d.id === 'ms1')).toMatchObject({ language: 'ms', machine_translated: true })
    expect((await PATCH(json('PATCH', { language: 'ms', title: 'x' }), params('ms1'))).status).toBe(200)
  })

  it('keeps translations current when the save leaves the text alone, and not when it changes it', async () => {
    const fake = makeFakeDb({ ai_knowledge_documents: [doc({ status: 'published', created_by: 'admin-1' })] })
    as('admin', 'admin-1', fake)
    // publishing / the AI switch: the editor sends the same text back
    await PATCH(
      json('PATCH', { title: 'Refunds', content_html: '<p>Refund in 14 days.</p>', status: 'published', use_in_ai: false }),
      params('base'),
    )
    expect(h.keepTranslationsCurrent).toHaveBeenCalledTimes(1)
    expect(h.keepTranslationsCurrent).toHaveBeenCalledWith(expect.anything(), ACCT, 'base', NOW, NOW)

    h.keepTranslationsCurrent.mockClear()
    await PATCH(json('PATCH', { title: 'Refunds', content_html: '<p>Refund in 30 days.</p>' }), params('base'))
    expect(h.keepTranslationsCurrent).not.toHaveBeenCalled()
  })

  it('never keeps a translation current on the strength of its own save', async () => {
    const fake = makeFakeDb({
      ai_knowledge_documents: [doc(), doc({ id: 'ms1', language: 'ms', translation_of: 'base' })],
    })
    as('agent', 'agent-1', fake)
    await PATCH(json('PATCH', { use_in_ai: false }), params('ms1'))
    expect(h.keepTranslationsCurrent).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/knowledge/[id] with translations', () => {
  const del = (id: string, query = '') => new Request(`http://localhost/api/knowledge/${id}${query}`, { method: 'DELETE' })
  const library = () =>
    makeFakeDb({
      ai_knowledge_documents: [
        doc(),
        doc({ id: 'ms1', language: 'ms', translation_of: 'base' }),
        doc({ id: 'zh1', language: 'zh', translation_of: 'base' }),
      ],
      knowledge_attachments: [att('f-ms', 'ms1')],
    })

  it('warns with 409 and the count instead of deleting the translations silently', async () => {
    const fake = library()
    as('agent', 'agent-1', fake)
    const res = await DELETE(del('base'), params('base'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_translations', count: 2 })
    expect(fake.tables.ai_knowledge_documents).toHaveLength(3)
  })

  it('deletes the article once the caller has confirmed', async () => {
    const fake = library()
    as('agent', 'agent-1', fake)
    const res = await DELETE(del('base', '?with_translations=true'), params('base'))
    expect(res.status).toBe(200)
    expect(fake.tables.ai_knowledge_documents.find((d) => d.id === 'base')).toBeUndefined()
  })

  it('does not let an agent delete an article whose translation is not their own draft', async () => {
    const fake = makeFakeDb({
      ai_knowledge_documents: [doc(), doc({ id: 'ms1', language: 'ms', translation_of: 'base', created_by: 'admin-1', status: 'published' })],
    })
    as('agent', 'agent-1', fake)
    const res = await DELETE(del('base', '?with_translations=true'), params('base'))
    expect(res.status).toBe(403)
    expect(fake.tables.ai_knowledge_documents).toHaveLength(2)
  })

  it('lets an admin delete it, and deletes a translation alone without any warning', async () => {
    const fake = library()
    as('admin', 'admin-1', fake)
    expect((await DELETE(del('ms1'), params('ms1'))).status).toBe(200)
    expect(fake.tables.ai_knowledge_documents.map((d) => d.id).sort()).toEqual(['base', 'zh1'])
    expect((await DELETE(del('base', '?with_translations=true'), params('base'))).status).toBe(200)
  })

  it('still refuses an agent someone else draft, and 404s an unknown article', async () => {
    const fake = makeFakeDb({ ai_knowledge_documents: [doc({ created_by: 'someone' })] })
    as('agent', 'agent-1', fake)
    expect((await DELETE(del('base'), params('base'))).status).toBe(403)
    expect((await DELETE(del('nope'), params('nope'))).status).toBe(404)
  })
})
