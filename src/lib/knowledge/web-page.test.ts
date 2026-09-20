import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ deliverable: vi.fn() }))
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: h.deliverable }))

import {
  PageFetchError,
  checksumOf,
  extractReadablePage,
  fetchWebPage,
  fitPageToArticle,
  parsePageUrl,
} from './web-page'
import { MAX_CONTENT_CHARS } from '@/lib/ai/knowledge-doc'

const PAGE = `<!DOCTYPE html><html><head><title>Opening hours &amp; contact</title><script>var x=1</script><style>p{}</style></head>
<body>
<header><a href="/">Home</a> Site header</header>
<nav><ul><li><a href="/a">Menu A</a></li><li><a href="/b">Menu B</a></li></ul></nav>
<main>
  <h1>Opening hours</h1>
  <p>We are open <strong>Monday to Friday</strong>, 9am to 6pm. See <a href="/contact">contact us</a> or <a href="https://other.com/x">other</a>.</p>
  <ul><li>Closed on public holidays</li></ul>
  <form><input name="q"><button>Search</button></form>
</main>
<aside>Related posts</aside>
<footer>Copyright 2026</footer>
<script>alert(1)</script>
</body></html>`

describe('extractReadablePage', () => {
  it('keeps the main content and drops menus, footers, forms and scripts', () => {
    const page = extractReadablePage(PAGE, 'https://shop.example.com/hours')!
    expect(page.title).toBe('Opening hours & contact')
    expect(page.text).toContain('Opening hours')
    expect(page.text).toContain('We are open Monday to Friday, 9am to 6pm.')
    expect(page.text).toContain('- Closed on public holidays')
    for (const junk of ['Menu A', 'Copyright', 'Related posts', 'Search', 'alert', 'Site header', 'var x']) {
      expect(page.text).not.toContain(junk)
    }
    expect(page.html).not.toContain('<script')
  })

  it('turns relative links into absolute ones', () => {
    const page = extractReadablePage(PAGE, 'https://shop.example.com/pages/hours')!
    expect(page.html).toContain('href="https://shop.example.com/contact"')
    expect(page.html).toContain('href="https://other.com/x"')
    expect(page.text).toContain('contact us (https://shop.example.com/contact)')
  })

  it('falls back to the largest article, then the body', () => {
    const article = '<html><body><div>ignore this sidebar text that is long enough to count</div><article><h1>Story</h1><p>The real story text that is long enough to count as content.</p></article></body></html>'
    const p1 = extractReadablePage(article, 'https://a.com/s')!
    expect(p1.text).toContain('The real story text')
    expect(p1.text).not.toContain('sidebar')
    const body = '<html><body><nav>Nav</nav><p>Plain body content that is long enough to be counted as text.</p></body></html>'
    const p2 = extractReadablePage(body, 'https://a.com/s')!
    expect(p2.text).toBe('Plain body content that is long enough to be counted as text.')
  })

  it('takes the title from the first heading, then the host, when there is no <title>', () => {
    const noTitle = '<body><h1>Returns policy</h1><p>You may return goods within fourteen days of delivery.</p></body>'
    expect(extractReadablePage(noTitle, 'https://a.com/r')!.title).toBe('Returns policy')
    const bare = '<body><p>You may return goods within fourteen days of delivery, unopened.</p></body>'
    expect(extractReadablePage(bare, 'https://a.com/r')!.title).toBe('a.com')
  })

  it('returns null for a page with no readable text (a JavaScript shell)', () => {
    expect(extractReadablePage('<html><body><div id="app"></div><script src="/app.js"></script></body></html>', 'https://a.com')).toBeNull()
  })

  it('never returns script content or unsafe links', () => {
    const evil =
      '<body><p>Hello there, this is a page with enough text to be counted as content.</p><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)></body>'
    const page = extractReadablePage(evil, 'https://a.com')!
    expect(page.html).not.toMatch(/javascript:|onerror|<img/)
  })

  it('stays fast on hostile nesting and unclosed tags', () => {
    const started = Date.now()
    const nasty = '<nav '.repeat(60000) + '<p>x</p>' + '<div>'.repeat(20000)
    extractReadablePage(nasty, 'https://a.com')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('fitPageToArticle', () => {
  it('leaves a page that fits alone', () => {
    const page = { title: 'T', html: '<p>short</p>', text: 'short' }
    expect(fitPageToArticle(page)).toEqual({ ...page, truncated: false })
  })

  it('cuts a long page at a block boundary and says so', () => {
    const para = '<p>' + 'word '.repeat(400) + '</p>'
    const html = para.repeat(30)
    const text = html.replace(/<[^>]*>/g, '')
    const fit = fitPageToArticle({ title: 'T', html, text })
    expect(fit.truncated).toBe(true)
    expect(fit.text.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS)
    expect(fit.text.length).toBeGreaterThan(1000)
    expect(fit.html.startsWith('<p>')).toBe(true)
  })
})

describe('checksumOf', () => {
  it('is stable and sensitive to changes', () => {
    expect(checksumOf('a')).toBe(checksumOf('a'))
    expect(checksumOf('a')).not.toBe(checksumOf('b'))
    expect(checksumOf('a')).toHaveLength(64)
  })
})

describe('parsePageUrl', () => {
  it('accepts http(s), strips the fragment and refuses everything else', () => {
    expect(parsePageUrl(' https://a.com/x#top ').toString()).toBe('https://a.com/x')
    for (const bad of ['ftp://a.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'https://user:pw@a.com/', '']) {
      expect(() => parsePageUrl(bad), bad).toThrow(PageFetchError)
    }
  })
})

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })
}

describe('fetchWebPage', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    h.deliverable.mockReset()
    h.deliverable.mockResolvedValue(true)
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('fetches a public page', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(html('<p>hello</p>')) as unknown as typeof fetch
    expect(await fetchWebPage('https://a.com/x')).toEqual({ url: 'https://a.com/x', html: '<p>hello</p>' })
    expect(h.deliverable).toHaveBeenCalledWith('https://a.com/x')
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('refuses an address the SSRF guard rejects, without fetching', async () => {
    h.deliverable.mockResolvedValue(false)
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(fetchWebPage('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ status: 400 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('checks every redirect hop against the guard', async () => {
    h.deliverable.mockImplementation(async (u: string) => !u.includes('internal'))
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://internal.local/admin' } })) as unknown as typeof fetch
    await expect(fetchWebPage('https://a.com/x')).rejects.toBeInstanceOf(PageFetchError)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect to a public page and reports the final URL', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/new' } }))
      .mockResolvedValueOnce(html('<p>new</p>')) as unknown as typeof fetch
    expect(await fetchWebPage('https://a.com/old')).toEqual({ url: 'https://a.com/new', html: '<p>new</p>' })
  })

  it('gives up after too many redirects', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/loop' } })) as unknown as typeof fetch
    await expect(fetchWebPage('https://a.com/loop')).rejects.toThrow(/too many times/)
  })

  it('rejects error statuses, files and oversized pages with a readable message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(html('nope', { status: 404 })) as unknown as typeof fetch
    await expect(fetchWebPage('https://a.com/x')).rejects.toThrow(/error \(404\)/)

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    ) as unknown as typeof fetch
    await expect(fetchWebPage('https://a.com/x.pdf')).rejects.toMatchObject({ status: 415 })

    globalThis.fetch = vi.fn().mockResolvedValue(html('x'.repeat(2 * 1024 * 1024 + 10))) as unknown as typeof fetch
    await expect(fetchWebPage('https://a.com/big')).rejects.toMatchObject({ status: 413 })
  })

  it('turns a network failure into a readable error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch
    await expect(fetchWebPage('https://a.com/x')).rejects.toThrow(/could not be reached/)
  })

  it('decodes the declared charset', async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]) // "café" in latin1
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }),
    ) as unknown as typeof fetch
    expect((await fetchWebPage('https://a.com/x')).html).toBe('café')
  })
})
