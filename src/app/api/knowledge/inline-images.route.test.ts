import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb, type FakeDb } from '@/lib/comments/fake-db'
import { resolveCapabilities } from '@/lib/auth/capabilities'
import type { AccountRole } from '@/lib/auth/roles'

const h = vi.hoisted(() => ({ requireAnyCapability: vi.fn(), getCurrentAccount: vi.fn() }))

vi.mock('@/lib/auth/account', () => ({
  requireAnyCapability: h.requireAnyCapability,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))

import { POST } from './route'
import { PATCH } from './[id]/route'

// The account id doubles as the uuid the sanitiser requires.
const ACCT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SUPABASE = 'https://abc.supabase.co'
const url = (name: string, account = ACCT) => `${SUPABASE}/storage/v1/object/public/chat-media/account-${account}/kb/${name}`
const path = (name: string, account = ACCT) => `account-${account}/kb/${name}`
const img = (name: string, alt = '') => `<img src="${url(name)}" alt="${alt}">`
const NOW = '2026-09-20T10:00:00Z'

function withStorage(fake: FakeDb): FakeDb {
  Object.assign(fake.db, {
    storage: {
      from: () => ({
        getPublicUrl: (p: string) => ({ data: { publicUrl: `${SUPABASE}/storage/v1/object/public/chat-media/${p}` } }),
        remove: async () => ({ error: null }),
      }),
    },
  })
  return fake
}

function as(role: AccountRole, userId: string, fake: FakeDb) {
  const c = { supabase: fake.db, accountId: ACCT, userId, role, capabilities: resolveCapabilities(role) }
  h.requireAnyCapability.mockResolvedValue(c)
  h.getCurrentAccount.mockResolvedValue(c)
}

const post = (body: unknown) =>
  new Request('http://localhost/api/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const patch = (body: unknown) =>
  new Request('http://localhost/api/knowledge/d1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const newFile = (name: string, over: Record<string, unknown> = {}) => ({
  file_name: name,
  mime_type: 'image/png',
  size_bytes: 1000,
  url: url(name),
  storage_path: path(name),
  send_with_ai: true,
  inline: true,
  ...over,
})

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  account_id: ACCT,
  title: 'Guide',
  content: 'Text',
  content_html: '<p>Text</p>',
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

const stored = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  account_id: ACCT,
  document_id: 'd1',
  file_name: name,
  mime_type: 'image/png',
  size_bytes: 1000,
  kind: 'image',
  storage_path: path(name),
  public_url: url(name),
  send_with_ai: true,
  position: 0,
  inline: true,
  caption: null,
  ...over,
})

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
  h.requireAnyCapability.mockReset()
  h.getCurrentAccount.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/knowledge with inline images', () => {
  it('saves the article with its images and stores them as in-article attachments in document order', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [] }))
    as('agent', 'agent-1', fake)
    const res = await POST(
      post({
        title: 'Guide',
        content_html: `<p>Open Settings.</p><p>${img('two.png', 'Two')}</p><p>${img('one.png', 'One')}</p>`,
        attachments: [newFile('one.png', { caption: 'One' }), newFile('two.png', { caption: 'Two' })],
      }),
    )
    expect(res.status).toBe(200)
    const saved = fake.tables.ai_knowledge_documents[0]
    expect(saved.content_html).toContain(`<img src="${url('two.png')}" alt="Two">`)
    expect(saved.content).toBe('Open Settings.\n\n[image: Two]\n\n[image: One]')
    expect(fake.tables.knowledge_attachments.map((a) => [a.file_name, a.position, a.inline, a.caption, a.kind])).toEqual([
      ['two.png', 0, true, 'Two', 'image'],
      ['one.png', 1, true, 'One', 'image'],
    ])
    // the public URL is derived on the server from the object path
    expect(fake.tables.knowledge_attachments[0].public_url).toBe(url('two.png'))
  })

  it('refuses an image in the text that is not in the attachments list, with a clear message', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [] }))
    as('agent', 'agent-1', fake)
    const res = await POST(post({ title: 'Guide', content_html: `<p>Hi</p><p>${img('a.png')}</p>` }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not in its attachments list/i)
    expect(fake.tables.ai_knowledge_documents).toHaveLength(0)
  })

  it('removes foreign images, data URLs and handlers before anything is stored', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [] }))
    as('agent', 'agent-1', fake)
    const res = await POST(
      post({
        title: 'Guide',
        content_html:
          `<p>Hello</p><p><img src="https://evil.example/x.png" onerror="alert(1)">` +
          `<img src="data:image/svg+xml;base64,AAAA"><img src="${url('a.png', OTHER)}"><img src="${url('a.png')}?x=1"></p>`,
      }),
    )
    expect(res.status).toBe(200)
    const html = fake.tables.ai_knowledge_documents[0].content_html as string
    expect(html).not.toMatch(/<img|evil|data:|onerror/)
  })

  it('refuses an attachment stored in another account\'s folder', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [] }))
    as('agent', 'agent-1', fake)
    const res = await POST(
      post({
        title: 'Guide',
        content_html: `<p>Hi</p><p>${img('a.png')}</p>`,
        attachments: [newFile('a.png', { storage_path: path('a.png', OTHER) })],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('applies the file count cap to in-article images', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [] }))
    as('agent', 'agent-1', fake)
    const names = Array.from({ length: 11 }, (_, i) => `p${i}.png`)
    const res = await POST(
      post({
        title: 'Guide',
        content_html: `<p>Hi</p><p>${names.map((n) => img(n)).join('')}</p>`,
        attachments: names.map((n) => newFile(n)),
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at most 10/)
  })

  it('keeps a file marked inline that is not in the text as a plain attachment', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [] }))
    as('agent', 'agent-1', fake)
    const res = await POST(post({ title: 'Guide', content_html: '<p>No pictures</p>', attachments: [newFile('a.png')] }))
    expect(res.status).toBe(200)
    expect(fake.tables.knowledge_attachments[0]).toMatchObject({ file_name: 'a.png', inline: false })
  })

  it('does not let a non-image be inline', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [] }))
    as('agent', 'agent-1', fake)
    const res = await POST(
      post({
        title: 'Guide',
        content_html: '<p>Text</p>',
        attachments: [newFile('a.pdf', { mime_type: 'application/pdf' })],
      }),
    )
    expect(res.status).toBe(200)
    expect(fake.tables.knowledge_attachments[0]).toMatchObject({ kind: 'document', inline: false })
  })
})

