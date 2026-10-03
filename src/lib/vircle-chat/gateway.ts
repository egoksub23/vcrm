// ============================================================
// Halo to gateway (docs/vircle-chat-contract.md, sections 4 and 5).
//
// The gateway address is typed by a workspace admin, so every call goes
// through `pinnedFetch` (lib/net/safe-fetch.ts): the address the connection
// really uses is checked, and a redirect is never followed. The only way to
// reach a local gateway (the mock in scripts/vircle-chat-mock.mjs) is the
// deployment-level switch VIRCLE_CHAT_ALLOW_LOCAL_GATEWAY=true, which is off
// by default and is not something a workspace can turn on.
// ============================================================

import { pinnedFetch } from '@/lib/net/safe-fetch'

import {
  parseGatewayAccepted,
  parseGatewayError,
  type GatewayAccepted,
  type VircleMessageType,
} from './contract'

const TIMEOUT_MS = 10_000

export interface GatewayConnection {
  baseUrl: string
  apiToken: string
}

export interface GatewaySend {
  /** The Halo message id: the same key always gives the same answer. */
  idempotencyKey: string
  walletId: string
  /** What Halo knows about the contact: the gateway needs the phone or email to name the recipient to the push API. */
  contact: { name: string | null; phone: string | null; email: string | null }
  /** The gateway's conversation id, when an inbound event has told us one. */
  conversationId: string | null
  type: VircleMessageType
  text: string | null
  /** `durationSeconds` is a voice note's length (contract 1.2); sent only when known. */
  media: { url: string; mimeType: string; fileName: string | null; sizeBytes: number | null; durationSeconds?: number | null } | null
  senderName: string | null
  /** The gateway id of the message being quoted (contract 1.2): sent only when set. */
  replyToServerId?: string | null
}

/** A refusal or failure from the gateway, in the contract's terms. */
export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** True for 429 / 5xx / no answer: a resend may work. */
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

function allowLocal(): boolean {
  return process.env.VIRCLE_CHAT_ALLOW_LOCAL_GATEWAY === 'true'
}

/**
 * A gateway address a workspace may save: https, a host, no credentials,
 * query or fragment. Returns the address without a trailing slash, or an
 * error message. (`http://localhost` is accepted only when the deployment
 * allows a local gateway.)
 */
export function normalizeGatewayUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'Enter the gateway address, for example https://chat-gateway.example.com' }
  }
  const local = allowLocal() && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    return { ok: false, error: 'The gateway address must start with https://' }
  }
  if (u.username || u.password) return { ok: false, error: 'The gateway address must not contain a username or password' }
  if (u.search || u.hash) return { ok: false, error: 'The gateway address must not contain a query or fragment' }
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') }
}

async function call(conn: GatewayConnection, path: string, init: RequestInit): Promise<Response> {
  const url = `${conn.baseUrl}${path}`
  const options: RequestInit = {
    ...init,
    headers: { authorization: `Bearer ${conn.apiToken}`, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  try {
    // A local gateway is only reachable when the deployment says so; otherwise the pinned, address-checked path.
    return allowLocal() ? await fetch(url, { redirect: 'manual', ...options }) : await pinnedFetch(url, options)
  } catch {
    throw new GatewayError('unreachable', 'The chat gateway could not be reached', 0, true)
  }
}

/** Send one message. Resolves with what the gateway did, or throws a GatewayError. */
export async function sendToGateway(conn: GatewayConnection, msg: GatewaySend): Promise<GatewayAccepted> {
  const body: Record<string, unknown> = {
    recipient: {
      wallet_id: msg.walletId,
      ...(msg.contact.name ? { name: msg.contact.name } : {}),
      ...(msg.contact.phone ? { phone: msg.contact.phone } : {}),
      ...(msg.contact.email ? { email: msg.contact.email } : {}),
    },
    type: msg.type,
    ...(msg.conversationId ? { conversation_id: msg.conversationId } : {}),
    ...(msg.text ? { text: msg.text } : {}),
    ...(msg.senderName ? { sender: { name: msg.senderName } } : {}),
    ...(msg.replyToServerId ? { reply_to_server_id: msg.replyToServerId } : {}),
    ...(msg.media
      ? {
          media: {
            url: msg.media.url,
            mime_type: msg.media.mimeType,
            ...(msg.media.fileName ? { file_name: msg.media.fileName } : {}),
            ...(msg.media.sizeBytes !== null ? { size_bytes: msg.media.sizeBytes } : {}),
            ...(typeof msg.media.durationSeconds === 'number' ? { duration_seconds: msg.media.durationSeconds } : {}),
          },
        }
      : {}),
  }
  const res = await call(conn, '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': msg.idempotencyKey },
    body: JSON.stringify(body),
  })
  const parsed = await res.json().catch(() => null)

  if (res.status === 202 || res.status === 200) {
    const accepted = parseGatewayAccepted(parsed)
    if (accepted) return accepted
    throw new GatewayError('bad_response', 'The chat gateway accepted the message but did not say how', res.status, true)
  }

  throw refusal(res, parsed)
}

/** The GatewayError for a non-2xx answer, in the contract's terms (429 and 5xx are retryable). */
function refusal(res: Response, parsed: unknown): GatewayError {
  const err = parseGatewayError(parsed)
  const retryAfter = Number(res.headers.get('retry-after'))
  return new GatewayError(
    err.code,
    err.message,
    res.status,
    res.status === 429 || res.status >= 500,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  )
}

/**
 * Tell the gateway an agent has read these messages of the user's (contract 4.1, `POST /v1/receipts`).
 * Resolves with how many the gateway updated; throws a GatewayError when it refuses or cannot be reached.
 * The call is a repeat-safe one: a status only moves forward, so a resend changes nothing.
 */
export async function sendReadReceipts(conn: GatewayConnection, walletId: string, serverIds: string[]): Promise<number> {
  const res = await call(conn, '/v1/receipts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { wallet_id: walletId }, status: 'read', server_ids: serverIds }),
  })
  const parsed = await res.json().catch(() => null)
  if (res.status === 202 || res.status === 200) {
    const updated = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).updated : null
    return typeof updated === 'number' && Number.isFinite(updated) ? updated : serverIds.length
  }
  throw refusal(res, parsed)
}

/**
 * Tell the gateway an agent is typing to this user (contract 4.2, `POST /v1/typing`).
 * Resolves with the number of live connections it reached (0 when the app is closed).
 */
export async function sendTyping(conn: GatewayConnection, walletId: string): Promise<number> {
  const res = await call(conn, '/v1/typing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { wallet_id: walletId } }),
  })
  const parsed = await res.json().catch(() => null)
  if (res.status === 202 || res.status === 200) {
    const delivered = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).delivered_to : null
    return typeof delivered === 'number' && Number.isFinite(delivered) ? delivered : 0
  }
  throw refusal(res, parsed)
}

/** Halo's "Test connection": GET /v1/health with the token. */
export async function checkGatewayHealth(conn: GatewayConnection): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await call(conn, '/v1/health', { method: 'GET' })
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'The gateway refused the API token' }
    return { ok: false, error: `The gateway answered ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof GatewayError ? err.message : 'The chat gateway could not be reached' }
  }
}

