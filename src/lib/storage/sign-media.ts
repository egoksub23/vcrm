// ============================================================
// Server side: turn a stored private-media URL into a link somebody can
// fetch, after checking the file belongs to the workspace asking.
//
// Use the service-role client here. The check that matters is
// `pathInAccount`: a signed link is a bearer credential for one object, so
// a URL naming another workspace's folder must never be signed, whoever
// asks. Anything that is not a private-bucket URL (a public-assets file, a
// Meta-hosted link, a proxy path) comes back untouched.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  HANDOFF_URL_TTL_SECONDS,
  PRIVATE_MEDIA_BUCKET,
  pathInAccount,
  privateMediaPath,
} from './media-urls'

/**
 * A fetchable link for `url`. A private-bucket URL inside `accountId`'s folder
 * is signed for `ttlSeconds`; a private-bucket URL in anyone else's folder
 * returns null (never sign it); any other URL is returned as given.
 */
export async function signMediaUrl(
  admin: Pick<SupabaseClient, 'storage'>,
  url: string,
  accountId: string,
  ttlSeconds: number = HANDOFF_URL_TTL_SECONDS,
): Promise<string | null> {
  const path = privateMediaPath(url)
  if (path === null) return url
  if (!pathInAccount(path, accountId)) return null
  const { data, error } = await admin.storage.from(PRIVATE_MEDIA_BUCKET).createSignedUrl(path, ttlSeconds)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/** `signMediaUrl` for a list, in one Storage round trip per private file (order and nulls kept). */
export async function signMediaUrls(
  admin: Pick<SupabaseClient, 'storage'>,
  urls: readonly string[],
  accountId: string,
  ttlSeconds: number = HANDOFF_URL_TTL_SECONDS,
): Promise<(string | null)[]> {
  return Promise.all(urls.map((u) => signMediaUrl(admin, u, accountId, ttlSeconds)))
}

/**
 * The bytes of a private-bucket file, read by path with the service role (no
 * link involved), for flows that attach a file themselves: an email attachment,
 * the template header sample. Null for a URL outside the workspace's folder.
 */
export async function downloadPrivateMedia(
  admin: Pick<SupabaseClient, 'storage'>,
  url: string,
  accountId: string,
): Promise<Blob | null> {
  const path = privateMediaPath(url)
  if (path === null || !pathInAccount(path, accountId)) return null
  const { data, error } = await admin.storage.from(PRIVATE_MEDIA_BUCKET).download(path)
  if (error || !data) return null
  return data
}
