import { describe, expect, it } from 'vitest'

import { KB_ATTACHMENT_MAX_BYTES, KB_MAX_ATTACHMENTS } from '@/lib/knowledge-types'
import {
  buildSavePayload,
  canEditArticle,
  checkAttachmentFile,
  fileVisual,
  formatBytes,
  normalizeLinkUrl,
  parseSeedParams,
  plainTextToEditorHtml,
  stagedAttachments,
  unsavedUploads,
  unwrapList,
  type AttachmentRow,
} from './kb-editor-utils'

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  key: 'k1',
  file_name: 'guide.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1000,
  url: 'https://x/y.pdf',
  storage_path: 'account-a/kb/1-guide.pdf',
  send_with_ai: true,
  status: 'ready',
  ...over,
})

describe('formatBytes', () => {
  it('scales to B, KB and MB', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB')
  })
  it('returns an empty string for nonsense', () => {
    expect(formatBytes(-1)).toBe('')
    expect(formatBytes(NaN)).toBe('')
  })
})

describe('fileVisual', () => {
  it('uses the MIME type first', () => {
    expect(fileVisual('image/png', 'a.png')).toBe('image')
    expect(fileVisual('application/pdf', 'a')).toBe('pdf')
    expect(fileVisual('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a')).toBe('word')
    expect(fileVisual('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a')).toBe('slides')
    expect(fileVisual('application/vnd.ms-excel', 'a')).toBe('sheet')
    expect(fileVisual('video/mp4', 'a.mp4')).toBe('video')
    expect(fileVisual('audio/ogg', 'a.ogg')).toBe('audio')
  })
  it('falls back to the extension when the browser gives no type', () => {
    expect(fileVisual('', 'Deck.PPTX')).toBe('slides')
    expect(fileVisual('', 'notes.md')).toBe('text')
    expect(fileVisual('', 'data.csv')).toBe('sheet')
    expect(fileVisual('', 'bundle.zip')).toBe('archive')
    expect(fileVisual('', 'mystery.bin')).toBe('other')
    expect(fileVisual('', 'noextension')).toBe('other')
  })
})

describe('checkAttachmentFile', () => {
  it('accepts a file within its cap', () => {
    expect(checkAttachmentFile({ type: 'application/pdf', size: 10 * 1024 * 1024 }, 0)).toBeNull()
  })
  it('holds images to the smaller cap', () => {
    const over = KB_ATTACHMENT_MAX_BYTES.image + 1
    expect(checkAttachmentFile({ type: 'image/jpeg', size: over }, 0)).toEqual({
      reason: 'tooLarge',
      maxBytes: KB_ATTACHMENT_MAX_BYTES.image,
    })
    // The same size is fine for a document.
    expect(checkAttachmentFile({ type: 'application/pdf', size: over }, 0)).toBeNull()
  })
  it('rejects a file over the document cap', () => {
    expect(checkAttachmentFile({ type: 'application/pdf', size: KB_ATTACHMENT_MAX_BYTES.other + 1 }, 0)).toEqual({
      reason: 'tooLarge',
      maxBytes: KB_ATTACHMENT_MAX_BYTES.other,
    })
  })
  it('rejects once the article is full', () => {
    expect(checkAttachmentFile({ type: 'text/plain', size: 1 }, KB_MAX_ATTACHMENTS)).toEqual({
      reason: 'tooMany',
      max: KB_MAX_ATTACHMENTS,
    })
    expect(checkAttachmentFile({ type: 'text/plain', size: 1 }, KB_MAX_ATTACHMENTS - 1)).toBeNull()
  })
})

describe('stagedAttachments', () => {
  it('keeps ids of saved files and omits them for new uploads', () => {
    const out = stagedAttachments([row({ id: 'att1', send_with_ai: false }), row({ key: 'k2' })])
    expect(out[0]).toMatchObject({ id: 'att1', send_with_ai: false })
    expect(out[1]).not.toHaveProperty('id')
  })
  it('skips uploads that are still running or failed', () => {
    const out = stagedAttachments([row(), row({ key: 'k2', status: 'uploading' }), row({ key: 'k3', status: 'error' })])
    expect(out).toHaveLength(1)
  })
  it('never sends an empty MIME type', () => {
    expect(stagedAttachments([row({ mime_type: '' })])[0].mime_type).toBe('application/octet-stream')
  })
})

describe('unsavedUploads', () => {
  it('returns only finished uploads that the server does not know', () => {
    const rows = [row({ id: 'att1' }), row({ key: 'k2' }), row({ key: 'k3', status: 'error', storage_path: '' })]
    expect(unsavedUploads(rows).map((r) => r.key)).toEqual(['k2'])
  })
})

