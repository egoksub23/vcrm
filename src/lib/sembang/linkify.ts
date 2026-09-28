// ============================================================
// Data-only half of inline link rendering in a Sembang message body:
// splits plain text into alternating text/link segments so the caller
// (message-body.tsx) can turn "link" segments into <a> elements. Built
// on findLinkTokens() (extract-links.ts) — the same "what counts as a
// link" definition already used for the Links panel and unfurl
// previews, so all three agree on what gets treated as a URL.
// ============================================================
import { findLinkTokens } from './extract-links'

export type LinkifySegment = { type: 'text'; text: string } | { type: 'link'; text: string; href: string }

/** Splits `text` into text/link segments, in reading order. A `text`
 *  with no links returns a single one-item `text` segment (or `[]` for
 *  empty input) so callers can map over the result unconditionally. */
export function linkifySegments(text: string): LinkifySegment[] {
  const tokens = findLinkTokens(text)
  if (tokens.length === 0) return text ? [{ type: 'text', text }] : []

  const out: LinkifySegment[] = []
  let last = 0
  for (const tok of tokens) {
    if (tok.index > last) out.push({ type: 'text', text: text.slice(last, tok.index) })
    out.push({ type: 'link', text: tok.text, href: tok.href })
    last = tok.end
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}
