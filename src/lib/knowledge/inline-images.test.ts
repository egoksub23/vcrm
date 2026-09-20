import { afterEach, describe, expect, it, vi } from 'vitest'
import { kbImagePolicy, orderForDocument, reconcileInlineImages } from './inline-images'
import { cleanCaption, parseStagedAttachments, planAttachmentChanges } from './attachments-input'
import { parseDocInput } from '@/lib/ai/knowledge-doc'
import type { KbImagePolicy } from '@/lib/knowledge-format'
import type { StagedKnowledgeAttachment } from '@/lib/knowledge-types'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const BASE = 'https://abc.supabase.co'
const POLICY: KbImagePolicy = { accountId: ACCOUNT, publicBaseUrl: BASE }
const url = (name: string, account = ACCOUNT) => `${BASE}/storage/v1/object/public/chat-media/account-${account}/kb/${name}`
const path = (name: string, account = ACCOUNT) => `account-${account}/kb/${name}`

const file = (name: string, over: Partial<StagedKnowledgeAttachment> = {}): StagedKnowledgeAttachment => ({
  file_name: name,
  mime_type: 'image/png',
  size_bytes: 1000,
  url: url(name),
  storage_path: path(name),
  send_with_ai: true,
  inline: true,
  ...over,
})
const img = (name: string, alt = '') => `<img src="${url(name)}" alt="${alt}">`

afterEach(() => vi.unstubAllEnvs())

describe('kbImagePolicy', () => {
  it('builds the policy from the public Supabase URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', BASE)
    expect(kbImagePolicy(ACCOUNT)).toEqual(POLICY)
  })
  it('is null when the URL is not configured, so no image is accepted', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    expect(kbImagePolicy(ACCOUNT)).toBeNull()
  })
})

describe('orderForDocument', () => {
  const items = [
    { n: 'doc.pdf', inline: false },
    { n: 'b', inline: true },
    { n: 'a', inline: true },
    { n: 'sheet.xlsx' },
  ]
  const urlOf = (i: { n: string }) => `u/${i.n}`

  it('puts inline images first, in the order they appear in the text, then the other files as they were', () => {
    const out = orderForDocument(items, ['u/a', 'u/b'], urlOf)
    expect(out.map((i) => i.n)).toEqual(['a', 'b', 'doc.pdf', 'sheet.xlsx'])
  })
  it('counts an image that appears twice at its first place', () => {
    const out = orderForDocument(items, ['u/b', 'u/a', 'u/b'], urlOf)
    expect(out.map((i) => i.n).slice(0, 2)).toEqual(['b', 'a'])
  })
  it('puts an inline image the text no longer shows after the ones it shows, before plain files', () => {
    const out = orderForDocument(items, ['u/a'], urlOf)
    expect(out.map((i) => i.n)).toEqual(['a', 'b', 'doc.pdf', 'sheet.xlsx'])
  })
  it('does not change a list without inline images', () => {
    const plain = [{ n: 'x' }, { n: 'y' }]
    expect(orderForDocument(plain, [], urlOf)).toEqual(plain)
  })
})

describe('reconcileInlineImages', () => {
  it('orders the list by where the images sit in the text', () => {
    const html = `<p>${img('two.png')}</p><p>${img('one.png')}</p>`
    const out = reconcileInlineImages({
      html,
      items: [file('doc.pdf', { inline: false, mime_type: 'application/pdf' }), file('one.png'), file('two.png')],
      policy: POLICY,
    })
    expect(out.ok && out.items.map((i) => i.file_name)).toEqual(['two.png', 'one.png', 'doc.pdf'])
  })

  it('refuses an image in the text that is not in the attachments list', () => {
    const out = reconcileInlineImages({ html: `<p>${img('a.png')}</p>`, items: [], policy: POLICY })
    expect(out).toEqual({ ok: false, error: expect.stringContaining('not in its attachments list') })
  })

  it('refuses an image that is listed but not marked as shown in the article', () => {
    const out = reconcileInlineImages({
      html: `<p>${img('a.png')}</p>`,
      items: [file('a.png', { inline: false })],
      policy: POLICY,
    })
    expect(out.ok).toBe(false)
  })

  it('keeps a file marked inline that the text no longer shows, as a plain attachment', () => {
    const out = reconcileInlineImages({ html: '<p>No pictures</p>', items: [file('a.png')], policy: POLICY })
    expect(out.ok && out.items).toEqual([expect.objectContaining({ file_name: 'a.png', inline: false })])
  })

  it('only lets an image be inline', () => {
    const out = reconcileInlineImages({
      html: '<p>text</p>',
      items: [file('a.pdf', { mime_type: 'application/pdf' })],
      policy: POLICY,
    })
    expect(out.ok && out.items[0].inline).toBe(false)
  })

  it('does not accept another account\'s file: it never survives the sanitiser, so it is not "in the text"', () => {
    const html = `<p><img src="${url('a.png', OTHER)}" alt=""></p>`
    // the route sanitises first; what is left has no image, and a row pointing at
    // the other account's path is not one of this account's URLs either
    const out = reconcileInlineImages({
      html: '<p></p>',
      items: [file('a.png', { storage_path: path('a.png', OTHER), url: url('a.png', OTHER) })],
      policy: POLICY,
    })
    expect(out.ok && out.items[0].inline).toBe(false)
    expect(html).toContain(OTHER)
  })

  it('lets a translation show its base article\'s images', () => {
    const html = `<p>${img('base.png')}</p>`
    const out = reconcileInlineImages({ html, items: [], policy: POLICY, extraUrls: [url('base.png')] })
    expect(out.ok).toBe(true)
  })

  it('accepts the same image twice in the text', () => {
    const html = `<p>${img('a.png')}</p><p>${img('a.png')}</p>`
    expect(reconcileInlineImages({ html, items: [file('a.png')], policy: POLICY }).ok).toBe(true)
  })

  it('refuses every image when the policy cannot be used (nothing is trusted)', () => {
    const out = reconcileInlineImages({ html: `<p>${img('a.png')}</p>`, items: [file('a.png')], policy: null })
    // no policy = no images listed by the sanitiser, so nothing to match; the row
    // is then just a plain attachment
    expect(out.ok && out.items[0].inline).toBe(false)
  })
})

