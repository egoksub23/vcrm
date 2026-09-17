/**
 * Media download override for `mirrorInboundMedia`
 * (`src/lib/whatsapp/mirror-inbound-media.ts`), used by the Messenger
 * and Instagram webhook routes.
 *
 * Unlike WhatsApp's `getMediaUrl` + `downloadMedia` two-step (fetch
 * metadata with a Bearer token, THEN download), Messenger/Instagram
 * attachment URLs arrive in the webhook payload already resolved — no
 * metadata fetch — and are pre-authorized CDN links that can reject an
 * unexpected `Authorization` header. Same `{buffer, contentType}` return
 * shape as `downloadMedia` so it's a drop-in `download` override.
 */
export async function downloadUnauthenticatedMedia(args: {
  downloadUrl: string
  accessToken: string
}): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(args.downloadUrl)
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`)
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}
