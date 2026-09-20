import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'

import { KbAttachments } from './kb-attachments'
import type { AttachmentRow } from './kb-editor-utils'
import { PastedImageChip } from '@/components/inbox/pasted-image-chip'

// Server-render smoke tests (the repo has no DOM test library).
const messages = {
  Knowledge: {
    editor: {
      attachments: 'Attachments',
      sendWithAi: 'Send with AI answers',
      inArticle: 'In article',
      notInArticle: 'Removed from text',
      uploading: 'Uploading',
    },
  },
}
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  )

const BASE = 'https://abc.supabase.co/storage/v1/object/public/chat-media/account-a/kb'
const row = (name: string, over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  key: name,
  id: name,
  file_name: name,
  mime_type: 'image/png',
  size_bytes: 2048,
  url: `${BASE}/${name}`,
  storage_path: `account-a/kb/${name}`,
  send_with_ai: true,
  status: 'ready',
  inline: true,
  ...over,
})
const img = (name: string) => `<p><img src="${BASE}/${name}" alt=""></p>`

describe('KbAttachments with in-article images', () => {
  it('marks an image shown in the text as "In article" and shows its thumbnail', () => {
    const html = render(<KbAttachments rows={[row('a.png')]} html={img('a.png')} onChange={() => {}} />)
    expect(html).toContain('In article')
    expect(html).not.toContain('Removed from text')
    expect(html).toContain(`<img src="${BASE}/a.png"`)
    expect(html).toContain('Send with AI answers') // the per-file switch still applies
  })

  it('warns when the text no longer shows an inline image (it is removed on save)', () => {
    const html = render(<KbAttachments rows={[row('a.png')]} html="<p>none</p>" onChange={() => {}} />)
    expect(html).toContain('Removed from text')
    expect(html).not.toContain('>In article<')
  })

  it('does not mark an ordinary file', () => {
    const html = render(<KbAttachments rows={[row('b.png', { inline: false })]} html="" onChange={() => {}} />)
    expect(html).not.toContain('In article')
    expect(html).not.toContain('Removed from text')
  })

  it('lists images in the order they appear in the text (the order they are sent), other files after', () => {
    const rows = [
      row('doc.pdf', { inline: false, mime_type: 'application/pdf' }),
      row('one.png'),
      row('two.png'),
    ]
    const html = render(<KbAttachments rows={rows} html={img('two.png') + img('one.png')} onChange={() => {}} />)
    const at = (s: string) => html.indexOf(`title="${s}"`)
    expect(at('two.png')).toBeGreaterThan(-1)
    expect(at('two.png')).toBeLessThan(at('one.png'))
    expect(at('one.png')).toBeLessThan(at('doc.pdf'))
  })

  it('shows the local picture while an image uploads, with the uploading state', () => {
    const html = render(
      <KbAttachments
        rows={[row('up.png', { id: undefined, status: 'uploading', url: '', preview: 'blob:local-1' })]}
        html=""
        onChange={() => {}}
      />,
    )
    expect(html).toContain('blob:local-1')
    expect(html).toContain('Uploading')
    expect(html).not.toContain('Send with AI answers')
  })
})

describe('PastedImageChip', () => {
  const chip = (over: Partial<React.ComponentProps<typeof PastedImageChip>> = {}) =>
    renderToStaticMarkup(
      <PastedImageChip
        src="blob:x"
        label="Pasted image"
        sizeBytes={230 * 1024}
        uploading={false}
        uploadingLabel="Uploading..."
        onRemove={() => {}}
        removeLabel="Remove this pasted image"
        {...over}
      />,
    )

  it('shows a thumbnail, the label, the size and a remove button', () => {
    const html = chip()
    expect(html).toContain('<img src="blob:x"')
    expect(html).toContain('Pasted image')
    expect(html).toContain('>230 KB<')
    expect(html).toContain('aria-label="Remove this pasted image"')
  })

  it('shows the uploading state without a size', () => {
    const html = chip({ uploading: true })
    expect(html).toContain('Uploading...')
    expect(html).not.toContain('>230 KB<')
  })
})
