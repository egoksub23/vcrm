// ============================================================
// The gateway's HTTP side:
//
//   GET  /healthz       is the process up (no auth; what Docker checks)
//   GET  /readyz        is it up AND can it reach its database (no auth; what an uptime monitor should watch)
//   POST /v1/sessions   the Vircle backend asks for a chat session for a signed-in
//                       user; the answer is a one-time token the app connects with
//   POST /v1/messages   Halo sends a message to a user (bearer: Halo's API token)
//   POST /v1/receipts   Halo says an agent read the user's messages (bearer: Halo's API token)
//   POST /v1/typing     Halo says an agent is typing (bearer: Halo's API token)
//   GET  /metrics       queue and process numbers for monitoring (bearer: METRICS_TOKEN; absent when unset)
//   GET  /v1/health     Halo's "Test connection" (bearer: Halo's API token)
//   PUT  /v1/uploads/:id  the app uploads a file to the address `upload_slot` gave it (signed address)
//   GET  /v1/files/:id    a file, for the app and for Halo (signed address; ranges for video and audio)
//
// Errors always have one shape: { "error": { "code": "...", "message": "..." } }.
// ============================================================

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { GatewayConfig } from './config'
import type { Db } from './db'
import { renderMetrics } from './metrics'
import type { DeliveryService } from './delivery'
import { FileError, type FileKind, type FileService } from './files'
import { acceptHaloMessage } from './halo-messages'
import type { Hub } from './hub'
import { applySupportStatus, showAgentTyping } from './receipts'
import type { Store, Workspace } from './store'
import { log } from './log'

export interface Services {
  store: Store
  delivery: DeliveryService
  files: FileService
  hub: Hub
  cfg: GatewayConfig
  db?: Db
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(text)
}

const MAX_BODY = 64 * 1024

/**
 * The app is a WebView on its own origin: uploading with fetch() and reading a file's bytes need CORS on the two file
 * routes. They are authenticated by their signed address, never by a cookie, so any origin may use them.
 */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, range',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges',
  'access-control-max-age': '86400',
}

export async function readJson(req: IncomingMessage, maxBytes = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'too_large', 'The request body is too large', { connection: 'close' })
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'bad_request', 'The request body is not JSON')
  }
}

/** The raw request body, refused as soon as it is over `maxBytes`. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'file_too_large', 'The request body is too large', { connection: 'close', ...CORS })
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null
  return m ? m[1]! : null
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null
}

/** Sessions: the Vircle backend vouches for who the user is. */
async function createSession(req: IncomingMessage, res: ServerResponse, s: Services): Promise<void> {
  const key = bearer(req)
  const workspace: Workspace | null = key ? await s.store.authenticateSessionsKey(key) : null
  if (!workspace) throw new HttpError(401, 'unauthorized', 'Bad or missing sessions key')

  const body = (await readJson(req)) as { user?: Record<string, unknown> }
  const u = body.user && typeof body.user === 'object' ? body.user : null
  const walletId = u ? str(u.wallet_id, 200) : null
  if (!u || !walletId) throw new HttpError(400, 'bad_request', 'user.wallet_id is required')
  const email = u.email === undefined || u.email === null || u.email === '' ? null : str(u.email, 320)
  if (u.email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new HttpError(400, 'bad_request', 'user.email is not valid')
  const phone = u.phone === undefined || u.phone === null || u.phone === '' ? null : str(u.phone, 40)
  if (u.phone && !phone) throw new HttpError(400, 'bad_request', 'user.phone is not valid')

  const subject = await s.store.upsertUser(workspace, {
    walletId,
    name: u.name ? str(u.name, 200) : null,
    phone,
    email: email ? email.toLowerCase() : null,
  })
  const { token, expiresAt } = await s.store.createSession(subject)
  sendJson(res, 201, {
    token,
    expires_at: expiresAt.toISOString(),
    ws_path: s.cfg.wsPath,
    conversation_id: subject.conversation.id,
  })
}

/** Halo's calls carry the API token Halo generated; it finds the workspace. */
async function authenticateHalo(req: IncomingMessage, s: Services): Promise<Workspace> {
  const token = bearer(req)
  const workspace = token ? await s.store.authenticateHalo(token) : null
  if (!workspace) throw new HttpError(401, 'unauthorized', 'Bad or missing API token')
  return workspace
}

/** Halo's "Test connection" (contract section 5). */
async function health(req: IncomingMessage, res: ServerResponse, s: Services): Promise<void> {
  await authenticateHalo(req, s)
  sendJson(res, 200, { ok: true })
}

const MESSAGE_KINDS = ['text', 'image', 'video', 'audio', 'document'] as const

/** What Halo knows about a contact is passed on when it is usable; a malformed extra is dropped, never a reason to refuse the message. */
function optionalText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null
}

const wholeNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)

/**
 * Halo sends one message to a user (contract section 4). The Idempotency-Key is Halo's message id:
 * the same key always gives the same answer and never a second message. A file message names a file the
 * gateway fetches itself; if it cannot (or must not) the answer is `400 invalid_media`.
 */
async function postMessage(req: IncomingMessage, res: ServerResponse, s: Services): Promise<void> {
  const workspace = await authenticateHalo(req, s)
  const rawKey = req.headers['idempotency-key']
  const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, 'bad_request', 'An Idempotency-Key header (up to 200 characters) is required')

  const body = (await readJson(req, s.cfg.maxHaloBodyBytes)) as Record<string, unknown>
  const recipient = body.recipient && typeof body.recipient === 'object' ? (body.recipient as Record<string, unknown>) : null
  const walletId = recipient ? optionalText(recipient.wallet_id, 200) : null
  if (!recipient || !walletId) throw new HttpError(400, 'bad_request', 'recipient.wallet_id is required')

  const kind = typeof body.type === 'string' ? body.type : ''
  if (!(MESSAGE_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'bad_request', 'type must be text, image, video, audio or document')

  const text = typeof body.text === 'string' ? body.text.trim() : ''
  let media: Parameters<typeof acceptHaloMessage>[2]['media'] = null
  if (kind === 'text') {
    if (!text) throw new HttpError(400, 'bad_request', 'A text message needs text')
    if (text.length > s.cfg.limits.textMax) throw new HttpError(400, 'message_too_long', `A message may be at most ${s.cfg.limits.textMax} characters`)
  } else {
    if (text.length > s.cfg.limits.captionMax) throw new HttpError(400, 'message_too_long', `A caption may be at most ${s.cfg.limits.captionMax} characters`)
    const m = body.media && typeof body.media === 'object' ? (body.media as Record<string, unknown>) : null
    const url = m ? optionalText(m.url, 2048) : null
    const mimeType = m ? optionalText(m.mime_type, 100) : null
    if (!m || !url || !mimeType) throw new HttpError(400, 'invalid_media', 'A file message needs media.url and media.mime_type')
    media = {
      kind: kind as FileKind,
      url,
      mimeType,
      fileName: optionalText(m.file_name, 255),
      sizeBytes: wholeNumber(m.size_bytes),
      durationSeconds: wholeNumber(m.duration_seconds),
    }
  }

  const sender = body.sender && typeof body.sender === 'object' ? (body.sender as Record<string, unknown>) : null
  const email = optionalText(recipient.email, 320)
  let answer
  try {
    answer = await acceptHaloMessage(s, workspace, {
      idempotencyKey,
      text: text || null,
      media,
      replyToServerId: optionalText(body.reply_to_server_id, 200),
      senderName: sender ? optionalText(sender.name, 200) : null,
      recipient: {
        walletId,
        name: optionalText(recipient.name, 200),
        phone: optionalText(recipient.phone, 40),
        email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null,
      },
    })
  } catch (err) {
    // Whatever is wrong with the file, Halo hears the contract's one word for it.
    if (err instanceof FileError) throw new HttpError(400, 'invalid_media', err.message)
    throw err
  }
  sendJson(res, 202, answer)
}

