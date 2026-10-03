// ============================================================
// The gateway's HTTP side:
//
//   GET  /healthz       is the service up (no auth)
//   POST /v1/sessions   the Vircle backend asks for a chat session for a signed-in
//                       user; the answer is a one-time token the app connects with
//   POST /v1/messages   Halo sends a message to a user (bearer: Halo's API token)
//   GET  /v1/health     Halo's "Test connection" (bearer: Halo's API token)
//
// Errors always have one shape: { "error": { "code": "...", "message": "..." } }.
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { GatewayConfig } from './config'
import type { DeliveryService } from './delivery'
import { acceptHaloMessage } from './halo-messages'
import type { Hub } from './hub'
import type { Store, Workspace } from './store'

export interface Services {
  store: Store
  delivery: DeliveryService
  hub: Hub
  cfg: GatewayConfig
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

/**
 * Halo sends one message to a user (contract section 4). The Idempotency-Key is Halo's message id:
 * the same key always gives the same answer and never a second message.
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
  if (kind !== 'text') throw new HttpError(400, 'invalid_media', 'File messages are not available yet')

  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, 'bad_request', 'A text message needs text')
  if (text.length > s.cfg.limits.textMax) throw new HttpError(400, 'message_too_long', `A message may be at most ${s.cfg.limits.textMax} characters`)

  const sender = body.sender && typeof body.sender === 'object' ? (body.sender as Record<string, unknown>) : null
  const email = optionalText(recipient.email, 320)
  const answer = await acceptHaloMessage(s, workspace, {
    idempotencyKey,
    text,
    senderName: sender ? optionalText(sender.name, 200) : null,
    recipient: {
      walletId,
      name: optionalText(recipient.name, 200),
      phone: optionalText(recipient.phone, 40),
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null,
    },
  })
  sendJson(res, 202, answer)
}

export type Route = (req: IncomingMessage, res: ServerResponse, s: Services) => Promise<void>

export function buildRoutes(): Record<string, Route> {
  return {
    'GET /healthz': async (_req, res, s) => sendJson(res, 200, { ok: true, connections: s.hub.size }),
    'POST /v1/sessions': createSession,
    'POST /v1/messages': postMessage,
    'GET /v1/health': health,
  }
}

/** Dispatch one request. Never throws: an unexpected failure is a 500 with nothing internal in it. */
export async function handleRequest(req: IncomingMessage, res: ServerResponse, s: Services, routes: Record<string, Route>): Promise<void> {
  try {
    const path = (req.url ?? '').split('?')[0]
    const route = routes[`${req.method} ${path}`]
    if (!route) throw new HttpError(404, 'not_found', 'No such route')
    await route(req, res, s)
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } }, err.headers)
    console.error('[http] request failed:', err)
    sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong' } })
  }
}