describe('PATCH /api/knowledge/[id] with inline images', () => {
  const ID1 = '33333333-3333-4333-8333-333333333331'
  const ID2 = '33333333-3333-4333-8333-333333333332'

  it('puts existing files in document order and updates their caption and flag', async () => {
    const fake = withStorage(
      makeFakeDb({
        ai_knowledge_documents: [doc()],
        knowledge_attachments: [
          stored(ID1, 'one.png', { position: 0 }),
          stored(ID2, 'two.png', { position: 1 }),
        ],
      }),
    )
    as('agent', 'agent-1', fake)
    const res = await PATCH(
      patch({
        title: 'Guide',
        content_html: `<p>Look</p><p>${img('two.png', 'Second')}</p><p>${img('one.png', 'First')}</p>`,
        attachments: [
          { id: ID1, ...newFile('one.png', { caption: 'First' }) },
          { id: ID2, ...newFile('two.png', { caption: 'Second' }) },
        ],
      }),
      params('d1'),
    )
    expect(res.status).toBe(200)
    const rows = fake.tables.knowledge_attachments
    expect(rows.find((r) => r.id === ID2)).toMatchObject({ position: 0, caption: 'Second', inline: true })
    expect(rows.find((r) => r.id === ID1)).toMatchObject({ position: 1, caption: 'First', inline: true })
  })

  it('removes an image deleted from the text, and its file, when the editor leaves it out of the list', async () => {
    const fake = withStorage(
      makeFakeDb({
        ai_knowledge_documents: [doc()],
        knowledge_attachments: [stored(ID1, 'one.png'), stored(ID2, 'two.png', { position: 1 })],
      }),
    )
    as('agent', 'agent-1', fake)
    const res = await PATCH(
      patch({
        title: 'Guide',
        content_html: `<p>Look</p><p>${img('two.png')}</p>`,
        attachments: [{ id: ID2, ...newFile('two.png') }],
      }),
      params('d1'),
    )
    expect(res.status).toBe(200)
    expect(fake.tables.knowledge_attachments.map((r) => r.id)).toEqual([ID2])
  })

  it('refuses text with an image whose file is not in the list', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [doc()], knowledge_attachments: [] }))
    as('agent', 'agent-1', fake)
    const res = await PATCH(patch({ title: 'Guide', content_html: `<p>Look</p><p>${img('ghost.png')}</p>`, attachments: [] }), params('d1'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not in its attachments list/i)
    expect(fake.tables.ai_knowledge_documents[0].content_html).toBe('<p>Text</p>')
  })

  it('checks new text against the stored list when the editor sends no list', async () => {
    const fake = withStorage(
      makeFakeDb({ ai_knowledge_documents: [doc()], knowledge_attachments: [stored(ID1, 'one.png')] }),
    )
    as('agent', 'agent-1', fake)
    const ok = await PATCH(patch({ title: 'Guide', content_html: `<p>Look</p><p>${img('one.png', 'Cap')}</p>` }), params('d1'))
    expect(ok.status).toBe(200)
    const bad = await PATCH(patch({ title: 'Guide', content_html: `<p>Look</p><p>${img('other.png')}</p>` }), params('d1'))
    expect(bad.status).toBe(400)
    // the stored file was kept
    expect(fake.tables.knowledge_attachments).toHaveLength(1)
  })

  it('lets a translation show its base article\'s images without listing them as its own', async () => {
    const fake = withStorage(
      makeFakeDb({
        ai_knowledge_documents: [doc({ id: 'base' }), doc({ id: 'ms1', language: 'ms', translation_of: 'base' })],
        knowledge_attachments: [stored(ID1, 'one.png', { document_id: 'base' })],
      }),
    )
    as('agent', 'agent-1', fake)
    const res = await PATCH(patch({ title: 'Panduan', content_html: `<p>Lihat</p><p>${img('one.png', 'Menu')}</p>` }), params('ms1'))
    expect(res.status).toBe(200)
    expect(fake.tables.ai_knowledge_documents.find((d) => d.id === 'ms1')?.content_html).toContain(url('one.png'))
    // still not copied: the base keeps the only row
    expect(fake.tables.knowledge_attachments).toHaveLength(1)
    // but an image that is nobody's is refused
    const bad = await PATCH(patch({ title: 'Panduan', content_html: `<p>Lihat</p><p>${img('nobody.png')}</p>` }), params('ms1'))
    expect(bad.status).toBe(400)
  })

  it('removes foreign images from a save the same way as on create', async () => {
    const fake = withStorage(makeFakeDb({ ai_knowledge_documents: [doc()], knowledge_attachments: [] }))
    as('agent', 'agent-1', fake)
    const res = await PATCH(
      patch({
        title: 'Guide',
        content_html: `<p>Hi</p><p><img src="https://evil.example/x.png"><img src="javascript:alert(1)"></p>`,
      }),
      params('d1'),
    )
    expect(res.status).toBe(200)
    expect(fake.tables.ai_knowledge_documents[0].content_html).not.toMatch(/img|evil|javascript/)
  })
})