/** Halo: an agent read these messages of the user's (contract 4.1). */
async function postReceipts(req: IncomingMessage, res: ServerResponse, s: Services): Promise<void> {
  const workspace = await authenticateHalo(req, s)
  const body = (await readJson(req, s.cfg.maxHaloBodyBytes)) as Record<string, unknown>
  const recipient = body.recipient && typeof body.recipient === 'object' ? (body.recipient as Record<string, unknown>) : null
  const walletId = recipient ? optionalText(recipient.wallet_id, 200) : null
  if (!walletId) throw new HttpError(400, 'bad_request', 'recipient.wallet_id is required')
  if (body.status !== 'read' && body.status !== 'delivered') throw new HttpError(400, 'bad_request', 'status must be read')
  const ids = Array.isArray(body.server_ids) ? body.server_ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100) : []
  if (ids.length === 0 || ids.length > 200) throw new HttpError(400, 'bad_request', 'server_ids must list between 1 and 200 message ids')
  const subject = await s.store.findSubjectByWallet(workspace, walletId)
  // An unknown user is not an error: there is nobody whose ticks could change.
  const updated = subject ? await applySupportStatus(s, subject, ids, body.status) : 0
  sendJson(res, 202, { updated })
}

/** Halo: an agent is typing (contract 4.2). Not stored, no push. */
async function postTyping(req: IncomingMessage, res: ServerResponse, s: Services): Promise<void> {
  const workspace = await authenticateHalo(req, s)
  const body = (await readJson(req, s.cfg.maxHaloBodyBytes)) as Record<string, unknown>
  const recipient = body.recipient && typeof body.recipient === 'object' ? (body.recipient as Record<string, unknown>) : null
  const walletId = recipient ? optionalText(recipient.wallet_id, 200) : null
  if (!walletId) throw new HttpError(400, 'bad_request', 'recipient.wallet_id is required')
  const subject = await s.store.findSubjectByWallet(workspace, walletId)
  sendJson(res, 202, { delivered_to: subject ? showAgentTyping(s, subject) : 0 })
}

function fileFailure(err: unknown): never {
  if (err instanceof FileError) throw new HttpError(err.status, err.code, err.message, CORS)
  throw err
}

/** The app uploads the bytes of a file to its signed address (from an `upload_slot`). */
async function putUpload(req: IncomingMessage, res: ServerResponse, s: Services, params: Record<string, string>): Promise<void> {
  const q = new URL(req.url ?? '/', 'http://x').searchParams
  const exp = q.get('exp')
  const sig = q.get('sig')
  const id = params.id ?? ''
  // The address is checked before a byte of the body is read.
  const link = s.files.verify('upload', id, exp, sig)
  if (link === 'bad') throw new HttpError(401, 'unauthorized', 'The upload address is not valid', CORS)
  if (link === 'expired') throw new HttpError(410, 'expired', 'The upload address has expired: ask for a new one', CORS)
  const length = Number(req.headers['content-length'])
  if (!Number.isFinite(length) || length <= 0) throw new HttpError(411, 'length_required', 'Send the file with a Content-Length', CORS)
  if (length > s.cfg.limits.fileMaxBytes) throw new HttpError(413, 'file_too_large', 'The file is over the size limit', { connection: 'close', ...CORS })
  const body = await readBody(req, length)
  try {
    const row = await s.files.receiveUpload(id, exp, sig, typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null, body)
    sendJson(res, 201, { file_id: row.id, size_bytes: row.size_bytes }, CORS)
  } catch (err) {
    fileFailure(err)
  }
}

