// ============================================================
// Shared "what counts as a link in a Sembang message" tokenizer.
// extractLinks() (a flat URL list — the Links panel, and what triggers
// a message's unfurl-preview fetch on send) and the message-body
// renderer's inline clickable links (see linkify.ts) both build on
// findLinkTokens() so there's exactly one definition of a link, not
// two regexes that could quietly drift apart.
// ============================================================

// Deliberately conservative: stops at whitespace and the common
// trailing-punctuation cases (a URL at the end of a sentence, wrapped
// in parens, etc.) rather than trying to be a fully RFC-3986-correct
// URL matcher — this only needs to be good enough for "list/linkify
// the links someone posted," not to validate arbitrary input.
const URL_RE = /https?:\/\/[^\s<>"']+/gi
// Bare "www.…" addresses — the other extremely common way people paste
// a link ("check out www.example.com"), with no scheme at all.
// Requires the literal "www." prefix specifically because it's an
// unambiguous signal; a fully bare "example.com" is deliberately NOT
// matched here — too many false positives in ordinary prose ("v2.0",
// "Node.js", "e.g.", a sentence ending in someone's initials, etc.).
const BARE_WWW_RE = /\bwww\.[^\s<>"']+/gi
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/

export interface LinkToken {
  /** Start offset of the link in the original text. */
  index: number
  /** End offset — where the link stops and any trailing punctuation
   *  (left as ordinary text, not part of the link) begins. */
  end: number
  /** Display text — trailing punctuation already stripped, but
   *  otherwise exactly as typed. A bare "www.foo.com" keeps that exact
   *  text even though its `href` gets a scheme added. */
  text: string
  /** Where the link points — always has a scheme. */
  href: string
}

/** Every link-looking substring in `text`, in reading order. Pure,
 *  never throws; returns `[]` for text with nothing link-shaped. */
export function findLinkTokens(text: string): LinkToken[] {
  const found: LinkToken[] = []

  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    const trimmed = m[0].replace(TRAILING_PUNCTUATION_RE, '')
    found.push({ index: start, end: start + trimmed.length, text: trimmed, href: trimmed })
  }

  for (const m of text.matchAll(BARE_WWW_RE)) {
    const start = m.index ?? 0
    // Skip a "www." that's already part of a scheme URL matched above
    // (the "www" inside "https://www.example.com") rather than double-
    // counting it as a second, schemeless link.
    const preceding = text.slice(Math.max(0, start - 8), start)
    if (preceding.endsWith('://')) continue
    const trimmed = m[0].replace(TRAILING_PUNCTUATION_RE, '')
    found.push({ index: start, end: start + trimmed.length, text: trimmed, href: `https://${trimmed}` })
  }

  return found.sort((a, b) => a.index - b.index)
}

/** Flat list of link hrefs in reading order — what the Links panel and
 *  the unfurl-preview trigger need. */
export function extractLinks(body: string): string[] {
  return findLinkTokens(body).map((t) => t.href)
}
