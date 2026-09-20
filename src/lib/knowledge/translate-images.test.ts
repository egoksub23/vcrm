import { describe, expect, it } from 'vitest'
import { buildTranslatePrompt, parseTranslation } from './translate'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const POLICY = { accountId: ACCOUNT, publicBaseUrl: 'https://abc.supabase.co' }
const url = (n: string) => `https://abc.supabase.co/storage/v1/object/public/chat-media/account-${ACCOUNT}/kb/${n}`
const answer = (html: string) => JSON.stringify({ title: 'Panduan', content_html: html })

describe('parseTranslation with images', () => {
  const options = { images: POLICY, onlyImageUrls: new Set([url('base.png')]) }

  it('keeps the base article\'s image and its translated caption', () => {
    const r = parseTranslation(answer(`<p>Lihat menu.</p><p><img src="${url('base.png')}" alt="Menu Tetapan"></p>`), options)
    expect(r.ok && r.contentHtml).toContain(`<img src="${url('base.png')}" alt="Menu Tetapan">`)
    expect(r.ok && r.content).toBe('Lihat menu.\n\n[image: Menu Tetapan]')
  })

  it('drops an image the model made up or changed, and any foreign one', () => {
    const r = parseTranslation(
      answer(`<p>Hai</p><p><img src="${url('invented.png')}" alt="x"><img src="https://evil.example/a.png"></p>`),
      options,
    )
    expect(r.ok && r.contentHtml).toBe('<p>Hai</p><p></p>')
  })

  it('drops every image when no options are given (the old behaviour)', () => {
    const r = parseTranslation(answer(`<p>Hai</p><p><img src="${url('base.png')}"></p>`))
    expect(r.ok && r.contentHtml).toBe('<p>Hai</p><p></p>')
  })
})

describe('buildTranslatePrompt', () => {
  it('tells the model to leave an image src alone', () => {
    expect(buildTranslatePrompt({ from: 'en', to: 'ms' })).toContain('image src')
  })
})
