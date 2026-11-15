// ============================================================
// /api/sembang/link-preview?url=<encoded>
//
// Client-side "preview before you send" endpoint. Returns OG metadata
// for any external http(s) URL — the same data the POST /messages route
// saves into sembang_link_previews after a send, but on-demand so the
// composer can show a card before the message is submitted.
//
// Security:
//   - Rejects non-http(s) schemes and private / loopback / link-local
//     addresses with 400 (early, before any outbound fetch). The
//     actual fetch uses fetchLinkPreview → fetchWebPage, which repeats
//     the SSRF guard on each hop via pinnedFetch and isDeliverableUrl.
//   - Never returns 5xx; every error becomes {} so the client can treat
//     a failed preview as "nothing to show" rather than a hard error.
//
// Cache: a module-level Map keeps the last 500 results for 24 h so
// pasting the same URL twice in one day costs at most one outbound fetch.
// The map evicts the oldest entry when it hits 500 (simple FIFO — close
// enough for a small process-local preview cache).
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { extractLinkPreviewMeta } from '@/lib/sembang/link-preview'
import { fetchWebPage } from '@/lib/knowledge/web-page'

// ---- in-process cache -------------------------------------------------------

const CACHE_MAX = 500
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 h

interface CacheEntry {
  data: LinkPreviewResult
  fetchedAt: number
}

/** Module-level Map so it survives across requests in the same process. */
const previewCache = new Map<string, CacheEntry>()

function cacheGet(url: string): LinkPreviewResult | null {
  const entry = previewCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    previewCache.delete(url)
    return null
  }
  return entry.data
}

function cacheSet(url: string, data: LinkPreviewResult): void {
  if (previewCache.size >= CACHE_MAX) {
    // Evict oldest entry — Map iteration order is insertion order.
    const oldest = previewCache.keys().next().value
    if (oldest) previewCache.delete(oldest)
  }
  previewCache.set(url, { data, fetchedAt: Date.now() })
}

// ---- response shape ---------------------------------------------------------

interface LinkPreviewResult {
  url?: string
  title?: string | null
  description?: string | null
  image?: string | null
  siteName?: string | null
  domain?: string | null
}

// ---- og:site_name extraction ------------------------------------------------
// extractLinkPreviewMeta doesn't return siteName; extract it here on-the-fly.

function extractSiteName(html: string): string | null {
  // Scan only the <head> region to stay fast on large pages.
  const headEnd = html.search(/<\/head/i)
  const head = html.slice(0, headEnd >= 0 ? headEnd : Math.min(html.length, 100_000))
  for (const m of head.matchAll(/<meta\b[^>]{0,500}>/gi)) {
    const tag = m[0]
    const propM = /\bproperty\s*=\s*["']([^"']*)["']/i.exec(tag)
    const nameM = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)
    const key = (propM?.[1] ?? nameM?.[1] ?? '').toLowerCase()
    if (key !== 'og:site_name') continue
    const contentM = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
    if (contentM) return (contentM[2] ?? contentM[3] ?? '').trim() || null
  }
  return null
}

// ---- URL validation ---------------------------------------------------------

/** Returns a normalised URL string, or a string error message on failure. */
function validateUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { error: 'Not a valid URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http and https URLs are supported' }
  }
  // Reject obvious private/loopback targets at the hostname level before
  // making any outbound connection. fetchWebPage's SSRF guard will also
  // block at the socket level, but rejecting here gives a clean 400.
  const host = parsed.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    // IPv4 private ranges as literals
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    // Link-local
    /^169\.254\./.test(host) ||
    // IPv6 ULA / link-local
    /^(fc|fd|fe80)/i.test(host)
  ) {
    return { error: 'Private or localhost URLs are not allowed' }
  }
  // Strip the fragment — it isn't sent to servers and would pollute cache keys.
  parsed.hash = ''
  return { url: parsed.toString() }
}

// ---- route ------------------------------------------------------------------

export async function GET(request: Request) {
  try {
    await requireCapability('menu.sembang')

    const { searchParams } = new URL(request.url)
    const rawUrl = searchParams.get('url') ?? ''

    if (!rawUrl) {
      return NextResponse.json({ error: 'url parameter is required' }, { status: 400 })
    }

    const validated = validateUrl(rawUrl)
    if ('error' in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 })
    }
    const url = validated.url

    // --- cache hit ---
    const cached = cacheGet(url)
    if (cached) return NextResponse.json(cached)

    // --- fetch & extract ---
    let result: LinkPreviewResult = {}
    try {
      const { url: finalUrl, html } = await fetchWebPage(url)
      const meta = extractLinkPreviewMeta(html, finalUrl)
      const siteName = extractSiteName(html)
      if (meta.title) {
        result = {
          url: meta.url,
          title: meta.title,
          description: meta.description,
          image: meta.imageUrl,
          siteName,
          domain: meta.domain,
        }
      }
    } catch {
      // Unreachable, SSRF-blocked, non-HTML, too large, ... → {}
    }

    cacheSet(url, result)
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
