import { parseCsv } from '@/lib/csv'

// ============================================================
// Reading Q&A pairs from pasted text or a CSV, for the "Add Q&A pairs"
// import. Pure, so the dialog stays thin and the rules are testable. The
// server validates again; this only decides what is worth sending.
// ============================================================

export interface QaPair {
  question: string
  answer: string
}

export interface ParsedPairs {
  pairs: QaPair[]
  /** Non-empty lines / rows that could not be read as a pair. */
  skipped: number
}

/** Per import; the API enforces the same cap. */
export const MAX_IMPORT_PAIRS = 200

const QUESTION_HEADERS = ['question', 'questions', 'q', 'prompt']
const ANSWER_HEADERS = ['answer', 'answers', 'a', 'reply', 'response']

/**
 * "Question | Answer" per line. A tab works too, so a copy from two
 * spreadsheet columns pastes straight in. Only the first separator splits,
 * so an answer may itself contain a pipe.
 */
export function parsePastedPairs(text: string): ParsedPairs {
  const pairs: QaPair[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const pipe = line.indexOf('|')
    const cut = pipe >= 0 ? pipe : line.indexOf('\t')
    if (cut < 0) {
      skipped++
      continue
    }
    const question = line.slice(0, cut).trim()
    const answer = line.slice(cut + 1).trim()
    if (question && answer) pairs.push({ question, answer })
    else skipped++
  }
  return { pairs, skipped }
}

export type CsvPairsResult = ParsedPairs & {
  /** The header row has no recognisable question / answer columns. */
  missingColumns: boolean
}

/** A CSV whose header names a question column and an answer column. */
export function parseCsvPairs(text: string): CsvPairsResult {
  const rows = parseCsv(text)
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
  const q = header.findIndex((h) => QUESTION_HEADERS.includes(h))
  const a = header.findIndex((h) => ANSWER_HEADERS.includes(h))
  if (q < 0 || a < 0) return { pairs: [], skipped: 0, missingColumns: true }

  const pairs: QaPair[] = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    const question = (row[q] ?? '').trim()
    const answer = (row[a] ?? '').trim()
    if (question && answer) pairs.push({ question, answer })
    else skipped++
  }
  return { pairs, skipped, missingColumns: false }
}

/** Keep the first `max` pairs and say whether any were left out. */
export function capPairs(pairs: QaPair[], max = MAX_IMPORT_PAIRS): { pairs: QaPair[]; truncated: boolean } {
  return pairs.length > max ? { pairs: pairs.slice(0, max), truncated: true } : { pairs, truncated: false }
}