describe('plainTextToEditorHtml', () => {
  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    expect(plainTextToEditorHtml('One\nTwo\n\nThree')).toBe('<p>One<br>Two</p><p>Three</p>')
  })
  it('escapes markup so old text cannot become tags', () => {
    expect(plainTextToEditorHtml('<b>x</b> & "y"')).toBe('<p>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</p>')
  })
  it('handles CRLF and empty input', () => {
    expect(plainTextToEditorHtml('a\r\n\r\nb')).toBe('<p>a</p><p>b</p>')
    expect(plainTextToEditorHtml('   ')).toBe('')
  })
})

describe('parseSeedParams', () => {
  const from = (q: string) => {
    const sp = new URLSearchParams(q)
    return parseSeedParams((k) => sp.get(k))
  }
  it('reads every supported seed', () => {
    expect(from('title=Refunds&content=Body&language=ms&kind=qa&conv=c1&gap=g1')).toEqual({
      title: 'Refunds',
      content: 'Body',
      language: 'ms',
      kind: 'qa',
      sourceConversationId: 'c1',
      resolvesGapId: 'g1',
    })
  })
  it('drops invalid language and kind and blank values', () => {
    expect(from('language=fr&kind=file&title=%20&content=')).toEqual({})
  })
})

describe('canEditArticle', () => {
  const draftMine = { status: 'draft' as const, created_by: 'u1' }
  it('lets admins edit anything', () => {
    expect(canEditArticle({ isAdmin: true, canWrite: true, userId: 'x', article: { status: 'published', created_by: 'u1' } })).toBe(true)
  })
  it('lets an agent create, and edit only their own draft', () => {
    expect(canEditArticle({ isAdmin: false, canWrite: true, userId: 'u1', article: null })).toBe(true)
    expect(canEditArticle({ isAdmin: false, canWrite: true, userId: 'u1', article: draftMine })).toBe(true)
    expect(canEditArticle({ isAdmin: false, canWrite: true, userId: 'u2', article: draftMine })).toBe(false)
    expect(canEditArticle({ isAdmin: false, canWrite: true, userId: 'u1', article: { status: 'published', created_by: 'u1' } })).toBe(false)
  })
  it('never lets a viewer edit', () => {
    expect(canEditArticle({ isAdmin: false, canWrite: false, userId: 'u1', article: null })).toBe(false)
  })
})

describe('buildSavePayload', () => {
  const base = {
    title: '  Refunds ',
    html: '<p>Hi</p>',
    text: ' Hi ',
    kind: 'article' as const,
    language: 'en' as const,
    useInAi: true,
    collectionId: null,
    reviewBy: '',
    status: null,
    attachments: [row()],
  }
  it('sends html, plain text, collection and attachments', () => {
    const body = buildSavePayload({ ...base, collectionId: 'col1', reviewBy: '2026-11-30', status: 'published', sourceConversationId: 'c9' })
    expect(body).toMatchObject({
      title: 'Refunds',
      content_html: '<p>Hi</p>',
      content: 'Hi',
      collection_id: 'col1',
      review_by: '2026-11-30',
      status: 'published',
      source_conversation_id: 'c9',
    })
    expect(body.attachments).toHaveLength(1)
  })
  it('omits status for agents and nulls an empty review date', () => {
    const body = buildSavePayload(base)
    expect(body).not.toHaveProperty('status')
    expect(body).not.toHaveProperty('source_conversation_id')
    expect(body.review_by).toBeNull()
    expect(body.collection_id).toBeNull()
  })
})

describe('unwrapList', () => {
  it('accepts a bare array or a keyed object', () => {
    expect(unwrapList<number>([1, 2], 'x')).toEqual([1, 2])
    expect(unwrapList<number>({ x: [3] }, 'x')).toEqual([3])
  })
  it('returns an empty list for anything else', () => {
    expect(unwrapList(null, 'x')).toEqual([])
    expect(unwrapList({ x: 'no' }, 'x')).toEqual([])
  })
})

describe('normalizeLinkUrl', () => {
  it('keeps safe schemes', () => {
    expect(normalizeLinkUrl('https://vircle.io/a?b=1')).toBe('https://vircle.io/a?b=1')
    expect(normalizeLinkUrl('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(normalizeLinkUrl('tel:+60123')).toBe('tel:+60123')
  })
  it('completes bare domains and emails', () => {
    expect(normalizeLinkUrl('vircle.io/pricing')).toBe('https://vircle.io/pricing')
    expect(normalizeLinkUrl('help@vircle.io')).toBe('mailto:help@vircle.io')
  })
  it('refuses script-like and unknown schemes and junk', () => {
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeLinkUrl('data:text/html,x')).toBeNull()
    expect(normalizeLinkUrl('not a url')).toBeNull()
    expect(normalizeLinkUrl('  ')).toBeNull()
  })
})
