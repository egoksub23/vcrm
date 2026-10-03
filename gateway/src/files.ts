// ============================================================
// Files (contract 1.2, docs/vircle-chat-contract.md sections 3.3 and 4; WP 4).
//
//   FROM THE APP    the app asks for an upload slot over the WebSocket (`upload_request`) and gets a signed
//                   address; it PUTs the bytes there over HTTPS (nothing big ever goes through the socket) and
//                   then sends a message that names the file. The bytes are checked: the declared type is on
//                   the allowed list and matches the kind, the size is what was declared and within 16 MB, and
//                   the first bytes really are that type.
//   TO THE APP      a file in a message from Halo is fetched by the gateway from the address Halo gave and kept;
//                   the app is given a signed link to the gateway's copy.
//   TO HALO         an event about a file the user sent carries a short-lived signed link (made fresh on every
//                   attempt); Halo copies the file into its own private storage.
//
// Every link is an HMAC over "<purpose>.<file id>.<expiry>" with a key derived from GATEWAY_ENCRYPTION_KEY, so a
// link cannot be forged, reused for another file, or used after it expires. The bytes are kept in Postgres for
// the pilot (a `files` row, 16 MB at most); everything that touches them is in this class, so moving them to
// object storage later is a change in one file.
// ============================================================

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

import type { GatewayConfig } from './config'
import { newId } from './crypto'
import type { Db } from './db'
import type { Subject } from './store'

export type FileKind = 'image' | 'video' | 'audio' | 'document'
export const FILE_KINDS: readonly FileKind[] = ['image', 'video', 'audio', 'document']

/** The same list as Halo's chat-media bucket (migration 023) and the web widget: what WhatsApp accepts. */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/3gpp',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'audio/ogg',
  'audio/mpeg',
  'audio/aac',
  'audio/mp4',
  'audio/amr',
]

export const baseMime = (mime: string): string => mime.split(';')[0]!.trim().toLowerCase()

/** An "image" must be an image, a "voice note" audio, and so on; a document is anything else on the list. */
export function mimeMatchesKind(kind: FileKind, mime: string): boolean {
  const m = baseMime(mime)
  if (!ALLOWED_MIME_TYPES.includes(m)) return false
  if (kind === 'image') return m.startsWith('image/')
  if (kind === 'video') return m.startsWith('video/')
  if (kind === 'audio') return m.startsWith('audio/')
  return !m.startsWith('image/') && !m.startsWith('video/') && !m.startsWith('audio/')
}

/** Do the first bytes look like the type that was declared? Only for formats with an unmistakable start. */
export function sniffMatches(mime: string, b: Buffer): boolean {
  const m = baseMime(mime)
  const at = (offset: number, text: string) => b.length >= offset + text.length && b.subarray(offset, offset + text.length).toString('latin1') === text
  switch (m) {
    case 'image/png':
      return b.length > 8 && b[0] === 0x89 && at(1, 'PNG')
    case 'image/jpeg':
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    case 'image/webp':
      return at(0, 'RIFF') && at(8, 'WEBP')
    case 'application/pdf':
      return at(0, '%PDF')
    case 'audio/ogg':
      return at(0, 'OggS')
    case 'audio/amr':
      return at(0, '#!AMR')
    case 'video/mp4':
    case 'video/3gpp':
    case 'audio/mp4':
      return at(4, 'ftyp')
    default:
      return true
  }
}

export class FileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface FileRow {
  id: string
  workspace_id: string
  conversation_id: string
  origin: 'app' | 'halo'
  kind: FileKind
  mime_type: string
  file_name: string | null
  size_bytes: number
  duration_seconds: number | null
  /** A GIF: an MP4 to play as a muted loop. */
  animated: boolean
  status: 'pending' | 'ready'
  attached_at: string | null
  expires_at: string
}

/** What a message row keeps about its file (messages.media). */
export interface MessageMedia {
  file_id: string
  mime_type: string
  file_name: string | null
  size_bytes: number
  duration_seconds: number | null
  /** Present (true) only for a GIF. */
  animated?: boolean
}

const COLUMNS = 'id, workspace_id, conversation_id, origin, kind, mime_type, file_name, size_bytes, duration_seconds, animated, status, attached_at, expires_at'

