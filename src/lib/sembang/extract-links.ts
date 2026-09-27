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
// Bare "www.…" addresses — the other extremely common way people paste
// a link ("check out www.example.com"), with no scheme at all.
// Requires the literal "www." prefix specifically because it's an
// unambiguous signal; a fully bare "example.com" is deliberately NOT
// matched here — too many false positives in ordinary prose ("v2.0",
// "Node.js", "e.g.", a sentence ending in someone's initials, etc.).
const BARE_WWW_RE = /\bwww\.[^\s<>"']+/gi
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/

export function extractLinks(body: string): string[] {
  const found: { index: number; url: string }[] = []

  for (const m of body.matchAll(URL_RE)) {
    found.push({ index: m.index ?? 0, url: m[0] })
  }

  for (const m of body.matchAll(BARE_WWW_RE)) {
    const start = m.index ?? 0
    // Skip a "www." that's already part of a scheme URL matched above
    // (the "www" inside "https://www.example.com") rather than double-
    // counting it as a second, schemeless link.
    const preceding = body.slice(Math.max(0, start - 8), start)
    if (preceding.endsWith('://')) continue
    found.push({ index: start, url: `https://${m[0]}` })
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.url.replace(TRAILING_PUNCTUATION_RE, ''))
}
