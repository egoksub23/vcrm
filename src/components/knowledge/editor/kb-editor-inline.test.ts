import { describe, expect, it } from 'vitest'

import {
  buildSavePayload,
  inlineRowsMissingFromHtml,
  stagedAttachments,
  unsavedUploads,
  type AttachmentRow,
} from './kb-editor-utils'

const BASE = 'https://abc.supabase.co/storage/v1/object/public/chat-media/account-a/kb'
const row = (name: string, over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  key: name,
  file_name: name,
  mime_type: 'image/png',
  size_bytes: 1000,
  url: `${BASE}/${name}`,
  storage_path: `account-a/kb/${name}`,
  send_with_ai: true,
  status: 'ready',
  inline: true,
  ...over,
})
const img = (name: string, alt = '') => `<img src="${BASE}/${name}" alt="${alt}">`

describe('stagedAttachments with the article text', () => {
  it('lists inline images in the order they appear in the text, then the other files', () => {
    const rows = [
      row('doc.pdf', { inline: false, mime_type: 'application/pdf' }),
      row('one.png'),
      row('two.png'),
      row('three.png'),
    ]
    const html = `<p>${img('three.png')}</p><p>${img('one.png')}${img('two.png')}</p>`
    expect(stagedAttachments(rows, html).map((r) => r.file_name)).toEqual(['three.png', 'one.png', 'two.png', 'doc.pdf'])
  })

  it('leaves out an inline image deleted from the text, so the server removes it', () => {
    const rows = [row('a.png', { id: 'att-a' }), row('b.png', { id: 'att-b' })]
    const out = stagedAttachments(rows, `<p>${img('b.png')}</p>`)
    expect(out.map((r) => r.file_name)).toEqual(['b.png'])
  })

  it('takes each image caption from the alt text in the article', () => {
    const out = stagedAttachments([row('a.png', { caption: 'old' })], `<p>${img('a.png', 'Step 1: open Settings')}</p>`)
    expect(out[0]).toMatchObject({ inline: true, caption: 'Step 1: open Settings' })
  })

  it('clears the caption when the alt text was emptied', () => {
    expect(stagedAttachments([row('a.png', { caption: 'old' })], `<p>${img('a.png')}</p>`)[0].caption).toBeNull()
  })

  it('never drops a plain file that happens to be an image, or any file, for not being in the text', () => {
    const rows = [row('shot.png', { inline: false }), row('x.pdf', { inline: false, mime_type: 'application/pdf' })]
    expect(stagedAttachments(rows, '<p>text</p>')).toHaveLength(2)
  })

  it('sends inline and caption, keeps ids of saved files and skips unfinished uploads', () => {
    const rows = [row('a.png', { id: 'att-a' }), row('b.png', { status: 'uploading' }), row('c.png', { status: 'error' })]
    const out = stagedAttachments(rows, `<p>${img('a.png')}${img('b.png')}${img('c.png')}</p>`)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'att-a', inline: true, storage_path: 'account-a/kb/a.png' })
  })

  it('leaves the order and flags alone when no text is given (the old call)', () => {
    const rows = [row('x.png', { inline: false }), row('y.png', { inline: true })]
    expect(stagedAttachments(rows).map((r) => r.file_name)).toEqual(['x.png', 'y.png'])
  })

  it('does not mention inline for a row that never had it', () => {
    const plain: AttachmentRow = { ...row('p.pdf'), inline: undefined, caption: undefined }
    const out = stagedAttachments([plain])
    expect(out[0]).not.toHaveProperty('inline')
    expect(out[0]).not.toHaveProperty('caption')
  })
})

describe('inlineRowsMissingFromHtml', () => {
  it('finds the inline images the text no longer shows', () => {
    const rows = [row('a.png'), row('b.png'), row('c.pdf', { inline: false })]
    expect(inlineRowsMissingFromHtml(rows, `<p>${img('a.png')}</p>`).map((r) => r.key)).toEqual(['b.png'])
  })
  it('never counts an upload that is still running', () => {
    expect(inlineRowsMissingFromHtml([row('a.png', { status: 'uploading' })], '<p>x</p>')).toEqual([])
  })
  it('lets the unsaved ones be cleaned up from storage', () => {
    const rows = [row('a.png'), row('b.png', { id: 'att-b' })]
    expect(unsavedUploads(inlineRowsMissingFromHtml(rows, '<p>x</p>')).map((r) => r.key)).toEqual(['a.png'])
  })
})

describe('buildSavePayload with inline images', () => {
  it('puts the ordered attachment list in the body', () => {
    const body = buildSavePayload({
      title: 'T',
      html: `<p>${img('b.png', 'B')}${img('a.png')}</p>`,
      text: 'x',
      kind: 'article',
      language: 'en',
      useInAi: true,
      collectionId: null,
      reviewBy: '',
      status: null,
      attachments: [row('a.png'), row('b.png')],
    })
    const list = body.attachments as { file_name: string; caption: string | null }[]
    expect(list.map((r) => r.file_name)).toEqual(['b.png', 'a.png'])
    expect(list[0].caption).toBe('B')
  })
})
