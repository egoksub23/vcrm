import type { AiExtractField, AiFieldType } from '@/types'
import {
  AI_EXTRACT_KEY_RE,
  AI_EXTRACT_MAX_CHOICES,
  AI_EXTRACT_MAX_FIELDS,
  AI_EXTRACT_TEXT_MAX_CHARS,
  AI_MESSAGES_DEFAULT,
  AI_MESSAGES_MAX,
  AI_MESSAGES_MIN,
} from './types'

// ============================================================
// Strict parsers for what comes back from the model, and the small text
// helpers the AI steps share. Model output is DATA: it is parsed to a few
// known shapes and anything else is dropped, never trusted.
// ============================================================

/** Cut to at most `max` characters (with an ellipsis when it was longer). */
export function clip(text: string, max: number): string {
  const s = text ?? ''
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** "How many latest messages": whole number in the allowed range, default 10. */
export function clampMessages(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return AI_MESSAGES_DEFAULT
  return Math.min(AI_MESSAGES_MAX, Math.max(AI_MESSAGES_MIN, Math.floor(v)))
}

// ---- Ask AI: yes / no / unsure -------------------------------------------

export type YesNo = 'yes' | 'no' | 'unsure'

/**
 * The model is told to answer with JSON `{"answer":"yes|no|unsure","reason":"..."}`
 * but small models often reply with just "Yes." or "**No** - because ...".
 * Parse both, defensively. Anything that is not clearly yes or no is `unsure`,
 * which the engine treats as "No".
 */
export function parseYesNo(raw: string): { answer: YesNo; reason: string | null } {
  const text = (raw ?? '').trim()
  if (!text) return { answer: 'unsure', reason: null }

  const json = parseJsonObject(text)
  if (json) {
    const answer = toYesNo(json.answer)
    const reason = typeof json.reason === 'string' ? clip(json.reason.trim(), 200) || null : null
    return { answer, reason }
  }

  // "Yes", "yes.", "**Yes**", "Answer: no", "no - because ..."
  const cleaned = text.replace(/[*_`"'“”‘’]/g, '').trim()
  const m = /^(?:answer\s*[:-]\s*)?(yes|no|unsure)\b[\s.,:;!\-–—]*([\s\S]*)$/i.exec(cleaned)
  if (!m) return { answer: 'unsure', reason: null }
  const rest = m[2]?.replace(/^reason\s*[:\-]\s*/i, '').trim()
  return { answer: m[1].toLowerCase() as YesNo, reason: rest ? clip(rest, 200) : null }
}

function toYesNo(v: unknown): YesNo {
  if (v === true) return 'yes'
  if (v === false) return 'no'
  if (typeof v !== 'string') return 'unsure'
  const s = v.trim().toLowerCase().replace(/[.!*_`"']/g, '')
  return s === 'yes' || s === 'no' || s === 'unsure' ? s : 'unsure'
}

// ---- JSON out of model text ----------------------------------------------

/** The first JSON object in model output (it may be fenced or have a preamble). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = (text ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ---- Extract: field definitions and strict validation --------------------

export interface FieldIssue {
  key: string
  message: string
}

const FIELD_TYPES: AiFieldType[] = ['text', 'number', 'date', 'boolean', 'choice']

/**
 * Check the admin's field definitions: up to 8 fields, unique keys of
 * lower-case letters/digits/underscores, a description, a known type, and for
 * `choice` between 1 and 12 non-empty distinct choices.
 */
export function checkExtractFields(fields: unknown): FieldIssue[] {
  const issues: FieldIssue[] = []
  if (!Array.isArray(fields) || fields.length === 0) {
    return [{ key: '', message: 'add at least one field' }]
  }
  if (fields.length > AI_EXTRACT_MAX_FIELDS) {
    issues.push({ key: '', message: `at most ${AI_EXTRACT_MAX_FIELDS} fields` })
  }
  const seen = new Set<string>()
  for (const raw of fields as Partial<AiExtractField>[]) {
    const key = typeof raw?.key === 'string' ? raw.key : ''
    if (!AI_EXTRACT_KEY_RE.test(key)) {
      issues.push({ key, message: 'the key must be lower-case letters, digits and underscores, starting with a letter' })
      continue
    }
    if (seen.has(key)) issues.push({ key, message: 'keys must be unique' })
    seen.add(key)
    if (!FIELD_TYPES.includes(raw.type as AiFieldType)) {
      issues.push({ key, message: 'unknown type' })
      continue
    }
    if (typeof raw.description !== 'string' || !raw.description.trim()) {
      issues.push({ key, message: 'a description is required' })
    }
    if (raw.type === 'choice') {
      const choices = Array.isArray(raw.choices) ? raw.choices.map((c) => String(c).trim()).filter(Boolean) : []
      if (choices.length === 0) issues.push({ key, message: 'a choice field needs choices' })
      if (choices.length > AI_EXTRACT_MAX_CHOICES) {
        issues.push({ key, message: `at most ${AI_EXTRACT_MAX_CHOICES} choices` })
      }
      if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) {
        issues.push({ key, message: 'choices must be distinct' })
      }
    }
    const t = raw.target
    if (t) {
      if ((t.kind === 'label' || t.kind === 'tag') && raw.type !== 'choice') {
        issues.push({ key, message: 'only a choice field can apply a label or a tag' })
      }
      if (t.kind === 'contact_field' && !['name', 'email', 'company'].includes(t.field)) {
        issues.push({ key, message: 'unknown contact field' })
      }
      if (t.kind === 'custom_field' && !t.custom_field_id) {
        issues.push({ key, message: 'pick a custom field' })
      }
    }
  }
  return issues
}

/** Real calendar date in yyyy-mm-dd form (2026-02-30 is not one). */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

export type FieldValue = string | number | boolean

export interface Extraction {
  /** Values that passed validation, by key. */
  values: Record<string, FieldValue>
  /** Keys the model left null / empty: not an error, just nothing found. */
  empty: string[]
  /** Values that failed validation (left empty, never written). */
  invalid: FieldIssue[]
}

/**
 * Validate the model's JSON against the field definitions. A field that is
 * missing, null or blank is "empty"; one that is present but the wrong type,
 * not one of the choices, too long or not a real date is "invalid". Neither
 * is ever written. Returns null when the output is not a JSON object at all.
 */
export function validateExtraction(fields: AiExtractField[], modelText: string): Extraction | null {
  const obj = parseJsonObject(modelText)
  if (!obj) return null
  const out: Extraction = { values: {}, empty: [], invalid: [] }

  for (const f of fields) {
    const raw = obj[f.key]
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
      out.empty.push(f.key)
      continue
    }
    const v = validateValue(f, raw)
    if (v.ok) out.values[f.key] = v.value
    else out.invalid.push({ key: f.key, message: v.message })
  }
  return out
}

function validateValue(f: AiExtractField, raw: unknown): { ok: true; value: FieldValue } | { ok: false; message: string } {
  switch (f.type) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, message: 'expected text' }
      const s = String(raw).trim()
      if (s.length > AI_EXTRACT_TEXT_MAX_CHARS) return { ok: false, message: `text longer than ${AI_EXTRACT_TEXT_MAX_CHARS} characters` }
      return { ok: true, value: s }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN
      if (!Number.isFinite(n)) return { ok: false, message: 'expected a number' }
      return { ok: true, value: n }
    }
    case 'date': {
      if (typeof raw !== 'string' || !isIsoDate(raw.trim())) return { ok: false, message: 'expected a date as yyyy-mm-dd' }
      return { ok: true, value: raw.trim() }
    }
    case 'boolean': {
      if (raw === true || raw === false) return { ok: true, value: raw }
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase()
        if (s === 'yes' || s === 'true') return { ok: true, value: true }
        if (s === 'no' || s === 'false') return { ok: true, value: false }
      }
      return { ok: false, message: 'expected yes or no' }
    }
    case 'choice': {
      if (typeof raw !== 'string') return { ok: false, message: 'expected one of the choices' }
      const hit = (f.choices ?? []).find((c) => c.trim().toLowerCase() === raw.trim().toLowerCase())
      return hit ? { ok: true, value: hit.trim() } : { ok: false, message: 'not one of the choices' }
    }
    default:
      return { ok: false, message: 'unknown type' }
  }
}

