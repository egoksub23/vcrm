// ============================================================
// Web Widget v2 — the 200 body shared by POST /api/widget/session and
// POST /api/widget/enquiry (the contract says they answer identically).
// ============================================================
import { widgetLimits } from '@/lib/widget/media'
import type { IdentityLevel } from '@/lib/widget/identity-resolve'

export type VerificationMode = 'none' | 'email_code' | 'whatsapp_code'

export interface WidgetConfigRow {
  name: string
  welcome_message: string
  primary_color: string
  avatar_url: string | null
  position: string
  verification_mode?: string | null
}

export function brandingOf(config: WidgetConfigRow) {
  return {
    name: config.name,
    welcomeMessage: config.welcome_message,
    primaryColor: config.primary_color,
    avatarUrl: config.avatar_url,
    position: config.position,
  }
}

export function verificationOf(config: WidgetConfigRow): { mode: VerificationMode } {
  const m = config.verification_mode
  return { mode: m === 'email_code' || m === 'whatsapp_code' ? m : 'none' }
}

/** The "brand-new browser, nothing offered" answer. */
export function needsIdentityBody(config: WidgetConfigRow, identityError?: string) {
  return {
    needsIdentity: true,
    needsPhone: true,
    ...(identityError ? { identityError } : {}),
    branding: brandingOf(config),
    verification: verificationOf(config),
    limits: widgetLimits(),
  }
}

export function sessionBody(args: {
  config: WidgetConfigRow
  conversationId: string
  level: IdentityLevel
  hasPhone: boolean
  hasEmail: boolean
  displayName: string | null
  identityError?: string
  claimFound?: boolean
}) {
  return {
    needsIdentity: false,
    needsPhone: false,
    conversationId: args.conversationId,
    identity: {
      level: args.level,
      hasPhone: args.hasPhone,
      hasEmail: args.hasEmail,
      displayName: args.displayName,
    },
    isGuest: args.level === 'guest',
    ...(args.identityError ? { identityError: args.identityError } : {}),
    ...(args.claimFound !== undefined ? { claimFound: args.claimFound } : {}),
    branding: brandingOf(args.config),
    verification: verificationOf(args.config),
    limits: widgetLimits(),
  }
}
