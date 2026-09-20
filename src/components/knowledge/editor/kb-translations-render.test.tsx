import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import type { KnowledgeArticle } from '@/lib/knowledge-types'
import { KbInheritedFiles, KbLanguageChip, KbTranslationBanners, KbTranslationsCard } from './kb-translations'

// Server-render smoke tests (the repo has no DOM test library): they pin what
// a person is told and which buttons they are offered in each state.
const messages = {
  Knowledge: {
    translations: {
      title: 'Translations',
      description: 'Translate this article with AI.',
      saveFirst: 'Save the article first.',
      needsSave: 'Save your changes first.',
      notTranslated: 'Not translated yet',
      translate: 'Translate with AI',
      retranslate: 'Re-translate',
      retranslateWithAi: 'Re-translate with AI',
      edit: 'Edit',
      translateAll: 'Translate to all',
      translating: 'Translating',
      statusDraft: 'Draft',
      statusPublished: 'Published',
      machine: 'AI translation',
      edited: 'Edited by hand',
      outOfDate: 'Out of date',
      articleLanguage: 'Article language: {language}',
      bannerMachine: 'AI translation of “{title}”: review it before publishing.',
      bannerOutOfDate: 'The {language} original changed after this was translated.',
      markCurrent: 'Mark up to date',
      viewOriginal: 'View {language}',
      inheritedFiles: 'Files from the original',
      fromBaseFiles: 'These files come from the {language} article.',
      filesReplace: 'The files added here replace the ones from the {language} article.',
    },
  },
}
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  )

const article = (over: Partial<KnowledgeArticle> = {}): KnowledgeArticle => ({
  id: 'base',
  title: 'Refund policy',
  content: 'x',
  content_html: '<p>x</p>',
  kind: 'article',
  language: 'en',
  status: 'published',
  use_in_ai: true,
  category: null,
  collection_id: null,
  review_by: null,
  updated_at: '2026-09-20T10:00:00Z',
  created_by: 'u1',
  source_conversation_id: null,
  source_kind: null,
  source_url: null,
  attachments: [],
  translation_of: null,
  machine_translated: false,
  translated_from_at: null,
  out_of_date: false,
  translations: [],
  base: null,
  inherited_attachments: [],
  ...over,
})

const noop = () => {}

describe('KbTranslationsCard', () => {
  const props = { canTranslate: true, dirty: false, onChanged: noop, onLeave: noop }

  it('is disabled with "Save the article first" for a new article', () => {
    const html = render(<KbTranslationsCard article={null} {...props} />)
    expect(html).toContain('Save the article first.')
    expect(html).not.toContain('Translate with AI')
  })

  it('lists every other language with its state and the right buttons', () => {
    const html = render(
      <KbTranslationsCard
        {...props}
        article={article({
          translations: [{ language: 'ms', id: 'ms1', status: 'draft', out_of_date: true, machine_translated: true }],
        })}
      />,
    )
    expect(html).toContain('Bahasa Melayu')
    expect(html).toContain('中文')
    // Bahasa Melayu exists: chips, Edit link to it, Re-translate; the base language is not listed
    expect(html).toContain('AI translation')
    expect(html).toContain('Out of date')
    expect(html).toContain('href="/knowledge/ms1"')
    expect(html).toContain('Re-translate')
    // Chinese does not exist yet
    expect(html).toContain('Not translated yet')
    expect(html).toContain('Translate with AI')
    expect(html).toContain('Translate to all')
    expect(html).not.toContain('>English<')
  })

  it('shows a read-only member the list but no buttons', () => {
    const html = render(
      <KbTranslationsCard
        {...props}
        canTranslate={false}
        article={article({
          translations: [{ language: 'ms', id: 'ms1', status: 'published', out_of_date: false, machine_translated: false }],
        })}
      />,
    )
    expect(html).toContain('Edited by hand')
    expect(html).toContain('href="/knowledge/ms1"')
    expect(html).not.toContain('Translate with AI')
    expect(html).not.toContain('Re-translate')
    expect(html).not.toContain('Translate to all')
  })

  it('asks to save first and holds the buttons while there are unsaved edits', () => {
    const html = render(<KbTranslationsCard {...props} dirty article={article()} />)
    expect(html).toContain('Save your changes first.')
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b).toContain('disabled')
  })

  it('lists the other languages of a Malay base article', () => {
    const html = render(<KbTranslationsCard {...props} article={article({ language: 'ms' })} />)
    expect(html).toContain('English')
    expect(html).toContain('中文')
    expect(html).not.toContain('>Bahasa Melayu<')
  })
})