/** Contact-field targets have their own limits on top of the type. */
export function validContactFieldValue(field: 'name' | 'email' | 'company', value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (field === 'email') return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
  return v.length <= 120
}

// ---- Variables in prompts -------------------------------------------------

export interface InterpolationScope {
  message?: { text?: string }
  vars?: Record<string, unknown>
  contact?: Record<string, unknown>
  conversation?: Record<string, unknown>
  closure?: { note?: string }
}

const MAX_SUBSTITUTED_CHARS = 1000

/**
 * Fill `{{ message.text }}`, `{{ vars.x }}`, `{{ contact.name }}`,
 * `{{ conversation.id }}` and `{{ closure.note }}`. Everything substituted came
 * from a customer or an earlier step, so it goes in wrapped in « » and cut to
 * 1,000 characters: the prompts tell the model text between « » is data. A
 * value that itself contains « or » has them removed so it cannot fake the
 * wrapper. Unknown names become empty text, like the rest of the engine.
 */
export function interpolateSafe(template: string, scope: InterpolationScope): string {
  return (template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const [ns, prop] = key.split('.')
    let value: unknown
    if (ns === 'message' && prop === 'text') value = scope.message?.text
    else if (ns === 'vars' && prop) value = scope.vars?.[prop]
    else if (ns === 'contact' && prop) value = scope.contact?.[prop]
    else if (ns === 'conversation' && prop) value = scope.conversation?.[prop]
    else if (ns === 'closure' && prop === 'note') value = scope.closure?.note
    if (value === undefined || value === null || value === '') return ''
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return `«${clip(s.replace(/[«»]/g, ''), MAX_SUBSTITUTED_CHARS)}»`
  })
}

/** Plain interpolation for text a person will read (ticket subject, note): the
 *  same names, but no « » wrapper. */
export function interpolatePlain(template: string, scope: InterpolationScope): string {
  return (template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const [ns, prop] = key.split('.')
    let value: unknown
    if (ns === 'message' && prop === 'text') value = scope.message?.text
    else if (ns === 'vars' && prop) value = scope.vars?.[prop]
    else if (ns === 'contact' && prop) value = scope.contact?.[prop]
    else if (ns === 'conversation' && prop) value = scope.conversation?.[prop]
    else if (ns === 'closure' && prop === 'note') value = scope.closure?.note
    if (value === undefined || value === null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

/** Whether a template mentions contact.* or conversation.* (so the runner knows to load them). */
export function needsContactScope(...templates: (string | undefined)[]): boolean {
  return templates.some((t) => typeof t === 'string' && /\{\{\s*(contact|conversation)\./.test(t))
}
