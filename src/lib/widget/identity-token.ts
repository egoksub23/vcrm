// ============================================================
// Signed in-app identity for the web widget (Web Widget v2).
//
// A host app (a Vircle mobile app WebView, or any site with its own
// login) proves who its signed-in user is by handing the widget a token
// its own BACKEND signed with the workspace's secret:
//
//   token   = base64url(payloadJson) + '.' + base64url(HMAC_SHA256(secret, base64url(payloadJson)))
//   payload = { phone?, email?, walletId?, name?, iat }        (iat = unix seconds)
//
// The secret never reaches a browser. Only a holder of the secret can
// mint a token that verifies, so a valid token is the one thing that
// makes a widget visitor "verified" (the only level that may merge two
// real contacts automatically). Pure: no I/O, no clock other than the
// `nowSeconds` argument, so it is fully unit-testable.
// ============================================================
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

/** A token stays valid for this long after `iat`... */
export const IDENTITY_TOKEN_MAX_AGE_SECONDS = 10 * 60
/** ...and may be stamped this far in the future (clock skew between servers). */
export const IDENTITY_TOKEN_MAX_SKEW_SECONDS = 60

const NAME_MAX_LEN = 120
const WALLET_ID_MAX_LEN = 128
const EMAIL_MAX_LEN = 254
const TOKEN_MAX_LEN = 4096

// Deliberately permissive: one @, something either side, a dot in the
// domain, no whitespace. Deliverability is not our job here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface IdentityPayload {
  /** Digits only (E.164 without the plus), as the rest of the app stores phones. */
  phone?: string
  /** Lower-cased. */
  email?: string
  walletId?: string
  name?: string
  iat: number
}

export type IdentityTokenResult =
  | { ok: true; payload: IdentityPayload }
  | { ok: false; error: 'bad_identity_token' | 'expired_identity_token' }

/** Normalise a typed or signed email; null when it is not an email. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if (!v || v.length > EMAIL_MAX_LEN || !EMAIL_RE.test(v)) return null
  return v
}

/** Normalise a typed or signed phone to digits; null when it is not E.164-like. */
export function normalizeIdentityPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = sanitizePhoneForMeta(raw.trim())
  return isValidE164(digits) ? digits : null
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest()
}

/** Generate a fresh workspace secret. Shown to the admin exactly once. */
export function generateIdentitySecret(): string {
  return `wis_${randomBytes(32).toString('base64url')}`
}

/**
 * Mint a token. Used by the admin-only preview route and by tests; a real
 * host app does this itself (see the snippets in docs/web-chat-widget.md).
 */
export function signIdentityToken(
  secret: string,
  claims: { phone?: string; email?: string; walletId?: string; name?: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload: Record<string, unknown> = { iat: nowSeconds }
  if (claims.phone) payload.phone = claims.phone
  if (claims.email) payload.email = claims.email
  if (claims.walletId) payload.walletId = claims.walletId
  if (claims.name) payload.name = claims.name
  const encoded = b64url(JSON.stringify(payload))
  return `${encoded}.${b64url(sign(secret, encoded))}`
}

/**
 * Verify a token against the workspace secret.
 *
 * `bad_identity_token`     — malformed, wrong signature, or no usable identifier.
 * `expired_identity_token` — signature fine but `iat` is outside the accepted window.
 * The signature is checked (constant time) BEFORE the payload is trusted at all.
 */
export function verifyIdentityToken(
  token: unknown,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): IdentityTokenResult {
  const bad = { ok: false, error: 'bad_identity_token' } as const
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX_LEN || !secret) return bad

  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return bad
  const [encoded, givenSig] = parts

  const expected = sign(secret, encoded)
  let given: Buffer
  try {
    given = Buffer.from(givenSig, 'base64url')
  } catch {
    return bad
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return bad

  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return bad
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad
  const p = raw as Record<string, unknown>

  const iat = p.iat
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return bad

  const phone = p.phone === undefined || p.phone === null || p.phone === '' ? null : normalizeIdentityPhone(p.phone)
  if (p.phone && phone === null) return bad
  const email = p.email === undefined || p.email === null || p.email === '' ? null : normalizeEmail(p.email)
  if (p.email && email === null) return bad
  const walletId =
    typeof p.walletId === 'string' && p.walletId.trim() ? p.walletId.trim().slice(0, WALLET_ID_MAX_LEN) : null
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, NAME_MAX_LEN) : null

  if (!phone && !email && !walletId) return bad

  const age = nowSeconds - iat
  if (age > IDENTITY_TOKEN_MAX_AGE_SECONDS || age < -IDENTITY_TOKEN_MAX_SKEW_SECONDS) {
    return { ok: false, error: 'expired_identity_token' }
  }

  const payload: IdentityPayload = { iat }
  if (phone) payload.phone = phone
  if (email) payload.email = email
  if (walletId) payload.walletId = walletId
  if (name) payload.name = name
  return { ok: true, payload }
}