describe('KbTranslationBanners', () => {
  const props = { canRetranslate: true, canMarkCurrent: true, dirty: false, onChanged: noop, onLeave: noop }
  const translation = (over: Partial<KnowledgeArticle> = {}) =>
    article({
      id: 'ms1',
      language: 'ms',
      status: 'draft',
      translation_of: 'base',
      machine_translated: true,
      base: { id: 'base', title: 'Refund policy', language: 'en', status: 'published', created_by: 'u1' },
      ...over,
    })

  it('says an AI translation must be reviewed before publishing', () => {
    const html = render(<KbTranslationBanners article={translation()} {...props} />)
    expect(html).toContain('AI translation of “Refund policy”: review it before publishing.')
    expect(html).not.toContain('Mark up to date')
  })

  it('offers Re-translate with AI, Mark up to date and View English when out of date', () => {
    const html = render(<KbTranslationBanners article={translation({ machine_translated: false, out_of_date: true })} {...props} />)
    expect(html).not.toContain('review it before publishing')
    expect(html).toContain('The English original changed after this was translated.')
    expect(html).toContain('Re-translate with AI')
    expect(html).toContain('Mark up to date')
    expect(html).toContain('View English')
    expect(html).toContain('href="/knowledge/base"')
  })

  it('hides the actions someone may not use', () => {
    const html = render(
      <KbTranslationBanners article={translation({ out_of_date: true })} {...props} canRetranslate={false} canMarkCurrent={false} />,
    )
    expect(html).not.toContain('Re-translate with AI')
    expect(html).not.toContain('Mark up to date')
    expect(html).toContain('View English')
  })

  it('shows nothing for an up-to-date, edited translation or a base article', () => {
    expect(render(<KbTranslationBanners article={translation({ machine_translated: false })} {...props} />)).toBe('')
    expect(render(<KbTranslationBanners article={article()} {...props} />)).toBe('')
  })
})

describe('inherited files and the language chip', () => {
  const file = {
    id: 'f1',
    document_id: 'base',
    file_name: 'menu.pdf',
    mime_type: 'application/pdf',
    size_bytes: 2048,
    kind: 'document' as const,
    url: 'https://cdn/menu.pdf',
    storage_path: 'account-a/kb/menu.pdf',
    send_with_ai: true,
    position: 0,
  }

  it('lists the base files read-only with where they come from', () => {
    const html = render(<KbInheritedFiles files={[file]} baseLanguage="en" replaced={false} />)
    expect(html).toContain('menu.pdf')
    expect(html).toContain('These files come from the English article.')
    expect(html).not.toContain('<input')
  })

  it('only notes the replacement once the translation has files of its own', () => {
    const html = render(<KbInheritedFiles files={[file]} baseLanguage="en" replaced />)
    expect(html).toContain('replace the ones from the English article')
    expect(html).not.toContain('menu.pdf')
  })

  it('renders nothing without inherited files', () => {
    expect(render(<KbInheritedFiles files={[]} baseLanguage="en" replaced={false} />)).toBe('')
  })

  it('shows the article language next to the title', () => {
    expect(render(<KbLanguageChip language="ms" />)).toContain('Bahasa Melayu')
  })
})
