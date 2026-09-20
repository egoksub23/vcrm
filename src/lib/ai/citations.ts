// ============================================================
// Citations. The knowledge excerpts in the prompt are numbered [1], [2] ...
// and the model is asked to put the number of each excerpt it used after the
// sentence. Those markers are for us (which articles to show as "Based on",
// which files to attach); the customer must never see them.
// ============================================================

// [1], [1,2], [1, 2], [1][2] and the full-width 【1】; with the space before.
const MARKER = /[ \t]*(?:\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\]|【(\d{1,2}(?:\s*[,;、，]\s*\d{1,2})*)】)/g

export interface ExtractedCitations {
  /** The reply with every citation marker removed. */
  text: string
  /** 1-based excerpt numbers the model cited, in order of first mention. */
  cited: number[]
}

/**
 * Remove citation markers from a model reply and report which excerpts it
 * cited. Only numbers from 1 to `excerptCount` count as citations; a marker
 * that refers to an excerpt that does not exist is a false positive (say
 * "[7]" in a list of options) and is left alone. With no excerpts there is
 * nothing to cite and the text is returned unchanged.
 */
export function extractCitations(raw: string, excerptCount: number): ExtractedCitations {
  if (excerptCount <= 0 || !raw) return { text: raw, cited: [] }
  const cited: number[] = []
  const stripped = raw.replace(MARKER, (whole, ascii?: string, wide?: string) => {
    const nums = (ascii ?? wide ?? '')
      .split(/[,;、，]/)
      .map((n) => parseInt(n.trim(), 10))
      .filter((n) => Number.isFinite(n))
    if (nums.length === 0 || nums.some((n) => n < 1 || n > excerptCount)) return whole
    for (const n of nums) if (!cited.includes(n)) cited.push(n)
    return ''
  })
  const text = stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, cited }
}

/**
 * The articles a reply was based on: those it cited, or - when the model
 * cited nothing (many models forget) - just the best-ranked excerpt's article,
 * since the excerpts already passed the relevance cut-off. `documentIds[i]`
 * is the article of excerpt i + 1. Returns distinct article ids in order.
 */
export function citedDocumentIds(cited: number[], documentIds: string[]): string[] {
  const picks = cited.length > 0 ? cited.map((n) => documentIds[n - 1]) : documentIds.slice(0, 1)
  return Array.from(new Set(picks.filter((id): id is string => !!id)))
}
