// ------------------------------------------------------------
// Doc Sign events as an automation trigger: the vocabulary, the context a run
// carries, how a trigger's configuration matches an event, and the loop guard.
//
// Pure and dependency-free so the engine, the validator, the builder (client)
// and the emitter (src/lib/sign/service/outbound.ts) share it.
// ------------------------------------------------------------

import type { SignDocumentEventTriggerConfig, SignEventName } from '@/types'

/** Every event, in the order a document meets them. The webhooks are `sign.<name>`. */
export const SIGN_EVENT_NAMES: readonly SignEventName[] = ['sent', 'viewed', 'completed', 'declined', 'expired', 'voided']

export function isSignEventName(v: unknown): v is SignEventName {
  return typeof v === 'string' && (SIGN_EVENT_NAMES as readonly string[]).includes(v)
}

/** What the trigger fires on when none is chosen. */
export const DEFAULT_SIGN_EVENTS: readonly SignEventName[] = ['completed']

/**
 * What a Sign-event run carries (`AutomationContext.sign`) and what `{{ sign.* }}`
 * reads. Never holds an email, a phone number or a link token.
 */
export interface SignEventContext {
  document_id: string
  reference: string
  title: string
  status: string
  event: SignEventName
  /** The template's name, empty when the document was not made from one. */
  template: string
  template_id: string
  category_id: string
  /** Only for completed. */
  final_sha256: string
  /** Only for completed, and only when the certificate is a file of its own (migration 178); empty for a document sealed before it. */
  certificate_sha256?: string
  /** The public page that proves the signed file is genuine (completed only). */
  verify_url: string
}

/** The names `{{ sign.<name> }}` resolves, for the "Insert variable" list. */
export const SIGN_VARIABLES = ['document_id', 'reference', 'title', 'status', 'event', 'template', 'final_sha256', 'certificate_sha256', 'verify_url'] as const

/** The events a trigger configuration listens to (empty or missing = completed only). */
export function eventsOf(cfg: SignDocumentEventTriggerConfig | null | undefined): SignEventName[] {
  const raw = Array.isArray(cfg?.events) ? cfg!.events.filter(isSignEventName) : []
  return raw.length > 0 ? [...new Set(raw)] : [...DEFAULT_SIGN_EVENTS]
}

/** Whether an automation with this trigger configuration fires for this event. */
export function signEventMatches(cfg: SignDocumentEventTriggerConfig | null | undefined, sign: SignEventContext | undefined): boolean {
  if (!sign) return false
  if (!eventsOf(cfg).includes(sign.event)) return false
  const template = typeof cfg?.template_id === 'string' ? cfg.template_id.trim() : ''
  if (template && template !== sign.template_id) return false
  const category = typeof cfg?.category_id === 'string' ? cfg.category_id.trim() : ''
  if (category && category !== sign.category_id) return false
  return true
}

// ---- loop guard ---------------------------------------------------------------------------------------

/**
 * An automation started by a Doc Sign event can send another document, which is itself an event. Like the tag
 * chain, the depth travels in `vars._sign_chain_depth` and stops growing at this many links.
 */
export const MAX_SIGN_CHAIN_DEPTH = 3
export const SIGN_CHAIN_VAR = '_sign_chain_depth'

export function getSignChainDepth(vars: Record<string, unknown> | undefined): number {
  const raw = vars?.[SIGN_CHAIN_VAR]
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
}
