// ============================================================
// Files a user sends over Vircle Chat (contract section 3.3).
//
// The gateway gives Halo a short-lived https address. Halo fetches it once and
// copies the file into its own private storage (`mirrorInboundMedia`), so the
// address is never stored and the file outlives the gateway's copy.
//
// The address comes from a service the workspace configured, so it is fetched
// with `pinnedFetch` (a private address is refused at connect time), nothing
// is followed on a redirect, and the body is read only up to the size limit.
// ============================================================

import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'
import { pinnedFetch } from '@/lib/net/safe-fetch'
import { mirrorInboundMedia, normalizeMimeType, type MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media'

import type { VircleMedia, VircleMessageType } from './contract'

const TIMEOUT_MS = 20_000

/** What the media kinds Halo shows may be (the allow-list of the storage bucket is the final word). */
const KIND_PREFIX: Record<Exclude<VircleMessageType, 'text'>, (mime: string) => boolean> = {
  image: (m) => m.startsWith('image/'),
  video: (m) => m.startsWith('video/'),
  audio: (m) => m.startsWith('audio/'),
  document: () => true,
}

/** True when the declared MIME type fits the declared message type (an "image" must be an image). */
export function mimeMatchesKind(kind: Exclude<VircleMessageType, 'text'>, mimeType: string): boolean {
  const mime = normalizeMimeType(mimeType)
  return mime !== null && KIND_PREFIX[kind](mime)
}

/** A `download` function for `mirrorInboundMedia`: fetch the gateway's address, capped. */
export async function downloadGatewayFile(args: {
  downloadUrl: string
  accessToken: string
}): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await pinnedFetch(args.downloadUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Gateway file download failed: ${res.status}`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) throw new Error('Gateway file is over the size limit')

  const reader = res.body?.getReader()
  if (!reader) throw new Error('Gateway file has no body')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MEDIA_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('Gateway file is over the size limit')
    }
    chunks.push(value)
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  }
}

/**
 * Copy a user's file into private storage. Returns the stored identifier URL,
 * or null when the file was refused or could not be fetched (the caller keeps
 * the text and notes that the file was dropped).
 */
export async function mirrorUserFile(args: {
  storage: MirrorStorage
  accountId: string
  serverId: string
  kind: Exclude<VircleMessageType, 'text'>
  media: VircleMedia
  sentAt: string | null
  download?: typeof downloadGatewayFile
}): Promise<string | null> {
  const { storage, accountId, serverId, kind, media } = args
  if (!mimeMatchesKind(kind, media.mimeType)) return null
  // The storage path is built from the gateway's message id; keep it to plain characters.
  const mediaId = `vc-${serverId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'file'}`
  return mirrorInboundMedia({
    storage,
    accountId,
    mediaId,
    downloadUrl: media.url,
    accessToken: '',
    mimeType: media.mimeType,
    fileSize: media.sizeBytes,
    fileName: media.fileName,
    messageTimestamp: args.sentAt ? Math.floor(Date.parse(args.sentAt) / 1000) : null,
    download: args.download ?? downloadGatewayFile,
  })
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  mov: 'video/quicktime',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
}

/**
 * The MIME type to tell the gateway for an outgoing file, from its name or address. The
 * composer does not carry one, and the gateway needs something to decide how to show it;
 * a file with no known extension is a generic download.
 */
export function guessMimeType(fileNameOrUrl: string | null | undefined): string {
  const clean = (fileNameOrUrl ?? '').split(/[?#]/)[0]
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(clean)?.[1]?.toLowerCase()
  return (ext && MIME_BY_EXTENSION[ext]) || 'application/octet-stream'
}
