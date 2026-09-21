// ============================================================
// Web Widget v2 — parsing the POST /api/widget/session body.
//
// Pure: turns whatever a widget (current or an old cached loader.js still
// out in the wild) sent into one normalised shape.
//
// Current inputs:  identityToken, claim {phone,email,name}, skipIdentity,
//                  visitorName, locale.
// LEGACY inputs:   visitorPhone      -> treated as claim.phone (strict: a bad
//                                       number is still a 400, as before)
//                  verifiedIdentity  -> treated as an UNVERIFIED claim
//                                       {phone,email}. A malformed value is a
//                                       host-integration bug, so it is dropped
//                                       silently (as it always was) instead of
//                                       erroring in front of a real customer.
//                  Neither ever makes a visitor "verified" any more.
// ============================================================
import { normalizeEmail, normalizeIdentityPhone } from '@/lib/widget/identity-token'
import { parseLocale, type WidgetLocale } from '@/lib/widget/enquiry'

const NAME_MAX_LEN = 120

export interface SessionClaim {
  phone: string | null
  email: string | null
  name: string | null
  /** From the legacy `verifiedIdentity` field. */
  legacy: boolean
}

export type SessionRequestParse =
  | {
      ok: true
      value: {
        widgetToken: string
        visitorName: string
        identityToken: string | null
        claim: SessionClaim | null
        skipIdentity: boolean
        locale: WidgetLocale
      }
    }
  | { ok: false; status: number; code?: 'bad_request' | 'invalid_claim'; error: string }

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseSessionBody(raw: unknown): SessionRequestParse {
  const b = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const widgetToken = str(b?.widgetToken)
  if (!widgetToken) return { ok: false, status: 400, code: 'bad_request', error: 'widgetToken is required' }

  const visitorName = str(b?.visitorName).slice(0, NAME_MAX_LEN)
  const identityToken = typeof b?.identityToken === 'string' && b.identityToken.trim() ? b.identityToken.trim() : null
  const skipIdentity = b?.skipIdentity === true
  const locale = parseLocale(b?.locale)

  let claim: SessionClaim | null = null

  const rawClaim = b?.claim
  if (rawClaim !== undefined && rawClaim !== null) {
    if (typeof rawClaim !== 'object' || Array.isArray(rawClaim)) {
      return { ok: false, status: 400, code: 'invalid_claim', error: 'claim must be an object' }
    }
    const c = rawClaim as Record<string, unknown>
    const rawPhone = str(c.phone)
    const rawEmail = str(c.email)
    if (!rawPhone && !rawEmail) {
      return { ok: false, status: 400, code: 'invalid_claim', error: 'Provide a phone number or an email address' }
    }
    const phone = rawPhone ? normalizeIdentityPhone(rawPhone) : null
    if (rawPhone && !phone) return { ok: false, status: 400, code: 'invalid_claim', error: 'Enter a valid phone number' }
    const email = rawEmail ? normalizeEmail(rawEmail) : null
    if (rawEmail && !email) return { ok: false, status: 400, code: 'invalid_claim', error: 'Enter a valid email address' }
    claim = { phone, email, name: str(c.name).slice(0, NAME_MAX_LEN) || null, legacy: false }
  } else if (str(b?.visitorPhone)) {
    const phone = normalizeIdentityPhone(str(b?.visitorPhone))
    if (!phone) return { ok: false, status: 400, code: 'invalid_claim', error: 'Enter a valid phone number' }
    claim = { phone, email: null, name: null, legacy: false }
  } else if (b?.verifiedIdentity && typeof b.verifiedIdentity === 'object') {
    const v = b.verifiedIdentity as Record<string, unknown>
    const phone = normalizeIdentityPhone(str(v.phone))
    const email = normalizeEmail(str(v.email))
    if (phone || email) claim = { phone, email, name: null, legacy: true }
  }

  if (claim && !claim.name && visitorName) claim.name = visitorName

  return { ok: true, value: { widgetToken, visitorName, identityToken, claim, skipIdentity, locale } }
}

/** True when the offered claim describes the contact the visitor is already on. */
export function claimMatchesContact(
  contact: { phone?: string | null; email?: string | null },
  claim: { phone: string | null; email: string | null },
): boolean {
  const cPhone = (contact.phone ?? '').replace(/\D/g, '')
  const cEmail = (contact.email ?? '').trim().toLowerCase()
  const phoneOk = !claim.phone || (cPhone !== '' && cPhone.slice(-8) === claim.phone.slice(-8))
  const emailOk = !claim.email || cEmail === claim.email
  return phoneOk && emailOk && (!!claim.phone || !!claim.email)
}

/** A name worth showing back to the visitor; the placeholder is not one. */
export function meaningfulName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim()
  return n && n !== 'Website visitor' ? n : null
}
