// ============================================================
// POST /api/vircle-chat/webhook
//
// Where the Vircle chat gateway tells Halo what its users did
// (docs/vircle-chat-contract.md, section 3): a message arrived, or a message
// Halo sent was delivered / read / refused by the app, or the user is typing
// (ephemeral: broadcast to the open Inbox thread, nothing stored).
//
// Order of checks, each cheaper than the next and none believing the body:
//   1. an address that keeps failing is turned away before any database work;
//   2. the body is read RAW (the signature covers the exact bytes);
//   3. the workspace is found from `workspace_key` and the signature is checked
//      with THAT workspace's secret, inside a five-minute window;
//   4. only then is the payload read, the channel's pause switch and the
//      operator's feature flag honoured, and the event processed.
// A paused or switched-off workspace answers 200 so the gateway does not retry
// for ever; a real failure answers 5xx so it does.
// ============================================================
import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { clientIp } from '@/lib/net/client-ip'
import { checkRateLimit, isRateLimited, RATE_LIMITS } from '@/lib/rate-limit'
import { checkSharedRateLimit } from '@/lib/rate-limit-shared'
import { findConfigByKey, openConfig } from '@/lib/vircle-chat/config'
import { parseWebhookEvent } from '@/lib/vircle-chat/contract'
import { applyReceipt, ingestInbound } from '@/lib/vircle-chat/events'
import { vircleChatEnabled } from '@/lib/vircle-chat/feature'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from '@/lib/vircle-chat/signing'
import { broadcastUserTyping } from '@/lib/vircle-chat/typing'

export const maxDuration = 60

const MAX_BODY_BYTES = 256 * 1024
/** How long a handled event id is remembered (the gateway retries for about a day). */
const EVENT_MEMORY_DAYS = 30

const json = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  NextResponse.json(body, { status, headers })

export async function POST(request: Request) {
  const caller = clientIp(request.headers)
  const badKey = `vircle-bad:${caller}`
  if (caller !== 'unknown' && isRateLimited(badKey, RATE_LIMITS.webhookInvalid)) {
    return json(429, { error: 'Too many invalid requests' }, { 'Retry-After': '60' })
  }
  const reject = (status: 401 | 400, error: string) => {
    if (status === 401 && caller !== 'unknown') checkRateLimit(badKey, RATE_LIMITS.webhookInvalid)
    return json(status, { error })
  }

  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: 'Request too large' })

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return reject(400, 'Body is not JSON')
  }
  const workspaceKey =
    body && typeof body === 'object' && typeof (body as Record<string, unknown>).workspace_key === 'string'
      ? ((body as Record<string, unknown>).workspace_key as string)
      : ''

  const admin = supabaseAdmin()
  const row = workspaceKey ? await findConfigByKey(admin, workspaceKey) : null
  // An unknown workspace key and a wrong signature look the same from outside.
  if (!row) return reject(401, 'Invalid signature')

  let secrets
  try {
    secrets = openConfig(row)
  } catch (err) {
    console.error('[vircle-chat] cannot decrypt the connection secrets for', row.account_id, err)
    return json(500, { error: 'Connection is misconfigured' })
  }
  const check = verifySignature({
    secret: secrets.signingSecret,
    timestampHeader: request.headers.get(TIMESTAMP_HEADER),
    signatureHeader: request.headers.get(SIGNATURE_HEADER),
    rawBody,
  })
  if (check !== 'ok') {
    console.warn(`[vircle-chat] rejected a request (${check}) for workspace ${row.account_id}`)
    return reject(401, 'Invalid signature')
  }

  const parsed = parseWebhookEvent(body)
  if (!parsed.ok && 'error' in parsed) return json(400, { error: 'invalid_payload', detail: parsed.error })
  if ('ignored' in parsed) return json(200, { ok: true, ignored: parsed.ignored })
  const { event } = parsed

  // One workspace cannot flood the system with valid events.
  const limit = await checkSharedRateLimit(`vircle-in:${row.account_id}`, RATE_LIMITS.vircleInbound)
  if (!limit.success) {
    return json(429, { error: 'Rate limited' }, { 'Retry-After': String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))) })
  }

  if (!row.enabled || !(await vircleChatEnabled(admin, row.account_id))) {
    return json(200, { ok: true, ignored: 'paused' })
  }

  // "The user is typing" (contract 3.4) is ephemeral: no event-id memory, nothing stored, never
  // retried. A failed broadcast is logged and still answered 200, because a late "typing..." is useless.
  if (event.kind === 'user.typing') {
    try {
      await broadcastUserTyping(admin, row.account_id, event)
    } catch (err) {
      console.error('[vircle-chat] typing broadcast failed:', err instanceof Error ? err.message : err)
    }
    return json(200, { ok: true })
  }

  // An event handled before (a retry, or a replay inside the window) does nothing twice.
  const { data: seen, error: seenError } = await admin
    .from('vircle_chat_events')
    .select('event_id')
    .eq('account_id', row.account_id)
    .eq('event_id', event.eventId)
    .maybeSingle()
  if (seenError) {
    console.error('[vircle-chat] event lookup failed:', seenError.message)
    return json(500, { error: 'Temporary failure' })
  }
  if (seen) return json(200, { ok: true, duplicate: true })

  try {
    let responseBody: Record<string, unknown>
    if (event.kind === 'message.inbound') {
      const result = await ingestInbound(admin, row, event)
      if (result.status === 'stored') {
        after(() => result.fanOut().catch((err) => console.error('[vircle-chat] fan-out failed:', err)))
        responseBody = { ok: true, message_id: result.messageId }
      } else {
        responseBody = { ok: true, duplicate: true, message_id: result.messageId }
      }
    } else {
      const result = await applyReceipt(admin, row, event)
      responseBody = { ok: true, receipt: result.status }
    }

    await admin.from('vircle_chat_events').upsert(
      { account_id: row.account_id, event_id: event.eventId },
      { onConflict: 'account_id,event_id', ignoreDuplicates: true },
    )
    await admin
      .from('vircle_chat_config')
      .update({ ...(event.kind === 'message.inbound' ? { last_inbound_at: new Date().toISOString() } : {}), last_error: null })
      .eq('id', row.id)
    // A small share of requests tidy the memory of old event ids.
    if (Math.random() < 0.01) {
      const cutoff = new Date(Date.now() - EVENT_MEMORY_DAYS * 24 * 3600 * 1000).toISOString()
      await admin.from('vircle_chat_events').delete().lt('received_at', cutoff)
    }
    return json(200, responseBody)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[vircle-chat] event failed:', message)
    await admin.from('vircle_chat_config').update({ last_error: message.slice(0, 300) }).eq('id', row.id)
    // 5xx: the gateway retries the same event id.
    return json(500, { error: 'Temporary failure' })
  }
}