/** A file, by its signed address. Supports one `Range` (iOS will not play video or audio without it). */
async function getFile(req: IncomingMessage, res: ServerResponse, s: Services, params: Record<string, string>): Promise<void> {
  const q = new URL(req.url ?? '/', 'http://x').searchParams
  const id = params.id ?? ''
  const link = s.files.verify('file', id, q.get('exp'), q.get('sig'))
  if (link === 'bad') throw new HttpError(401, 'unauthorized', 'The file address is not valid', CORS)
  if (link === 'expired') throw new HttpError(410, 'expired', 'The file address has expired: ask for a new one', CORS)
  const file = await s.files.read(id)
  if (!file) throw new HttpError(404, 'file_not_found', 'No such file', CORS)

  const { row, data } = file
  const name = row.file_name ?? `file-${row.id}`
  const inline = row.kind !== 'document' || row.mime_type === 'application/pdf'
  const headers: Record<string, string> = {
    ...CORS,
    'content-type': row.mime_type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  }
  const range = typeof req.headers.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null
  if (range && (range[1] || range[2])) {
    const total = data.length
    let start = range[1] ? Number(range[1]) : total - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : total - 1
    start = Math.max(0, start)
    end = Math.min(total - 1, end)
    if (start > end || start >= total) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${total}` })
      res.end()
      return
    }
    const part = data.subarray(start, end + 1)
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(part.length) })
    res.end(req.method === 'HEAD' ? undefined : part)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(data.length) })
  res.end(req.method === 'HEAD' ? undefined : data)
}

/** Prometheus text for a scraper. Not there at all unless METRICS_TOKEN is set; then it needs that token. */
async function getMetrics(req: IncomingMessage, res: ServerResponse, s: Services): Promise<void> {
  const token = s.cfg.metricsToken
  if (!token) throw new HttpError(404, 'not_found', 'No such route')
  const presented = /^Bearer\s+(.+)$/i.exec(typeof req.headers.authorization === 'string' ? req.headers.authorization : '')?.[1] ?? ''
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(token).digest()
  if (!timingSafeEqual(a, b)) throw new HttpError(401, 'unauthorized', 'Bad metrics token')
  const text = await renderMetrics({ store: s.store, hub: s.hub, db: s.db ?? null })
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** `params` carries the `:name` parts of a route like "PUT /v1/uploads/:id". */
export type Route = (req: IncomingMessage, res: ServerResponse, s: Services, params: Record<string, string>) => Promise<void>

export function buildRoutes(): Record<string, Route> {
  return {
    'GET /healthz': async (_req, res, s) => sendJson(res, 200, { ok: true, connections: s.hub.size }),
    'GET /readyz': async (_req, res, s) => {
      try {
        await s.store.ping()
      } catch {
        return sendJson(res, 503, { ok: false, error: 'database_unavailable' })
      }
      sendJson(res, 200, { ok: true, connections: s.hub.size })
    },
    'GET /metrics': getMetrics,
    'POST /v1/sessions': createSession,
    'POST /v1/messages': postMessage,
    'POST /v1/receipts': postReceipts,
    'POST /v1/typing': postTyping,
    'GET /v1/health': health,
    'PUT /v1/uploads/:id': putUpload,
    'GET /v1/files/:id': getFile,
    'HEAD /v1/files/:id': getFile,
  }
}

/** Find the route for a request: an exact "METHOD /path", else a "METHOD /path/:name" pattern. */
function matchRoute(routes: Record<string, Route>, method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const exact = routes[`${method} ${path}`]
  if (exact) return { route: exact, params: {} }
  const parts = path.split('/')
  for (const [key, route] of Object.entries(routes)) {
    if (!key.includes(':')) continue
    const [m, pattern = ''] = key.split(' ')
    if (m !== method) continue
    const want = pattern.split('/')
    if (want.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!
      if (w.startsWith(':')) params[w.slice(1)] = decodeURIComponent(parts[i]!)
      else if (w !== parts[i]) {
        ok = false
        break
      }
    }
    if (ok) return { route, params }
  }
  return null
}

/** Dispatch one request. Never throws: an unexpected failure is a 500 with nothing internal in it. */
export async function handleRequest(req: IncomingMessage, res: ServerResponse, s: Services, routes: Record<string, Route>): Promise<void> {
  try {
    const path = (req.url ?? '').split('?')[0] ?? ''
    // The browser's preflight for an upload or a file fetch from the app's own origin.
    if (req.method === 'OPTIONS' && (path.startsWith('/v1/uploads/') || path.startsWith('/v1/files/'))) {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    const found = matchRoute(routes, req.method ?? 'GET', path)
    if (!found) throw new HttpError(404, 'not_found', 'No such route')
    await found.route(req, res, s, found.params)
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } }, err.headers)
    log.child('http').error('request failed', { error: err instanceof Error ? err.message : String(err) })
    sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong' } })
  }
}
