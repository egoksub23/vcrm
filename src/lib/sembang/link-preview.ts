// ============================================================
// Sembang link unfurling — turns the first URL in a message body into
// a title/description/image preview card.
//
// The fetch itself is the Knowledge Base page-importer's own
// fetchWebPage() (src/lib/knowledge/web-page.ts): SSRF-guarded via
// src/lib/webhooks/ssrf.ts's isDeliverableUrl(), manual redirect
// following (each hop re-checked), time- and size-capped, HTML-only.
// Nothing here re-implements that — this module only adds the
// OpenGraph/meta-tag extraction on top, which the page importer never
// needed (it reads a page's body, not its <head>).
// ============================================================
import { fetchWebPage, PageFetchError } from '@/lib/knowledge/web-page'
import { decodeEntities } from '@/lib/knowledge-format'

const TITLE_MAX = 300
const DESCRIPTION_MAX = 500
/** Meta tags always live in <head>, near the top of the document — bound
 *  the scan so a huge or hostile page can't make this slow. */
const HEAD_SCAN_CHARS = 100_000

export interface LinkPreviewMeta {
  url: string
  title: string | null
  description: string | null
  imageUrl: string | null
  domain: string
}

function metaTags(head: string): string[] {
  const out: string[] = []
  for (const m of head.matchAll(/<meta\b[^>]{0,500}>/gi)) out.push(m[0])
  return out
}

function attrValue(tag: string, attr: string): string | null {
  const m = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  if (!m) return null
  const raw = (m[2] ?? m[3] ?? '').trim()
  return raw ? decodeEntities(raw) : null
}

/** First matching `<meta property="…">`/`<meta name="…">` tag's `content`,
 *  trying each candidate key in order (e.g. og:title before twitter:title). */
function metaContent(head: string, keys: string[]): string | null {
  const wanted = new Set(keys.map((k) => k.toLowerCase()))
  for (const tag of metaTags(head)) {
    const key = (attrValue(tag, 'property') ?? attrValue(tag, 'name'))?.toLowerCase()
    if (key && wanted.has(key)) {
      const content = attrValue(tag, 'content')
      if (content) return content
    }
  }
  return null
}

function absoluteUrl(value: string, base: string): string | null {
  try {
    return new URL(value, base).toString()
  } catch {
    return null
  }
}

/** Best-effort OpenGraph/meta extraction from a page's <head>. Pure and
 *  never throws — a page with none of these tags just yields null fields. */
export function extractLinkPreviewMeta(html: string, pageUrl: string): LinkPreviewMeta {
  const headEnd = html.search(/<\/head/i)
  const head = html.slice(0, headEnd >= 0 ? headEnd : Math.min(html.length, HEAD_SCAN_CHARS))

  let title = metaContent(head, ['og:title', 'twitter:title'])
  if (!title) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
    if (m) title = decodeEntities(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
  }

  const description = metaContent(head, ['og:description', 'twitter:description', 'description'])
  const image = metaContent(head, ['og:image', 'og:image:url', 'twitter:image'])

  let domain: string
  try {
    domain = new URL(pageUrl).hostname
  } catch {
    domain = pageUrl
  }

  return {
    url: pageUrl,
    title: title ? title.slice(0, TITLE_MAX) : null,
    description: description ? description.slice(0, DESCRIPTION_MAX) : null,
    imageUrl: image ? absoluteUrl(image, pageUrl) : null,
    domain,
  }
}

/** Fetches `url` and extracts a link-preview card's worth of metadata.
 *  Never throws and resolves to `null` for anything that isn't worth
 *  showing a card for: unreachable/private/non-HTML/too-large addresses
 *  (all handled by fetchWebPage's own SSRF/size/type guards), or a page
 *  with neither an OpenGraph title nor a <title> tag. Meant to be called
 *  best-effort, after a message has already been sent — a slow or failed
 *  fetch here must never block or fail the send itself. */
export async function fetchLinkPreview(url: string): Promise<LinkPreviewMeta | null> {
  try {
    const { url: finalUrl, html } = await fetchWebPage(url)
    const meta = extractLinkPreviewMeta(html, finalUrl)
    return meta.title ? meta : null
  } catch (err) {
    if (err instanceof PageFetchError) return null
    return null
  }
}
