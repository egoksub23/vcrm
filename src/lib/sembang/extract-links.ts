// ============================================================
// Plain URL extraction from a Sembang message body — no unfurling, no
// preview cards, just "find every http(s) URL in this text." No such
// helper existed anywhere in the codebase before this (Sembang message
// bodies don't linkify bare URLs at all today — see message-body.tsx).
// ============================================================

// Deliberately conservative: stops at whitespace and the common
// trailing-punctuation cases (a URL at the end of a sentence, wrapped
// in parens, etc.) rather than trying to be a fully RFC-3986-correct
// URL matcher — this only needs to be good enough for "list the links
// someone posted," not to validate arbitrary input.
const URL_RE = /https?:\/\/[^\s<>"']+/gi
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/

export function extractLinks(body: string): string[] {
  const matches = body.match(URL_RE)
  if (!matches) return []
  return matches.map((url) => url.replace(TRAILING_PUNCTUATION_RE, ''))
}
