// ============================================================
// Audited support access (migration 154): shared names and a plain-text reading
// of what the operator's diagnostics return.
//
// The operator never sees customer content; every section is a fixed list of
// fields chosen in the database (platform_support_view). This file only lays the
// answer out for the console.
// ============================================================

export const SUPPORT_SECTIONS = ['overview', 'channels', 'failures', 'members', 'jobs', 'usage'] as const
export type SupportSection = (typeof SUPPORT_SECTIONS)[number]

export function isSupportSection(v: unknown): v is SupportSection {
  return typeof v === 'string' && (SUPPORT_SECTIONS as readonly string[]).includes(v)
}

/** Allowed length of a grant, in hours (the database enforces the same). */
export const SUPPORT_HOURS = [1, 4, 24, 72, 168] as const

export interface SupportGrant {
  id: string
  operator_user_id: string | null
  reason: string | null
  created_at: string
  expires_at: string
  revoked_at: string | null
}

export interface SupportLogEntry {
  id: number
  grant_id: string
  operator_label: string
  section: string
  created_at: string
}

/** A grant that still lets the operator in right now. */
export function isGrantActive(g: Pick<SupportGrant, 'expires_at' | 'revoked_at'>, now: Date = new Date()): boolean {
  return g.revoked_at === null && new Date(g.expires_at).getTime() > now.getTime()
}

export interface DiagnosticRow {
  path: string
  value: string
}

/**
 * Flatten a diagnostics answer into `path: value` rows: objects become dotted
 * paths, lists get an index, nothing is dropped. Empty objects and lists show
 * as "none" so a healthy section does not look broken.
 */
export function diagnosticRows(value: unknown, prefix = ''): DiagnosticRow[] {
  if (value === null || value === undefined) return [{ path: prefix, value: '—' }]
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: prefix, value: 'none' }]
    return value.flatMap((v, i) => diagnosticRows(v, `${prefix}[${i}]`))
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [{ path: prefix, value: 'none' }]
    return entries.flatMap(([k, v]) => diagnosticRows(v, prefix ? `${prefix}.${k}` : k))
  }
  return [{ path: prefix, value: String(value) }]
}
