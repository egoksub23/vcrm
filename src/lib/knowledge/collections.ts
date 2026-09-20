// ============================================================
// Validation for collection input (create / update). Pure, so the routes stay
// thin and the rules are testable.
// ============================================================

export const MAX_COLLECTION_NAME_CHARS = 60
export const DEFAULT_COLLECTION_COLOR = '#7C3AED'
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export interface CollectionFields {
  name?: string
  color?: string
  sort_order?: number
}

export type ParsedCollection = { ok: true; fields: CollectionFields } | { ok: false; error: string }

export function parseCollectionInput(body: unknown, opts: { partial: boolean }): ParsedCollection {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const fields: CollectionFields = {}

  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { ok: false, error: 'name cannot be empty' }
    const name = b.name.trim().replace(/\s+/g, ' ')
    if (name.length > MAX_COLLECTION_NAME_CHARS) {
      return { ok: false, error: `name is limited to ${MAX_COLLECTION_NAME_CHARS} characters` }
    }
    fields.name = name
  }
  if (b.color !== undefined) {
    if (typeof b.color !== 'string' || !HEX_COLOR.test(b.color.trim())) {
      return { ok: false, error: 'color must be a hex colour like #7C3AED' }
    }
    fields.color = b.color.trim().toUpperCase().replace(/^#/, '#')
  }
  if (b.sort_order !== undefined) {
    if (typeof b.sort_order !== 'number' || !Number.isInteger(b.sort_order) || Math.abs(b.sort_order) > 100000) {
      return { ok: false, error: 'sort_order must be a whole number' }
    }
    fields.sort_order = b.sort_order
  }

  if (!opts.partial && !fields.name) return { ok: false, error: 'name is required' }
  if (opts.partial && Object.keys(fields).length === 0) return { ok: false, error: 'Nothing to update' }
  return { ok: true, fields }
}
