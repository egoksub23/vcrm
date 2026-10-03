// ============================================================
// The launch token Halo gives an admin who presses "Open simulator" in Settings, Channels.
//
//   <payload>.<signature>
//   payload    base64url of {"k": "<workspace key>", "exp": <unix seconds>, "n": "<random nonce>"}
//   signature  hex HMAC-SHA256(signing secret, "vircle-sim." + payload)
//
// It is signed with the workspace's webhook signing secret, which only Halo and this gateway hold, so a
// valid token proves the caller is a signed-in Halo admin of that workspace (Halo checks the
// `channels.manage` capability before it makes one). It lives five minutes and is used once.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const LAUNCH_TOKEN_TTL_SECONDS = 300

export interface LaunchClaims {
  key: string
  exp: number
  nonce: string
}

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(`vircle-sim.${payload}`).digest('hex')

export function createLaunchToken(secret: string, workspaceKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({ k: workspaceKey, exp: nowSeconds + LAUNCH_TOKEN_TTL_SECONDS, n: randomBytes(12).toString('base64url') })).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

/** The workspace key a token names, before it is verified (to know whose secret to verify it with). */
export function peekWorkspaceKey(token: string): string | null {
  return readClaims(token.split('.')[0] ?? '')?.key ?? null
}

function readClaims(payload: string): LaunchClaims | null {
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { k?: unknown; exp?: unknown; n?: unknown }
    if (typeof body.k !== 'string' || typeof body.exp !== 'number' || typeof body.n !== 'string') return null
    return { key: body.k, exp: body.exp, nonce: body.n }
  } catch {
    return null
  }
}

export type TokenCheck = { ok: true; claims: LaunchClaims } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

export function verifyLaunchToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): TokenCheck {
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: 'malformed' }
  const claims = readClaims(payload)
  if (!claims) return { ok: false, reason: 'malformed' }
  const expected = Buffer.from(sign(secret, payload))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' }
  // A token lives five minutes; one claiming to live much longer was not made by Halo.
  if (claims.exp <= nowSeconds || claims.exp > nowSeconds + LAUNCH_TOKEN_TTL_SECONDS + 60) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
