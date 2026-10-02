// ============================================================
// Browser side: a link someone signed in can fetch for a stored
// private-media URL.
//
// The dashboard asks Storage directly. The read policy on `chat-media`
// (migration 130) lets a signed-in person list and sign objects in their
// own workspace's folder only, so a URL for another workspace's file simply
// fails to sign. Links are cached until shortly before they expire, asked
// for together when several arrive in the same tick (a thread of images),
// and shared by every component that shows the same file.
//
// Not for the chat widget: a visitor is not a member of the workspace, so
// the widget gets its links from the server (/api/widget/media-url).
// ============================================================

import { createClient } from '@/lib/supabase/client'
import {
  PRIVATE_MEDIA_BUCKET,
  VIEW_URL_TTL_SECONDS,
  privateMediaPath,
} from '@/lib/storage/media-urls'

/** Re-sign when a cached link has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

interface Entry {
  url: string
  expiresAt: number
}

type Signer = (paths: string[], ttlSeconds: number) => Promise<Map<string, string>>

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<string>>()
let queue: { path: string; resolve: (url: string) => void; reject: (err: Error) => void }[] = []
let scheduled = false
let signer: Signer = defaultSigner

async function defaultSigner(paths: string[], ttlSeconds: number): Promise<Map<string, string>> {
  const { data, error } = await createClient().storage.from(PRIVATE_MEDIA_BUCKET).createSignedUrls(paths, ttlSeconds)
  if (error) throw new Error(error.message)
  const out = new Map<string, string>()
  for (const row of data ?? []) {
    if (row.path && row.signedUrl && !row.error) out.set(row.path, row.signedUrl)
  }
  return out
}

async function flush(): Promise<void> {
  scheduled = false
  const batch = queue
  queue = []
  if (batch.length === 0) return
  const paths = [...new Set(batch.map((b) => b.path))]
  let signed: Map<string, string>
  try {
    signed = await signer(paths, VIEW_URL_TTL_SECONDS)
  } catch (err) {
    for (const b of batch) b.reject(err instanceof Error ? err : new Error('Could not sign the file link'))
    return
  }
  const expiresAt = Date.now() + VIEW_URL_TTL_SECONDS * 1000
  for (const b of batch) {
    const url = signed.get(b.path)
    if (!url) {
      b.reject(new Error('That file is not available'))
      continue
    }
    cache.set(b.path, { url, expiresAt })
    b.resolve(url)
  }
}

function enqueue(path: string): Promise<string> {
  const pending = inflight.get(path)
  if (pending) return pending
  const p = new Promise<string>((resolve, reject) => {
    queue.push({ path, resolve, reject })
    if (!scheduled) {
      scheduled = true
      queueMicrotask(() => void flush())
    }
  }).finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}

/** A link already signed and still good, or null. Lets a component paint without waiting. */
export function cachedSignedUrl(url: string | null | undefined): string | null {
  const path = privateMediaPath(url)
  if (path === null) return null
  const hit = cache.get(path)
  return hit && hit.expiresAt - Date.now() > REFRESH_MARGIN_MS ? hit.url : null
}

/**
 * A fetchable link for a stored media URL. A private-bucket URL is signed (or
 * served from the cache); any other URL is returned as it is. Rejects when the
 * file cannot be signed (not yours, deleted).
 */
export async function signedMediaUrl(url: string): Promise<string> {
  const path = privateMediaPath(url)
  if (path === null) return url
  const hit = cachedSignedUrl(url)
  if (hit) return hit
  return enqueue(path)
}

/** Forget every cached link (sign-out, or a test). */
export function clearSignedUrlCache(): void {
  cache.clear()
}

/** Test hook: swap the function that talks to Storage. */
export function setSignerForTests(next: Signer | null): void {
  signer = next ?? defaultSigner
  cache.clear()
  inflight.clear()
  queue = []
  scheduled = false
}
