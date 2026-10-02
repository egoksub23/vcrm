// ============================================================
// Signed links for chat media (the chat-media bucket is private).
//
// A message's stored `media_url` is only an identifier now; to show the file
// the widget needs a short-lived link from POST /api/widget/media-url. Pure
// logic lives here (no DOM, no Supabase client) so it is unit-tested without
// the bundle: api.ts wires the resolver to the real endpoint, App.tsx feeds
// the message list through it.
// ============================================================
import type { WidgetMessage } from './types'

/**
 * How long a link from the server lives: VIEW_URL_TTL_SECONDS (4 hours) in
 * src/lib/storage/media-urls.ts. The widget is a separate bundle and cannot
 * import server code, so the number is repeated here; keep them in step.
 */
const SERVER_LINK_TTL_MS = 4 * 60 * 60 * 1000
/** Held links are dropped this long before the server's would expire. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
export const MEDIA_LINK_TTL_MS = SERVER_LINK_TTL_MS - EXPIRY_MARGIN_MS
/** After a link could not be had for a file, leave it alone this long before asking again. */
export const MEDIA_FAILURE_BACKOFF_MS = 60 * 1000
/** The server answers at most this many urls per request. */
export const MEDIA_URLS_PER_REQUEST = 25
/** How long the first paint of a list waits for links before showing rows without them. */
export const MEDIA_RESOLVE_WAIT_MS = 5000

/** Bucket whose files need a signed link (the server decides; this only skips needless calls). */
const PRIVATE_MEDIA_URL = /\/storage\/v1\/object\/public\/chat-media\//

/** True for a stored url that must be exchanged for a signed link before it can be fetched. */
export function isPrivateMediaUrl(url: string | null | undefined): url is string {
  return !!url && PRIVATE_MEDIA_URL.test(url)
}

/** The stored url a message's media came from (the raw one, even once it shows a signed link). */
export function rawMediaUrlOf(m: Pick<WidgetMessage, 'media_url' | 'rawMediaUrl'>): string | null {
  const raw = m.rawMediaUrl ?? m.media_url
  return isPrivateMediaUrl(raw) ? raw : null
}

export type FetchMediaLinks = (conversationId: string, urls: string[]) => Promise<Record<string, string>>

export interface MediaLinkResolver {
  /**
   * Links for `urls` (keyed by the stored url). Cached ones come back without a
   * request; the rest are fetched in batches. Never rejects: a url that could
   * not be linked is simply absent from the map.
   */
  resolve(conversationId: string, urls: readonly string[]): Promise<Map<string, string>>
  /** The cached, still-fresh link for a stored url, if any. */
  peek(url: string): string | null
}

export function createMediaLinkResolver(
  fetchLinks: FetchMediaLinks,
  opts: { now?: () => number; ttlMs?: number; failureBackoffMs?: number } = {},
): MediaLinkResolver {
  const now = opts.now ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? MEDIA_LINK_TTL_MS
  const backoffMs = opts.failureBackoffMs ?? MEDIA_FAILURE_BACKOFF_MS
  const cache = new Map<string, { link: string; expiresAt: number }>()
  const failedUntil = new Map<string, number>()
  const inflight = new Map<string, Promise<void>>()

  const peek = (url: string): string | null => {
    const hit = cache.get(url)
    if (!hit) return null
    if (hit.expiresAt <= now()) {
      cache.delete(url)
      return null
    }
    return hit.link
  }

  const fetchBatch = async (conversationId: string, batch: string[]): Promise<void> => {
    await null // the caller registers this batch as in flight before anything below can finish
    try {
      const links = await fetchLinks(conversationId, batch)
      for (const url of batch) {
        const link = links?.[url]
        if (typeof link === 'string' && /^https?:\/\//i.test(link)) {
          cache.set(url, { link, expiresAt: now() + ttlMs })
          failedUntil.delete(url)
        } else {
          failedUntil.set(url, now() + backoffMs)
        }
      }
    } catch {
      for (const url of batch) failedUntil.set(url, now() + backoffMs)
    } finally {
      for (const url of batch) inflight.delete(url)
    }
  }

  return {
    peek,
    async resolve(conversationId, urls) {
      const wait: Promise<void>[] = []
      const toFetch: string[] = []
      for (const url of new Set(urls)) {
        if (peek(url) !== null) continue
        if ((failedUntil.get(url) ?? 0) > now()) continue
        const flying = inflight.get(url)
        if (flying) wait.push(flying)
        else toFetch.push(url)
      }
      for (let i = 0; i < toFetch.length; i += MEDIA_URLS_PER_REQUEST) {
        const batch = toFetch.slice(i, i + MEDIA_URLS_PER_REQUEST)
        const p = fetchBatch(conversationId, batch)
        for (const url of batch) inflight.set(url, p)
        wait.push(p)
      }
      await Promise.all(wait)
      const out = new Map<string, string>()
      for (const url of urls) {
        const link = peek(url)
        if (link !== null) out.set(url, link)
      }
      return out
    },
  }
}

/**
 * Swap each message's `media_url` for its signed link, remembering the stored url
 * in `rawMediaUrl`. A message with no link (not a private file, or one the server
 * would not sign) is left exactly as it is, so it still renders. Returns the same
 * array when nothing changed (no re-render for nothing).
 */
export function applyMediaLinks<T extends WidgetMessage>(messages: T[], links: ReadonlyMap<string, string>): T[] {
  let changed = false
  const out = messages.map((m) => {
    const raw = rawMediaUrlOf(m)
    if (!raw) return m
    const link = links.get(raw)
    if (!link || (m.media_url === link && m.rawMediaUrl === raw)) return m
    changed = true
    return { ...m, media_url: link, rawMediaUrl: raw }
  })
  return changed ? out : messages
}

/** Distinct stored urls among `messages` that need a link. */
export function mediaUrlsToResolve(messages: readonly WidgetMessage[]): string[] {
  const urls = new Set<string>()
  for (const m of messages) {
    const raw = rawMediaUrlOf(m)
    if (raw) urls.add(raw)
  }
  return [...urls]
}

/**
 * `messages` with their media links resolved. Never throws and never waits longer
 * than `waitMs` (a slow or failing link service must not hold back the text of a
 * conversation): rows that missed the window come back with their stored url, and
 * a later pass (`applyMediaLinks` with the same resolver) picks the links up once
 * they have arrived.
 */
export async function resolveMessageMedia<T extends WidgetMessage>(
  conversationId: string,
  messages: T[],
  resolver: MediaLinkResolver,
  waitMs: number = MEDIA_RESOLVE_WAIT_MS,
): Promise<T[]> {
  const urls = mediaUrlsToResolve(messages)
  if (urls.length === 0) return messages
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const links = await Promise.race([
      resolver.resolve(conversationId, urls),
      new Promise<Map<string, string>>((resolve) => {
        timer = setTimeout(() => resolve(new Map()), waitMs)
      }),
    ])
    return applyMediaLinks(messages, links)
  } catch {
    return messages
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
