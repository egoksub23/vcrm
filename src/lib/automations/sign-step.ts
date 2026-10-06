// ------------------------------------------------------------
// The "Send a document for signing" automation step: its configuration, the
// checks that can be made on it, and what it needs from the template. Pure and
// dependency-light so the validator, the builder (client) and the runner share
// it. The running itself is in ./send-sign-document.ts.
// ------------------------------------------------------------

import { SIGN_LOCALES } from '@/lib/sign/types'
import type { SignRole } from '@/lib/sign/types'
import type { SendSignDocumentRecipient, SendSignDocumentStepConfig } from '@/types'
import type { PlacedField } from '@/lib/sign/pdf/types'
import type { FormDefinition } from '@/lib/sign/forms/types'
import { fieldsForRole } from '@/lib/sign/rules'

export const MAX_SIGN_RECIPIENTS = 20
export const MAX_MERGE_VALUES = 200
export const MAX_MERGE_VALUE_CHARS = 2000
/** The same pattern a draft's merge values are held to (drafts.ts `updateDraft`). */
export const MERGE_KEY_RE = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const hasVariable = (s: string) => /\{\{[^}]*\}\}/.test(s)

export interface SignStepIssue {
  path: string
  message: string
}

/** What the activation check learned about the template the step names. */
export interface SignTemplateSetup {
  found: boolean
  active: boolean
  /** The roles of the template's current version. */
  roles: Pick<SignRole, 'key' | 'kind' | 'label'>[]
  /** Roles that need a person before the document can be sent. */
  requiredRoles: string[]
}

export interface SignSetup {
  /** Doc Sign is on for the workspace (operator flag, and the workspace is active). */
  enabled: boolean
  templates: Record<string, SignTemplateSetup>
}

/**
 * The roles a document made from this template cannot be sent without: a role with something to fill in or
 * sign on the page, or with a part of the form (the same two rules `sendDocument` applies).
 */
export function requiredRoleKeys(version: { roles: readonly SignRole[]; fields: readonly PlacedField[]; form?: FormDefinition | null }): string[] {
  const out = new Set<string>()
  for (const r of version.roles) {
    if (fieldsForRole(version.fields, r.key).length > 0) out.add(r.key)
  }
  for (const p of version.form?.parts ?? []) out.add(p.role)
  // a role that is not in the template's role list cannot be filled anyway
  return version.roles.map((r) => r.key).filter((k) => out.has(k))
}

/** Static checks: they need nothing but the step's own configuration. */
export function checkSendSignDocument(c: Record<string, unknown>, path: string, setup?: SignSetup): SignStepIssue[] {
  const issues: SignStepIssue[] = []
  const add = (p: string, message: string) => issues.push({ path: `${path}.${p}`, message })

  const templateId = typeof c.template_id === 'string' ? c.template_id.trim() : ''
  if (!templateId) add('template_id', 'a Doc Sign template is required')

  const recipients = Array.isArray(c.recipients) ? (c.recipients as Record<string, unknown>[]) : []
  if (recipients.length === 0) add('recipients', 'at least one recipient is required')
  if (recipients.length > MAX_SIGN_RECIPIENTS) add('recipients', `a document can have up to ${MAX_SIGN_RECIPIENTS} people`)
  recipients.forEach((r, i) => {
    const at = `recipients[${i}]`
    if (typeof r?.role_key !== 'string' || !r.role_key.trim()) add(`${at}.role_key`, 'a role is required for each recipient')
    if (r?.source !== 'contact' && r?.source !== 'fixed') add(`${at}.source`, 'a recipient is either the contact or a fixed person')
    if (r?.channel !== 'email' && r?.channel !== 'whatsapp') add(`${at}.channel`, 'send by email or WhatsApp')
    if (r?.source === 'fixed') {
      const name = typeof r.full_name === 'string' ? r.full_name.trim() : ''
      const email = typeof r.email === 'string' ? r.email.trim() : ''
      if (!name) add(`${at}.full_name`, 'a full name is required for a fixed recipient')
      if (!email) add(`${at}.email`, 'an email is required for a fixed recipient')
      else if (!hasVariable(email) && !EMAIL_RE.test(email)) add(`${at}.email`, 'the recipient email is not valid')
      if (r.channel === 'whatsapp' && !(typeof r.phone === 'string' && r.phone.trim())) add(`${at}.phone`, 'a phone number is required to send by WhatsApp')
    }
  })

  if (c.merge_values !== undefined) {
    const mv = c.merge_values
    if (typeof mv !== 'object' || mv === null || Array.isArray(mv)) add('merge_values', 'merge values must be a list of names and values')
    else {
      const entries = Object.entries(mv as Record<string, unknown>)
      if (entries.length > MAX_MERGE_VALUES) add('merge_values', `at most ${MAX_MERGE_VALUES} merge values`)
      for (const [k, v] of entries) {
        if (!MERGE_KEY_RE.test(k)) add(`merge_values.${k}`, `"${k}" is not a valid merge field name`)
        else if (typeof v !== 'string') add(`merge_values.${k}`, `the value of "${k}" must be text`)
        else if (v.length > MAX_MERGE_VALUE_CHARS) add(`merge_values.${k}`, `the value of "${k}" is too long`)
      }
    }
  }
  if (c.send !== undefined && typeof c.send !== 'boolean') add('send', 'send must be on or off')
  if (c.locale !== undefined && c.locale !== '' && !SIGN_LOCALES.includes(c.locale as never)) add('locale', 'choose English, Bahasa Melayu, Chinese or Korean')
  if (c.title !== undefined && typeof c.title !== 'string') add('title', 'the title must be text')
  if (c.message !== undefined && typeof c.message !== 'string') add('message', 'the message must be text')

  if (setup) {
    if (!setup.enabled) add('template_id', 'Doc Sign is not turned on for this workspace')
    else if (templateId) {
      const t = setup.templates[templateId]
      if (!t?.found) add('template_id', 'that Doc Sign template no longer exists')
      else if (!t.active) add('template_id', 'that Doc Sign template is not active: publish it first')
      else {
        const have = new Set(t.roles.map((r) => r.key))
        recipients.forEach((r, i) => {
          if (typeof r?.role_key === 'string' && r.role_key.trim() && !have.has(r.role_key)) add(`recipients[${i}].role_key`, `the template has no role "${r.role_key}"`)
        })
        const covered = new Set(recipients.map((r) => r?.role_key))
        for (const key of t.requiredRoles) {
          if (!covered.has(key)) add('recipients', `the template needs a recipient for the role "${t.roles.find((x) => x.key === key)?.label ?? key}"`)
        }
      }
    }
  }
  return issues
}

/** A recipient list cleaned for running: only the fields the runner reads. */
export function recipientsOf(cfg: Partial<SendSignDocumentStepConfig>): SendSignDocumentRecipient[] {
  return (Array.isArray(cfg.recipients) ? cfg.recipients : []).filter((r): r is SendSignDocumentRecipient => !!r && typeof r === 'object')
}
