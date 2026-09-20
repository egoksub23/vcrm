import { createHash } from 'node:crypto'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { decodeEntities, kbHtmlToPlainText, plainTextToKbHtml, sanitizeKbHtml, splitKbHtml } from '@/lib/knowledge-format'
import { MAX_CONTENT_CHARS, MAX_TITLE_CHARS } from '@/lib/ai/knowledge-doc'

// ============================================================
// Import a web page as a draft article, and re-sync it later.
//
// Fetching goes through the same SSRF guard the webhooks use, follows
// redirects by hand (every hop is checked again), and is capped in time and
// size. Reading the page keeps its main content and drops menus, footers,
// scripts and forms.
// ============================================================

export const MAX_PAGE_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 4
/** Reading a page is bounded: anything past this is ignored. */
const MAX_HTML_CHARS = 500_000
const MIN_TEXT_CHARS = 40

export class PageFetchError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'PageFetchError'
    this.status = status
  }
}

/** Only http(s) pages, no embedded credentials. Returns the normalised URL. */
export function parsePageUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new PageFetchError('That is not a valid web address.', 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PageFetchError('Only http and https addresses can be imported.', 400)
  }
  if (url.username || url.password) {
    throw new PageFetchError('Addresses with a username or password are not supported.', 400)
  }
  url.hash = ''
  return url
}

function charsetOf(contentType: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType)
  return m ? m[1].toLowerCase() : 'utf-8'
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_PAGE_BYTES)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new PageFetchError('That page is too large to import (over 2 MB).', 413)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Fetch a page's HTML, safely. Throws PageFetchError with a message fit to show. */
export async function fetchWebPage(rawUrl: string): Promise<{ url: string; html: string }> {
  let url = parsePageUrl(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isDeliverableUrl(url.toString()))) {
      throw new PageFetchError('That address cannot be reached from here. Use a public web page.', 400)
    }
    let res: Response
    try {
      res = await fetch(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; KnowledgeBaseImport/1.0)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
        },
      })
    } catch {
      throw new PageFetchError('The page did not respond in time, or could not be reached.', 502)
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new PageFetchError('The page redirected without saying where.', 502)
      url = parsePageUrl(new URL(location, url).toString())
      continue
    }
    if (!res.ok) throw new PageFetchError(`The page answered with an error (${res.status}).`, 502)

    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (type && !/(text\/html|application\/xhtml|text\/plain)/.test(type)) {
      throw new PageFetchError('That address is not a web page (it is a file or an image). Upload files with "Upload a file".', 415)
    }
    const bytes = await readCapped(res)
    let html: string
    try {
      html = new TextDecoder(charsetOf(type)).decode(bytes)
    } catch {
      html = new TextDecoder('utf-8').decode(bytes)
    }
    return { url: url.toString(), html }
  }
  throw new PageFetchError('The page redirected too many times.', 502)
}

// ------------------------------------------------------------
// Reading a page
// ------------------------------------------------------------
interface Block {
  start: number
  end: number
  inner: string
}

/**
 * The top-level `<tag>...</tag>` blocks of a page, found in one pass (nested
 * copies of the same tag are counted, not matched separately; an unclosed tag
 * runs to the end, as in a browser). Linear in the input and with a bounded
 * attribute length, so a hostile page cannot make it slow.
 */
function blocksOf(html: string, tag: string): Block[] {
  const re = new RegExp(`<(/?)${tag}\\b[^>]{0,1000}>`, 'gi')
  const out: Block[] = []
  let depth = 0
  let start = -1
  let innerStart = -1
  for (const m of html.matchAll(re)) {
    const at = m.index ?? 0
    if (m[1] === '') {
      if (depth === 0) {
        start = at
        innerStart = at + m[0].length
      }
      depth++
    } else if (depth > 0) {
      depth--
      if (depth === 0) out.push({ start, end: at + m[0].length, inner: html.slice(innerStart, at) })
    }
  }
  if (depth > 0 && start >= 0) out.push({ start, end: html.length, inner: html.slice(innerStart) })
  return out
}

