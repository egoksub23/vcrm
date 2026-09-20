export const DEFAULT_TICKET_PREFIX = 'VIR'

const PREFIX_RE = /^[A-Z][A-Z0-9]{1,5}$/

/** What an admin typed, cleaned up: trimmed and upper-cased. */
export function normalizePrefix(raw: string): string {
  return raw.trim().toUpperCase()
}

/** 2-6 upper-case letters / digits, starting with a letter (the DB CHECK). */
export function isValidPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix)
}

/** VIR-12. Falls back to the default prefix until the account's is loaded. */
export function ticketKey(prefix: string | null | undefined, number: number): string {
  return `${prefix || DEFAULT_TICKET_PREFIX}-${number}`
}

export interface TicketQuery {
  /** A ticket number the query asks for ("VIR-12", "#12", "12"), if any. */
  number: number | null
  /** The prefix typed with a key ("VIR" in "VIR-12"), upper-cased. */
  prefix: string | null
  /** The lower-cased text to look for in subject / description. */
  text: string
}

/**
 * Reads a search box entry. "VIR-12" asks for that ticket, "12" and "#12"
 * for number 12 (and the digits may also be plain text), anything else is
 * text.
 */
export function parseTicketQuery(raw: string): TicketQuery {
  const text = raw.trim().toLowerCase()
  const keyed = /^([a-z][a-z0-9]{1,5})-(\d+)$/i.exec(text)
  if (keyed) return { number: Number(keyed[2]), prefix: keyed[1].toUpperCase(), text }
  const bare = /^#?(\d+)$/.exec(text)
  if (bare) return { number: Number(bare[1]), prefix: null, text: bare[1] }
  return { number: null, prefix: null, text }
}

/** Whether a ticket matches a search-box entry (key, number or text). */
export function ticketMatchesSearch(
  ticket: { ticket_number: number; subject: string; description?: string | null },
  raw: string,
  prefix: string | null | undefined,
): boolean {
  const q = parseTicketQuery(raw)
  if (!q.text) return true
  if (q.number !== null && q.number === ticket.ticket_number) {
    if (!q.prefix || q.prefix === (prefix || DEFAULT_TICKET_PREFIX)) return true
  }
  // A typed key that is not this ticket's key never falls back to text.
  if (q.prefix) return false
  return (
    ticket.subject.toLowerCase().includes(q.text) ||
    (ticket.description ?? '').toLowerCase().includes(q.text)
  )
}
