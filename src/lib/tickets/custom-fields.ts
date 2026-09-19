import type {
  TicketCategory,
  TicketCustomValue,
  TicketCustomValues,
  TicketFieldDefinition,
  TicketFieldType,
} from '@/types'

export const TICKET_FIELD_TYPES: TicketFieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'dropdown',
  'checkbox',
]

export const MAX_DROPDOWN_OPTIONS = 50

/** Active fields that apply to `category`, in form order. */
export function fieldsForCategory(
  defs: TicketFieldDefinition[],
  category: TicketCategory,
): TicketFieldDefinition[] {
  return defs
    .filter(
      (d) =>
        d.is_active &&
        (d.applies_to_categories.length === 0 || d.applies_to_categories.includes(category)),
    )
    .sort((a, b) => a.position - b.position)
}

/**
 * Fields to show on an existing ticket: everything the current category
 * calls for, plus any archived / other-category field that already holds a
 * value — so changing a ticket's category or archiving a field never makes
 * captured data invisible.
 */
export function fieldsForTicket(
  defs: TicketFieldDefinition[],
  category: TicketCategory,
  values: TicketCustomValues,
): TicketFieldDefinition[] {
  const applicable = new Set(fieldsForCategory(defs, category).map((d) => d.id))
  return defs
    .filter((d) => applicable.has(d.id) || !isEmptyValue(values[d.id]))
    .sort((a, b) => a.position - b.position)
}

/** Empty = nothing captured. An unticked checkbox counts as empty so a
 *  "required" checkbox means "must be ticked" (an acknowledgement). */
export function isEmptyValue(value: TicketCustomValue | null | undefined): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (typeof value === 'boolean') return value === false
  return Number.isNaN(value)
}

/** Ids of required fields (that apply to `category`) with no value. */
export function missingRequiredFields(
  defs: TicketFieldDefinition[],
  category: TicketCategory,
  values: TicketCustomValues,
): string[] {
  return fieldsForCategory(defs, category)
    .filter((d) => d.is_required && isEmptyValue(values[d.id]))
    .map((d) => d.id)
}

/**
 * The values object that actually gets stored: only fields that apply to
 * the category, coerced to the field's type, with blanks dropped and
 * dropdown answers checked against the field's current options.
 */
export function sanitizeCustomValues(
  defs: TicketFieldDefinition[],
  category: TicketCategory,
  values: TicketCustomValues,
): TicketCustomValues {
  const out: TicketCustomValues = {}
  for (const def of fieldsForCategory(defs, category)) {
    const coerced = coerceValue(def, values[def.id])
    if (coerced !== undefined) out[def.id] = coerced
  }
  return out
}

/** Same coercion for a single field (detail-sheet edits). undefined =
 *  "clear this value". */
export function coerceValue(
  def: TicketFieldDefinition,
  raw: TicketCustomValue | null | undefined,
): TicketCustomValue | undefined {
  if (isEmptyValue(raw)) return undefined
  switch (def.field_type) {
    case 'checkbox':
      return raw === true ? true : undefined
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      return Number.isFinite(n) ? n : undefined
    }
    case 'date': {
      const s = String(raw).trim()
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined
    }
    case 'dropdown': {
      const s = String(raw)
      return def.options.includes(s) ? s : undefined
    }
    default:
      return String(raw).trim()
  }
}

/** "a, b\nc" → ['a','b','c'] — trimmed, de-duplicated (case-insensitive),
 *  capped. Used by the builder's dropdown-choices box. */
export function parseOptions(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[\n,]/)) {
    const opt = part.trim()
    const key = opt.toLowerCase()
    if (!opt || seen.has(key)) continue
    seen.add(key)
    out.push(opt)
    if (out.length >= MAX_DROPDOWN_OPTIONS) break
  }
  return out
}
