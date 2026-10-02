// ============================================================
// Signing for the Vircle Chat webhook (docs/vircle-chat-contract.md, section 2).
//
//   X-Vircle-Timestamp: <seconds since the epoch>
//   X-Vircle-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
//
// The timestamp is inside the signed text, so an old request cannot be given a
// fresh timestamp; Halo also refuses one more than five minutes from its own
// clock and remembers every event id (see the webhook route), so a captured
// request cannot be replayed.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_TOLERANCE_SECONDS = 300
export const TIMESTAMP_HEADER = 'x-vircle-timestamp'
export const SIGNATURE_HEADER = 'x-vircle-signature'

/** The `X-Vircle-Signature` value for a body sent at `timestampSeconds`. */
export function signBody(secret: string, timestampSeconds: number | string, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex')
  return `sha256=${digest}`
}

export type SignatureCheck = 'ok' | 'missing' | 'bad_timestamp' | 'stale' | 'bad_signature'

/**
 * Check a webhook request. `rawBody` must be the exact text received, never a
 * re-serialised parse of it. Constant-time on the signature.
 */
export function verifySignature(args: {
  secret: string
  timestampHeader: string | null
  signatureHeader: string | null
  rawBody: string
  nowSeconds?: number
}): SignatureCheck {
  const { secret, timestampHeader, signatureHeader, rawBody } = args
  if (!timestampHeader || !signatureHeader) return 'missing'
  if (!/^\d{1,12}$/.test(timestampHeader)) return 'bad_timestamp'
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestampHeader)) > SIGNATURE_TOLERANCE_SECONDS) return 'stale'

  const expected = Buffer.from(signBody(secret, timestampHeader, rawBody))
  const given = Buffer.from(signatureHeader.trim())
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad_signature'
  return 'ok'
}
