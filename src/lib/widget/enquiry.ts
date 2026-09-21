// ============================================================
// Web Widget v2 — the enquiry form ("I am new here"): request validation
// and the first-message text. Pure, so the rules are unit-tested.
//
// Form: name; phone OR email (at least one); "I am a" parent | school |
// merchant | other; message; consent tick.
// ============================================================
import { normalizeEmail, normalizeIdentityPhone } from '@/lib/widget/identity-token'

export const ENQUIRY_ROLES = ['parent', 'school', 'merchant', 'other'] as const
export type EnquiryRole = (typeof ENQUIRY_ROLES)[number]

export const WIDGET_LOCALES = ['en', 'ms', 'zh'] as const
export type WidgetLocale = (typeof WIDGET_LOCALES)[number]

export const ENQUIRY_NAME_MAX = 120
export const ENQUIRY_MESSAGE_MAX = 2000

export function parseLocale(raw: unknown): WidgetLocale {
  return typeof raw === 'string' && (WIDGET_LOCALES as readonly string[]).includes(raw)
    ? (raw as WidgetLocale)
    : 'en'
}

export interface ParsedEnquiry {
  name: string
  phone: string | null
  email: string | null
  role: EnquiryRole
  message: string
  locale: WidgetLocale
}

export type EnquiryParseResult =
  | { ok: true; value: ParsedEnquiry }
  | { ok: false; error: string; code: 'bad_request' | 'invalid_claim' }

export function parseEnquiryBody(raw: unknown): EnquiryParseResult {
  const fail = (error: string, code: 'bad_request' | 'invalid_claim' = 'bad_request'): EnquiryParseResult => ({
    ok: false,
    error,
    code,
  })
  if (!raw || typeof raw !== 'object') return fail('Invalid request body')
  const b = raw as Record<string, unknown>

  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > ENQUIRY_NAME_MAX) return fail(`name is required (1-${ENQUIRY_NAME_MAX} characters)`)

  const rawPhone = typeof b.phone === 'string' ? b.phone.trim() : ''
  const rawEmail = typeof b.email === 'string' ? b.email.trim() : ''
  if (!rawPhone && !rawEmail) return fail('Provide a phone number or an email address', 'invalid_claim')

  let phone: string | null = null
  if (rawPhone) {
    phone = normalizeIdentityPhone(rawPhone)
    if (!phone) return fail('Enter a valid phone number', 'invalid_claim')
  }
  let email: string | null = null
  if (rawEmail) {
    email = normalizeEmail(rawEmail)
    if (!email) return fail('Enter a valid email address', 'invalid_claim')
  }

  if (typeof b.role !== 'string' || !(ENQUIRY_ROLES as readonly string[]).includes(b.role)) {
    return fail('role must be one of parent, school, merchant, other')
  }
  const role = b.role as EnquiryRole

  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (!message || message.length > ENQUIRY_MESSAGE_MAX) {
    return fail(`message is required (1-${ENQUIRY_MESSAGE_MAX} characters)`)
  }

  if (b.consent !== true) return fail('Consent is required to send an enquiry')

  return { ok: true, value: { name, phone, email, role, message, locale: parseLocale(b.locale) } }
}

const ROLE_LABEL: Record<EnquiryRole, string> = {
  parent: 'Parent',
  school: 'School',
  merchant: 'Merchant',
  other: 'Other',
}

/** First customer message of an enquiry: a short header line, then the text. */
export function enquiryMessageText(role: EnquiryRole, message: string): string {
  return `[Web enquiry - ${ROLE_LABEL[role]}]\n${message}`
}
