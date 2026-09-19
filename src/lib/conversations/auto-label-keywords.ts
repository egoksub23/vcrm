export const MAX_KEYWORDS = 50
export const MAX_KEYWORD_LENGTH = 60

/** "refund, invoice\nchargeback" → trimmed, de-duplicated (case-insensitive),
 *  length- and count-capped. Client-only, so it lives apart from
 *  auto-label.ts (which imports server-side AI modules). */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[\n,]/)) {
    const kw = part.trim().slice(0, MAX_KEYWORD_LENGTH)
    const key = kw.toLowerCase()
    if (!kw || seen.has(key)) continue
    seen.add(key)
    out.push(kw)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}
