// ============================================================
// Where a stored media URL points, and which bucket it lives in.
//
// Two buckets hold workspace files:
//
//   chat-media     PRIVATE. Everything a customer or a teammate shared
//                  inside a conversation or a record: message media (both
//                  directions), widget uploads, ticket attachments,
//                  incident evidence. A file is read through a short-lived
//                  signed link minted for someone allowed to see it.
//   public-assets  PUBLIC. Files whose whole point is that anyone with the
//                  link can fetch them: knowledge-base images and
//                  attachments (they go out in emails and chat messages),
//                  the workspace logo, template header samples (Meta
//                  fetches them on every send).
//
// A stored URL is just an identifier now: for a private file it is the
// `/object/public/chat-media/<path>` string that `getPublicUrl` returns,
// which no longer serves anything once the bucket is private. Everything
// that displays or forwards one goes through the helpers here and in
// `sign-media.ts` / `lib/media/signed-urls.ts`.
// ============================================================

export const PRIVATE_MEDIA_BUCKET = 'chat-media'
export const PUBLIC_MEDIA_BUCKET = 'public-assets'

/** How long a link minted for a person looking at a file stays valid. */
export const VIEW_URL_TTL_SECONDS = 60 * 60 * 4
/** How long a link handed to a third party (Meta, an API consumer) stays valid. */
export const HANDOFF_URL_TTL_SECONDS = 60 * 60

export type StorageUrlKind = 'public' | 'sign' | 'authenticated'

export interface ParsedStorageUrl {
  bucket: string
  /** The object path, decoded. */
  path: string
  kind: StorageUrlKind
}

const STORAGE_URL = /\/storage\/v1\/object\/(public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/

/** Read a Supabase Storage object URL (any of its three forms). Null for anything else. */
export function parseStorageUrl(url: string | null | undefined): ParsedStorageUrl | null {
  if (!url) return null
  const m = STORAGE_URL.exec(url)
  if (!m) return null
  try {
    return { kind: m[1] as StorageUrlKind, bucket: m[2], path: decodeURIComponent(m[3]) }
  } catch {
    return null
  }
}

/** The object path when `url` is a file in the private bucket, otherwise null. */
export function privateMediaPath(url: string | null | undefined): string | null {
  const parsed = parseStorageUrl(url)
  return parsed && parsed.bucket === PRIVATE_MEDIA_BUCKET ? parsed.path : null
}

/** True when `url` points into the private bucket (so it must be signed to be fetched). */
export function isPrivateMediaUrl(url: string | null | undefined): boolean {
  return privateMediaPath(url) !== null
}

/** The first path segment every workspace file lives under. */
export function accountFolder(accountId: string): string {
  return `account-${accountId}`
}

/** True when `path` sits inside the workspace's own folder (and cannot climb out of it). */
export function pathInAccount(path: string, accountId: string): boolean {
  return path.startsWith(`${accountFolder(accountId)}/`) && !path.split('/').some((s) => s === '..' || s === '')
}
