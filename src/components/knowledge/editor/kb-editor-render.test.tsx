import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'

import { KbAttachments } from './kb-attachments'
import { KbTestBox } from './kb-test-box'

// Server-render smoke tests (the repo has no DOM test library): they pin the
// states a writer must be told about, not the styling.
const messages = {
  Knowledge: {
    editor: {
      testTitle: 'Test it: would the AI find this?',
      testUnsavedNew: 'Save this article first.',
      testUnsavedEdits: 'You have unsaved edits.',
      testNotPublished: 'This article is a draft.',
      testAgentsOnly: 'This article is set to agents only.',
      attachments: 'Attachments',
      sendWithAi: 'Send with AI answers',
    },
  },
}
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  )

describe('KbTestBox', () => {
  const base = { articleId: 'a1', status: 'published' as const, useInAi: true, dirty: false, language: 'en' as const }
  it('says a new article is not indexed yet', () => {
    expect(render(<KbTestBox {...base} articleId={null} />)).toContain('Save this article first.')
  })
  it('warns that unsaved edits are not part of the result', () => {
    expect(render(<KbTestBox {...base} dirty />)).toContain('You have unsaved edits.')
  })
  it('explains why a draft or agents-only article will not show up', () => {
    expect(render(<KbTestBox {...base} status="draft" />)).toContain('This article is a draft.')
    expect(render(<KbTestBox {...base} useInAi={false} />)).toContain('This article is set to agents only.')
  })
  it('shows no warning for a saved, published, AI-enabled article', () => {
    const html = render(<KbTestBox {...base} />)
    expect(html).not.toContain('Save this article first.')
    expect(html).not.toContain('unsaved edits')
  })
})

describe('KbAttachments', () => {
  const file = {
    key: '1',
    id: '1',
    file_name: 'deck.pptx',
    mime_type: '',
    size_bytes: 2048,
    url: 'https://x/deck.pptx',
    storage_path: 'account-a/kb/1-deck.pptx',
    send_with_ai: true,
    status: 'ready' as const,
  }
  it('lists a file with its size and the per-file AI switch', () => {
    const html = render(<KbAttachments rows={[file]} html="" onChange={() => {}} />)
    expect(html).toContain('deck.pptx')
    expect(html).toContain('2 KB')
    expect(html).toContain('Send with AI answers')
  })
  it('shows the error of a failed upload instead of the switch', () => {
    const html = render(
      <KbAttachments rows={[{ ...file, status: 'error', error: 'mime type not supported' }]} html="" onChange={() => {}} />,
    )
    expect(html).toContain('mime type not supported')
    expect(html).not.toContain('Send with AI answers')
  })
})
