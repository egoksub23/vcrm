import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extensionForMime } from '@/lib/media/filename'
import { buildMediaPath } from '@/lib/storage/upload-media'

// ============================================================
// A post's picture, kept in OUR storage.
//
// Facebook and Instagram hand out picture links that are signed and expire (the `oe=` parameter, about a week). The comments module used to store
// that link as it came, so a post's thumbnail was broken a week after its first comment, and nothing ever replaced it (the post is only looked up
// the first time it is seen). A copy in the `public-assets` bucket never expires: the pictures are public posts, and the bucket is the one meant
// for files that must stay fetchable by URL.
//
// Everything here is BEST EFFORT and returns null instead of throwing: it runs inside a webhook, and a webhook that starts failing makes Meta
// redeliver (and the replies, flows and automations run again). On any failure the caller keeps the link it has.
// ============================================================

export const POST_MEDIA_BUCKET = 'public-assets'
/** Second path segment, under `account-<id>`; the bucket's policies only look at the first. */
export const POST_MEDIA_FOLDER = 'comment-posts'
/** A thumbnail is a picture, not a video: anything larger is not one. */
export const POST_MEDIA_MAX_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000

/** The only hosts a picture is fetched from: Meta's picture CDNs. The link comes from Meta's API, but it is still a URL the server is about to open. */
const ALLOWED_HOST_SUFFIXES = ['.fbcdn.net', '.cdninstagram.com', '.facebook.com', '.fbsbx.com']

export function isAllowedPostMediaUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  return ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s))
}

/** True when the stored link already points at our own copy of this workspace's post picture. */
export function isMirroredPostMedia(url: string | null | undefined, accountId: string): boolean {
  return !!url && url.includes(`/storage/v1/object/public/${POST_MEDIA_BUCKET}/account-${accountId}/${POST_MEDIA_FOLDER}/`)
}

/**
 * The object name for a post's picture. The post id is hashed: a Facebook id is `<page>_<post>` and the path builder keeps only 40 characters of a
 * name, so two long ids could otherwise land on the same file. The same post always gets the same name, so a repeat overwrites rather than piles up.
 */
export function postMediaFileName(provider: string, externalPostId: string, mimeType: string): string {
  const id = createHash('sha256').update(`${provider}:${externalPostId}`).digest('hex').slice(0, 24)
  return `${provider}-${id}.${extensionForMime(mimeType)}`
}

export interface MirrorPostMediaArgs {
  db: Pick<SupabaseClient, 'storage'>
  accountId: string
  provider: string
  externalPostId: string
  /** The picture link Meta's API just returned. */
  sourceUrl: string | null | undefined
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

/** Copy a post's picture into storage. Returns the stored link, or null when it was skipped or failed. */
export async function mirrorPostMedia(a: MirrorPostMediaArgs): Promise<string | null> {
  const { db, accountId, provider, externalPostId, sourceUrl, fetchImpl = fetch } = a
  if (!sourceUrl || !isAllowedPostMediaUrl(sourceUrl)) return null
  try {
    const res = await fetchImpl(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!type.startsWith('image/')) return null
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > POST_MEDIA_MAX_BYTES) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > POST_MEDIA_MAX_BYTES) return null

    const path = buildMediaPath(accountId, postMediaFileName(provider, externalPostId, type), null, POST_MEDIA_FOLDER)
    const bucket = db.storage.from(POST_MEDIA_BUCKET)
    const { error } = await bucket.upload(path, bytes, { contentType: type, cacheControl: '31536000', upsert: true })
    if (error) {
      console.warn('[comments] post picture upload failed:', error.message)
      return null
    }
    return bucket.getPublicUrl(path).data.publicUrl || null
  } catch (err) {
    console.warn('[comments] could not keep a post picture:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Our own copy of the picture when it can be made, otherwise the link as Meta sent it (it will be repaired when it is next shown). */
export async function keepPostMedia(a: MirrorPostMediaArgs): Promise<string | null> {
  return (await mirrorPostMedia(a)) ?? a.sourceUrl ?? null
}