function removeBlocks(html: string, tags: string[]): string {
  let out = html
  for (const tag of tags) {
    let cursor = 0
    let next = ''
    for (const b of blocksOf(out, tag)) {
      next += out.slice(cursor, b.start) + ' '
      cursor = b.end
    }
    out = next + out.slice(cursor)
  }
  return out
}

function firstBlock(html: string, tag: string): string | null {
  return blocksOf(html, tag)[0]?.inner ?? null
}

function largestBlock(html: string, tag: string): string | null {
  let best: string | null = null
  for (const b of blocksOf(html, tag)) if (!best || b.inner.length > best.length) best = b.inner
  return best
}

function absolutiseLinks(html: string, base: string): string {
  return html.replace(/(\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi, (whole, prefix: string, quoted: string, dq?: string, sq?: string) => {
    const value = decodeEntities(dq ?? sq ?? '').trim()
    if (!value || value.startsWith('#')) return whole
    try {
      const abs = new URL(value, base).toString()
      return `${prefix}"${abs.replace(/"/g, '%22')}"`
    } catch {
      return whole
    }
  })
}

export interface ReadablePage {
  title: string
  /** Sanitised rich text of the page's main content. */
  html: string
  /** The same as plain text. */
  text: string
}

/** The title and main content of an HTML page, or null when there is no
 *  readable text (an empty shell that needs JavaScript, say). */
export function extractReadablePage(rawHtml: string, pageUrl: string): ReadablePage | null {
  const source = rawHtml.slice(0, MAX_HTML_CHARS)

  let title = ''
  const titleTag = firstBlock(source, 'title')
  if (titleTag) title = decodeEntities(titleTag.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

  const withoutHead = removeBlocks(source, ['head', 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form'])
  const main = firstBlock(withoutHead, 'main') ?? largestBlock(withoutHead, 'article')
  let region = main ?? firstBlock(withoutHead, 'body') ?? withoutHead
  // Page furniture: menus, footers and side columns. A site <header> is only
  // dropped when there is no <main>/<article> to anchor on (inside an article
  // the header usually carries the real title).
  region = removeBlocks(region, main ? ['nav', 'footer', 'aside'] : ['nav', 'footer', 'aside', 'header'])

  const html = sanitizeKbHtml(absolutiseLinks(region, pageUrl))
  const text = kbHtmlToPlainText(html)
  if (text.length < MIN_TEXT_CHARS) return null

  if (!title) {
    const h = /<h2>([\s\S]*?)<\/h2>/.exec(html)
    title = h ? kbHtmlToPlainText(`<p>${h[1]}</p>`) : ''
  }
  if (!title) {
    try {
      title = new URL(pageUrl).hostname
    } catch {
      title = 'Imported page'
    }
  }
  return { title: title.slice(0, MAX_TITLE_CHARS), html, text }
}

/** A page must fit one article; text beyond the limit is cut at a block
 *  boundary. `truncated` tells the caller so it can say so. */
export function fitPageToArticle(page: ReadablePage): ReadablePage & { truncated: boolean } {
  if (page.text.length <= MAX_CONTENT_CHARS) return { ...page, truncated: false }
  const [first] = splitKbHtml(page.html, Math.floor(MAX_CONTENT_CHARS * 0.9))
  const html = first ?? ''
  const text = kbHtmlToPlainText(html)
  // One block longer than an article (rare): keep its start as plain text.
  if (text.length > MAX_CONTENT_CHARS) {
    const cut = text.slice(0, MAX_CONTENT_CHARS)
    return { title: page.title, html: plainTextToKbHtml(cut), text: cut, truncated: true }
  }
  return { title: page.title, html, text, truncated: true }
}

/** Stable fingerprint of a page's text, to tell a re-sync "nothing changed". */
export function checksumOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