describe('parseDocInput with images', () => {
  const body = (html: string) => ({ title: 'T', content_html: html })

  it('keeps an own image and reads its caption into the plain text', () => {
    const r = parseDocInput(body(`<p>Open it.</p><p>${img('a.png', 'The menu')}</p>`), { partial: false, images: POLICY })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fields.content_html).toContain(`<img src="${url('a.png')}" alt="The menu">`)
      expect(r.fields.content).toBe('Open it.\n\n[image: The menu]')
    }
  })

  it('removes a foreign image and any script, whatever the client sent', () => {
    const r = parseDocInput(
      body(`<p>Hi</p><p><img src="https://evil.example/x.png" onerror="alert(1)"><img src="javascript:alert(1)"><img src="data:image/png;base64,AAAA"></p><script>alert(1)</script>`),
      { partial: false, images: POLICY },
    )
    expect(r.ok && r.fields.content_html).toBe('<p>Hi</p><p></p>')
  })

  it('removes every image when the server has no policy', () => {
    const r = parseDocInput(body(`<p>Hi</p><p>${img('a.png')}</p>`), { partial: false })
    expect(r.ok && r.fields.content_html).toBe('<p>Hi</p><p></p>')
  })

  it('does not count an image without a caption as text', () => {
    expect(parseDocInput(body(`<p>${img('a.png')}</p>`), { partial: false, images: POLICY })).toEqual({
      ok: false,
      error: 'content cannot be empty',
    })
  })
})

describe('parseStagedAttachments with inline and caption', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    file_name: 'pasted-image-1.png',
    mime_type: 'image/png',
    size_bytes: 2000,
    url: url('1-pasted-image-1.png'),
    storage_path: path('1-pasted-image-1.png'),
    ...over,
  })

  it('reads inline and a tidied caption', () => {
    const r = parseStagedAttachments([entry({ inline: true, caption: '  Step\n one  ' })], ACCOUNT)
    expect(r).toEqual({ ok: true, items: [expect.objectContaining({ inline: true, caption: 'Step one' })] })
  })

  it('defaults to not inline and no caption for a new file', () => {
    const r = parseStagedAttachments([entry()], ACCOUNT)
    expect(r).toEqual({ ok: true, items: [expect.objectContaining({ inline: false, caption: null })] })
  })

  it('turns a blank caption into null and cuts a long one to 1024 characters', () => {
    expect(cleanCaption('   ')).toBeNull()
    expect(cleanCaption('a'.repeat(1500))).toHaveLength(1024)
    const r = parseStagedAttachments([entry({ caption: '   ' })], ACCOUNT)
    expect(r.ok && r.items[0].caption).toBeNull()
  })

  it('refuses a non-boolean inline, a non-text caption and an absurdly long caption', () => {
    expect(parseStagedAttachments([entry({ inline: 'yes' })], ACCOUNT)).toEqual({ ok: false, error: 'inline must be true or false' })
    expect(parseStagedAttachments([entry({ caption: 5 })], ACCOUNT)).toEqual({ ok: false, error: 'caption must be text' })
    const long = parseStagedAttachments([entry({ caption: 'a'.repeat(5000) })], ACCOUNT)
    expect(long.ok).toBe(false)
  })

  it('leaves inline and caption unset for a kept file that does not mention them, so the stored values stay', () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const r = parseStagedAttachments([{ id, file_name: 'a.png', send_with_ai: false }], ACCOUNT)
    expect(r.ok && r.items[0]).not.toHaveProperty('inline')
    expect(r.ok && r.items[0]).not.toHaveProperty('caption')
    if (r.ok) {
      const plan = planAttachmentChanges([id], r.items)
      expect(plan.keep).toEqual([{ id, position: 0, send_with_ai: false }])
    }
  })

  it('passes inline and caption of a kept file to the plan, and keeps the list order as position', () => {
    const a = '33333333-3333-4333-8333-333333333333'
    const b = '44444444-4444-4444-8444-444444444444'
    const r = parseStagedAttachments(
      [
        { id: b, file_name: 'b.png', inline: true, caption: 'B' },
        { id: a, file_name: 'a.png', inline: false, caption: null },
      ],
      ACCOUNT,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const plan = planAttachmentChanges([a, b], r.items)
      expect(plan.keep).toEqual([
        { id: b, position: 0, send_with_ai: true, inline: true, caption: 'B' },
        { id: a, position: 1, send_with_ai: true, inline: false, caption: null },
      ])
    }
  })

  it('still refuses another account\'s object path for an inline image', () => {
    const r = parseStagedAttachments([entry({ inline: true, storage_path: path('x.png', OTHER) })], ACCOUNT)
    expect(r.ok).toBe(false)
  })

  it('still applies the 5 MB image cap and the 10 file cap to inline images', () => {
    expect(parseStagedAttachments([entry({ inline: true, size_bytes: 6 * 1024 * 1024 })], ACCOUNT).ok).toBe(false)
    const many = Array.from({ length: 11 }, (_, i) => entry({ inline: true, storage_path: path(`${i}.png`) }))
    expect(parseStagedAttachments(many, ACCOUNT).ok).toBe(false)
  })
})
