// ============================================================
// Signing of what the gateway sends to Halo (docs/vircle-chat-contract.md, section 2):
//
//   X-Vircle-Timestamp: <seconds since the epoch>
//   X-Vircle-Signature: sha256=<hex HMAC-SHA256(signing_secret, "<timestamp>.<raw body>")>
//
// The signature covers the exact bytes sent, so the body is serialised once and those same
// bytes go on the wire. The timestamp is taken afresh for every attempt: an event retried
// hours later must still fall inside Halo's five-minute window.
// ============================================================

import { createHmac } from 'node:crypto'

export function signBody(secret: string, timestampSeconds: number | string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex')}`
}

export function signedHeaders(secret: string, rawBody: string, nowMs: number): Record<string, string> {
  const ts = Math.floor(nowMs / 1000)
  return {
    'content-type': 'application/json',
    'x-vircle-timestamp': String(ts),
    'x-vircle-signature': signBody(secret, ts, rawBody),
  }
}
