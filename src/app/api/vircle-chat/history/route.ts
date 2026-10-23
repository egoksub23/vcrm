// ============================================================
// POST /api/vircle-chat/history
//
// The gateway asks Halo for older messages of one person, or for a fresh download address of the file in one of them
// (docs/vircle-chat-contract.md, section 3.5). A READ: signed exactly like the webhook, nothing stored, no event id remembered.
//
// Same order of checks as the webhook, each cheaper than the next and none believing the body:
//   1. an address that keeps failing is turned away before any database work;
//   2. the body is read RAW (the signature covers the exact bytes);
//   3. the workspace is found from `workspace_key` and the signature is checked with THAT workspace's secret, inside a five-minute window;
//   4. only then is the request read, the pause switch and the operator's feature flag honoured, and the answer built.
// A paused or switched-off workspace answers 200 `ignored` so the gateway shows an empty page; a real failure answers 5xx.
// ============================================================
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { clientIp } from '@/lib/net/client-ip'
import { checkRateLimit, isRateLimited, RATE_LIMITS } from '@/lib/rate-limit'
import { checkSharedRateLimit } from '@/lib/rate-limit-shared'
import { findConfigByKey, openConfig } from '@/lib/vircle-chat/config'
import { vircleChatEnabled } from '@/lib/vircle-chat/feature'
import { answerHistoryFile, answerHistoryPage, parseHistoryRequest } from '@/lib/vircle-chat/history'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from '@/lib/vircle-chat/signing'

export const maxDuration = 30

const MAX_BODY_BYTES = 16 * 1024

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
    console.warn(`[vircle-chat] rejected a history request (${check}) for workspace ${row.account_id}`)
    return reject(401, 'Invalid signature')
  }

  const parsed = parseHistoryRequest(body)
  if (!parsed.ok) return json(400, { error: 'invalid_payload', detail: parsed.error })
  const req = parsed.request

  // One workspace cannot flood the system with valid requests.
  const limit = await checkSharedRateLimit(`vircle-hist:${row.account_id}`, RATE_LIMITS.vircleHistory)
  if (!limit.success) {
    return json(429, { error: 'Rate limited' }, { 'Retry-After': String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))) })
  }

  try {
    if (!row.enabled || !(await vircleChatEnabled(admin, row.account_id))) {
      return json(200, { ok: true, ignored: 'paused' })
    }
    if (req.kind === 'file') {
      const answer = await answerHistoryFile(admin, row, req)
      return answer ? json(200, answer as unknown as Record<string, unknown>) : json(404, { error: 'not_found' })
    }
    const page = await answerHistoryPage(admin, row, req)
    return json(200, { messages: page.messages, more: page.more, ...(page.more ? {} : { end: page.end }) })
  } catch (err) {
    console.error('[vircle-chat] history failed:', err instanceof Error ? err.message : err)
    return json(503, { error: 'Temporary failure' }, { 'Retry-After': '10' })
  }
}