export interface DeclaredFile {
  kind: unknown
  mimeType: unknown
  fileName?: unknown
  sizeBytes: unknown
  durationSeconds?: unknown
  /** true for a GIF sent as a looping MP4 (kind video, video/mp4 only). */
  animated?: unknown
}

export interface FileServiceOptions {
  fetch?: typeof fetch
  now?: () => number
}

export class FileService {
  /** Where links point. Set from PUBLIC_BASE_URL, else by the app once it knows its port. */
  baseUrl: string
  private readonly key: Buffer
  private readonly doFetch: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly db: Db,
    private readonly cfg: Pick<GatewayConfig, 'files' | 'limits' | 'encryptionKey'>,
    opts: FileServiceOptions = {},
  ) {
    this.baseUrl = cfg.files.publicBaseUrl ?? 'http://127.0.0.1'
    this.key = createHash('sha256').update(`gateway-files:${cfg.encryptionKey}`).digest()
    this.doFetch = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
  }

  // ----------------------------------------------------------
  // Signed links
  // ----------------------------------------------------------

  private sign(purpose: 'upload' | 'file', fileId: string, exp: number): string {
    return createHmac('sha256', this.key).update(`${purpose}.${fileId}.${exp}`).digest('hex')
  }

  private signed(purpose: 'upload' | 'file', fileId: string, ttlSeconds: number): { url: string; expiresAt: Date } {
    const exp = Math.floor(this.now() / 1000) + ttlSeconds
    const path = purpose === 'upload' ? 'uploads' : 'files'
    return { url: `${this.baseUrl}/v1/${path}/${fileId}?exp=${exp}&sig=${this.sign(purpose, fileId, exp)}`, expiresAt: new Date(exp * 1000) }
  }

  /** 'ok', or why the link is refused. */
  verify(purpose: 'upload' | 'file', fileId: string, expRaw: string | null, sigRaw: string | null): 'ok' | 'bad' | 'expired' {
    if (!expRaw || !sigRaw || !/^\d{1,12}$/.test(expRaw)) return 'bad'
    const exp = Number(expRaw)
    const expected = Buffer.from(this.sign(purpose, fileId, exp))
    const given = Buffer.from(sigRaw)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad'
    return exp * 1000 <= this.now() ? 'expired' : 'ok'
  }

  /** A link to a file for the app, good for APP_FILE_LINK_HOURS. */
  linkForApp(fileId: string): { url: string; expiresAt: Date } {
    return this.signed('file', fileId, this.cfg.files.appLinkHours * 3600)
  }

  /** The `media` object of a frame to the app, with a link to the gateway's copy. */
  mediaForApp(media: MessageMedia | null): Record<string, unknown> | null {
    if (!media) return null
    if (!media.file_id) return { ...media }
    const link = this.linkForApp(media.file_id)
    return {
      file_id: media.file_id,
      url: link.url,
      expires_at: link.expiresAt.toISOString(),
      mime_type: media.mime_type,
      file_name: media.file_name,
      size_bytes: media.size_bytes,
      duration_seconds: media.duration_seconds,
      ...(media.animated ? { animated: true } : {}),
    }
  }

  /** A fresh link for a file in the user's own conversation (the app asks when one expired), or null. */
  async linkForUser(subject: Subject, fileId: string): Promise<{ url: string; expiresAt: Date } | null> {
    const { rows } = await this.db.query('SELECT 1 FROM files WHERE id = $1 AND conversation_id = $2 AND status = $3', [fileId, subject.conversation.id, 'ready'])
    return rows[0] ? this.linkForApp(fileId) : null
  }

  /**
   * The payload of an event for Halo with the file turned into the contract's `media` object: a signed link
   * (made now, so a retry hours later still has a good one), the type, the name and the size.
   */
  signEventMedia(payload: Record<string, unknown>): Record<string, unknown> {
    const message = payload.message as { media?: MessageMedia | null } | undefined
    const media = message?.media
    if (!message || !media || !media.file_id) return payload
    const link = this.signed('file', media.file_id, this.cfg.files.haloLinkHours * 3600)
    return {
      ...payload,
      message: {
        ...message,
        media: {
          url: link.url,
          mime_type: media.mime_type,
          ...(media.file_name ? { file_name: media.file_name } : {}),
          size_bytes: media.size_bytes,
          ...(media.duration_seconds !== null && media.duration_seconds !== undefined ? { duration_seconds: media.duration_seconds } : {}),
          ...(media.animated ? { animated: true } : {}),
        },
      },
    }
  }

  // ----------------------------------------------------------
  // Checking what a file claims to be
  // ----------------------------------------------------------

  validateDeclared(d: DeclaredFile): { kind: FileKind; mimeType: string; fileName: string | null; sizeBytes: number; durationSeconds: number | null; animated: boolean } {
    const kind = typeof d.kind === 'string' && (FILE_KINDS as readonly string[]).includes(d.kind) ? (d.kind as FileKind) : null
    if (!kind) throw new FileError('bad_request', 'kind must be image, video, audio or document', 400)
    if (typeof d.mimeType !== 'string' || !d.mimeType.trim()) throw new FileError('bad_request', 'mime_type is required', 400)
    const mimeType = baseMime(d.mimeType)
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) throw new FileError('file_type_not_allowed', `Files of type ${mimeType} are not allowed`, 415)
    if (!mimeMatchesKind(kind, mimeType)) throw new FileError('file_type_not_allowed', `A ${mimeType} file cannot be sent as ${kind}`, 415)
    const size = d.sizeBytes
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw new FileError('bad_request', 'size_bytes must be a whole number above zero', 400)
    if (size > this.cfg.limits.fileMaxBytes) throw new FileError('file_too_large', `A file may be at most ${Math.floor(this.cfg.limits.fileMaxBytes / 1024 / 1024)} MB`, 413)
    let durationSeconds: number | null = null
    if (d.durationSeconds !== undefined && d.durationSeconds !== null) {
      if (typeof d.durationSeconds !== 'number' || !Number.isFinite(d.durationSeconds) || d.durationSeconds < 0) throw new FileError('bad_request', 'duration_seconds is not valid', 400)
      if (kind === 'audio' && d.durationSeconds > this.cfg.files.maxVoiceSeconds) {
        throw new FileError('file_too_large', `A voice note may be at most ${Math.floor(this.cfg.files.maxVoiceSeconds / 60)} minutes`, 413)
      }
      durationSeconds = Math.round(d.durationSeconds)
    }
    const fileName = typeof d.fileName === 'string' && d.fileName.trim() ? d.fileName.trim().replace(/[\\/\r\n\0]/g, '_').slice(0, 200) : null
    let animated = false
    if (d.animated !== undefined && d.animated !== null) {
      if (typeof d.animated !== 'boolean') throw new FileError('bad_request', 'animated must be true or false', 400)
      if (d.animated && !(kind === 'video' && mimeType === 'video/mp4')) throw new FileError('bad_request', 'animated is only for an MP4 video (send a GIF as a looping MP4)', 400)
      animated = d.animated
    }
    return { kind, mimeType, fileName, sizeBytes: size, durationSeconds, animated }
  }

  // ----------------------------------------------------------
  // From the app: slot, upload, claim
  // ----------------------------------------------------------

  async createUploadSlot(subject: Subject, declared: DeclaredFile): Promise<{ fileId: string; uploadUrl: string; expiresAt: Date; maxBytes: number }> {
    const f = this.validateDeclared(declared)
    const fileId = newId('f_')
    const expiresAt = new Date(this.now() + this.cfg.files.uploadSlotMinutes * 60_000)
    await this.db.query(
      `INSERT INTO files (id, workspace_id, conversation_id, origin, kind, mime_type, file_name, size_bytes, duration_seconds, animated, status, expires_at)
       VALUES ($1, $2, $3, 'app', $4, $5, $6, $7, $8, $9, 'pending', $10)`,
      [fileId, subject.workspace.id, subject.conversation.id, f.kind, f.mimeType, f.fileName, f.sizeBytes, f.durationSeconds, f.animated, expiresAt.toISOString()],
    )
    const link = this.signed('upload', fileId, this.cfg.files.uploadSlotMinutes * 60)
    return { fileId, uploadUrl: link.url, expiresAt: link.expiresAt, maxBytes: f.sizeBytes }
  }

  /** The bytes arrive. Every check that can fail does so before anything is stored. */
  async receiveUpload(fileId: string, exp: string | null, sig: string | null, contentType: string | null, body: Buffer): Promise<FileRow> {
    const link = this.verify('upload', fileId, exp, sig)
    if (link === 'bad') throw new FileError('unauthorized', 'The upload address is not valid', 401)
    if (link === 'expired') throw new FileError('expired', 'The upload address has expired: ask for a new one', 410)
    const { rows } = await this.db.query<FileRow>(`SELECT ${COLUMNS} FROM files WHERE id = $1 AND origin = 'app'`, [fileId])
    const row = rows[0]
    if (!row) throw new FileError('file_not_found', 'No such upload', 404)
    if (row.status !== 'pending') throw new FileError('already_uploaded', 'This file was already uploaded', 409)
    if (new Date(row.expires_at).getTime() <= this.now()) throw new FileError('expired', 'The upload address has expired: ask for a new one', 410)
    if (!contentType || baseMime(contentType) !== row.mime_type) throw new FileError('file_type_not_allowed', `The Content-Type must be ${row.mime_type}, as declared`, 415)
    if (body.length > row.size_bytes) throw new FileError('file_too_large', 'More bytes arrived than were declared', 413)
    if (body.length !== row.size_bytes) throw new FileError('size_mismatch', `${body.length} bytes arrived, ${row.size_bytes} were declared`, 400)
    if (!sniffMatches(row.mime_type, body)) throw new FileError('file_type_not_allowed', `The file's content is not ${row.mime_type}`, 415)
    const done = await this.db.query(`UPDATE files SET data = $2, status = 'ready' WHERE id = $1 AND status = 'pending'`, [fileId, body])
    if (done.rowCount === 0) throw new FileError('already_uploaded', 'This file was already uploaded', 409)
    return { ...row, status: 'ready' }
  }

  /**
   * Use an uploaded file in a message: it must be the user's own, finished, of the kind the message says,
   * and not used before. One atomic statement, so two messages cannot both claim it.
   */
  async claimForMessage(subject: Subject, fileId: string, kind: FileKind): Promise<FileRow> {
    const { rows } = await this.db.query<FileRow>(
      `UPDATE files SET attached_at = $4
        WHERE id = $1 AND conversation_id = $2 AND origin = 'app' AND status = 'ready' AND attached_at IS NULL AND kind = $3
        RETURNING ${COLUMNS}`,
      [fileId, subject.conversation.id, kind, new Date(this.now()).toISOString()],
    )
    if (rows[0]) return rows[0]
    const why = await this.db.query<FileRow>(`SELECT ${COLUMNS} FROM files WHERE id = $1 AND conversation_id = $2 AND origin = 'app'`, [fileId, subject.conversation.id])
    const f = why.rows[0]
    if (!f) throw new FileError('file_not_found', 'No such file', 404)
    if (f.status !== 'ready') throw new FileError('file_not_ready', 'The file has not been uploaded yet', 409)
    if (f.attached_at) throw new FileError('file_in_use', 'That file was already sent', 409)
    throw new FileError('bad_request', `That file is a ${f.kind}, not a ${kind}`, 400)
  }

  /** Give a claimed file back (the message that was going to use it could not be stored). */
  async release(fileId: string): Promise<void> {
    await this.db.query('UPDATE files SET attached_at = NULL WHERE id = $1', [fileId])
  }

  // ----------------------------------------------------------
  // From Halo (fetched) and the simulator (given): stored ready, already attached
  // ----------------------------------------------------------

  async storeBytes(
    subject: Subject,
    origin: 'app' | 'halo',
    f: { kind: FileKind; mimeType: string; fileName: string | null; durationSeconds: number | null; animated?: boolean; bytes: Buffer },
  ): Promise<FileRow> {
    const v = this.validateDeclared({ kind: f.kind, mimeType: f.mimeType, fileName: f.fileName, sizeBytes: f.bytes.length, durationSeconds: f.durationSeconds, animated: f.animated })
    if (!sniffMatches(v.mimeType, f.bytes)) throw new FileError('invalid_media', `The file's content is not ${v.mimeType}`, 400)
    const fileId = newId('f_')
    const now = new Date(this.now()).toISOString()
    const { rows } = await this.db.query<FileRow>(
      `INSERT INTO files (id, workspace_id, conversation_id, origin, kind, mime_type, file_name, size_bytes, duration_seconds, animated, status, data, attached_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ready', $11, $12, $12) RETURNING ${COLUMNS}`,
      [fileId, subject.workspace.id, subject.conversation.id, origin, v.kind, v.mimeType, v.fileName, v.sizeBytes, v.durationSeconds, v.animated, f.bytes, now],
    )
    return rows[0]!
  }

  /**
   * Halo's `media.url`: fetch it now (capped, no redirects, https only) and check what came back. Touches no
   * database, so a refused file leaves nothing behind (not even the user); `storeBytes` keeps it afterwards.
   */
  async fetchFromHalo(
    kind: FileKind,
    media: { url: string; mimeType: string; fileName: string | null; sizeBytes: number | null; durationSeconds: number | null; animated?: boolean },
  ): Promise<{ kind: FileKind; mimeType: string; fileName: string | null; durationSeconds: number | null; animated: boolean; bytes: Buffer }> {
    let url: URL
    try {
      url = new URL(media.url)
    } catch {
      throw new FileError('invalid_media', 'media.url is not a valid address', 400)
    }
    if (!this.cfg.files.allowInsecureFetch) {
      if (url.protocol !== 'https:') throw new FileError('invalid_media', 'media.url must start with https://', 400)
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && isPrivateLiteral(host))) {
        throw new FileError('invalid_media', 'media.url must be a public address', 400)
      }
    }
    // Refuse early what the declared type or size already rules out, before any bytes move.
    this.validateDeclared({ kind, mimeType: media.mimeType, fileName: media.fileName, sizeBytes: media.sizeBytes ?? 1, durationSeconds: media.durationSeconds, animated: media.animated })

    let res: Response
    try {
      res = await this.doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(this.cfg.files.fetchTimeoutMs) })
    } catch {
      throw new FileError('invalid_media', 'The file could not be fetched from the address Halo gave', 400)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new FileError('invalid_media', `The file address answered ${res.status}`, 400)
    }
    const max = this.cfg.limits.fileMaxBytes
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => undefined)
      throw new FileError('invalid_media', 'The file is over the size limit', 400)
    }
    const reader = res.body?.getReader()
    if (!reader) throw new FileError('invalid_media', 'The file address sent no content', 400)
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => undefined)
        throw new FileError('invalid_media', 'The file is over the size limit', 400)
      }
      chunks.push(value)
    }
    if (total === 0) throw new FileError('invalid_media', 'The file is empty', 400)
    const bytes = Buffer.concat(chunks)
    try {
      const v = this.validateDeclared({ kind, mimeType: media.mimeType, fileName: media.fileName, sizeBytes: bytes.length, durationSeconds: media.durationSeconds, animated: media.animated })
      if (!sniffMatches(v.mimeType, bytes)) throw new FileError('invalid_media', `The file's content is not ${v.mimeType}`, 400)
    } catch (err) {
      // A file that fails a check is Halo's problem to hear about, in the contract's words.
      if (err instanceof FileError) throw new FileError('invalid_media', err.message, 400)
      throw err
    }
    return { kind, mimeType: media.mimeType, fileName: media.fileName, durationSeconds: media.durationSeconds, animated: media.animated === true, bytes }
  }

  // ----------------------------------------------------------
  // Reading
  // ----------------------------------------------------------

  async read(fileId: string): Promise<{ row: FileRow; data: Buffer } | null> {
    const { rows } = await this.db.query<FileRow & { data: Buffer | Uint8Array | null }>(`SELECT ${COLUMNS}, data FROM files WHERE id = $1 AND status = 'ready'`, [fileId])
    const r = rows[0]
    if (!r || !r.data) return null
    const { data, ...row } = r
    return { row: row as FileRow, data: Buffer.from(data) }
  }

  mediaOf(row: FileRow): MessageMedia {
    return {
      file_id: row.id,
      mime_type: row.mime_type,
      file_name: row.file_name,
      size_bytes: row.size_bytes,
      duration_seconds: row.duration_seconds,
      ...(row.animated ? { animated: true } : {}),
    }
  }

  /** Housekeeping: upload slots that were never used. */
  async purgeStalePending(): Promise<number> {
    const r = await this.db.query(`DELETE FROM files WHERE status = 'pending' AND expires_at < $1`, [new Date(this.now() - 3_600_000).toISOString()])
    return r.rowCount
  }
}

function isPrivateLiteral(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase()
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
  }
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}
