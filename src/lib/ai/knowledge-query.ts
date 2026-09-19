// ============================================================
// Knowledge-base query helpers: turn a customer's message into a safe
// keyword query (English, Bahasa Melayu and Chinese), score how much of
// it a passage covers, and work out which language a text is in.
//
// Pure + deterministic so it is easy to test. Keyword search is the
// only search path for accounts without an embeddings service, so it has
// to work for all three languages:
//   - Latin scripts: OR of the meaningful words (an AND of a whole
//     sentence would almost never match), with stopwords dropped.
//   - Chinese: no spaces between words, and the database splits every
//     character into its own token (migration 073), so a run of Chinese
//     becomes overlapping two-character phrase pairs.
// ============================================================

export const KB_LANGUAGES = ['en', 'ms', 'zh'] as const
export type KbLanguage = (typeof KB_LANGUAGES)[number]

/** Native names — the same in every UI language, so an agent always
 *  recognises them. */
export const KB_LANGUAGE_LABELS: Record<KbLanguage, string> = {
  en: 'English',
  ms: 'Bahasa Melayu',
  zh: '中文',
}

const CJK_RUN = /[㐀-䶿一-鿿]+/g

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'can', 'could', 'will', 'would',
  'should', 'may', 'might', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'its', 'they',
  'them', 'this', 'that', 'these', 'those', 'what', 'how', 'when', 'where', 'why', 'which', 'who', 'get',
  'have', 'has', 'had', 'there', 'any', 'about', 'please', 'hi', 'hello', 'hey', 'thanks', 'thank', 'want',
  'need', 'know', 'tell', 'much', 'many', 'also', 'just', 'so', 'not', 'no', 'yes', 'ok', 'okay',
  // Bahasa Melayu
  'yang', 'dan', 'atau', 'untuk', 'dengan', 'dari', 'di', 'ke', 'pada', 'dalam', 'ini', 'itu', 'saya',
  'aku', 'kami', 'kita', 'anda', 'awak', 'kamu', 'dia', 'mereka', 'ada', 'tidak', 'tak', 'boleh', 'nak',
  'mahu', 'hendak', 'apa', 'siapa', 'bila', 'mana', 'kenapa', 'bagaimana', 'macam', 'berapa', 'adakah',
  'sudah', 'dah', 'akan', 'lagi', 'juga', 'pun', 'lah', 'kah', 'tolong', 'terima', 'kasih', 'hai',
  'salam', 'ya', 'tidak', 'saja', 'je', 'sangat', 'amat', 'oleh', 'kepada', 'sebab', 'kerana',
])

const MALAY_MARKERS = new Set([
  'yang', 'dan', 'untuk', 'dengan', 'tidak', 'tak', 'boleh', 'nak', 'mahu', 'saya', 'anda', 'awak',
  'apa', 'berapa', 'bagaimana', 'macam', 'ada', 'dah', 'sudah', 'harga', 'terima', 'kasih', 'tolong',
  'bila', 'mana', 'kenapa', 'adakah', 'kami', 'kita', 'lah', 'hendak', 'bayaran', 'balik',
])

export interface QueryTerms {
  /** Lower-cased words (Latin / other scripts), stopwords removed. */
  words: string[]
  /** Overlapping two-character Chinese pairs (a lone character stays alone). */
  cjk: string[]
}

const MAX_WORDS = 24
const MAX_CJK = 40

export function extractTerms(text: string): QueryTerms {
  const lower = text.toLowerCase()

  const cjk: string[] = []
  for (const run of lower.match(CJK_RUN) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) cjk.push(chars[0])
    else for (let i = 0; i < chars.length - 1; i++) cjk.push(chars[i] + chars[i + 1])
  }

  const words: string[] = []
  const seen = new Set<string>()
  for (const w of lower.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOPWORDS.has(w)) continue
    // One-letter words carry no signal; a digit on its own ("5") might.
    if (w.length < 2 && !/\d/.test(w)) continue
    if (seen.has(w)) continue
    seen.add(w)
    words.push(w)
    if (words.length >= MAX_WORDS) break
  }

  return { words, cjk: Array.from(new Set(cjk)).slice(0, MAX_CJK) }
}

/**
 * A `to_tsquery('simple', …)` string for the keyword search RPC. Every
 * token is letters or digits only, so no customer text can smuggle in a
 * tsquery operator. Empty string when nothing searchable is left.
 */
export function buildFtsQuery(text: string): string {
  const { words, cjk } = extractTerms(text)
  const parts = [
    ...words,
    ...cjk.map((pair) => {
      const chars = Array.from(pair)
      return chars.length === 1 ? chars[0] : `(${chars[0]} <-> ${chars[1]})`
    }),
  ]
  return parts.join(' | ')
}

/** How many distinct query terms appear in `content` (case-insensitive). */
export function termHits(content: string, text: string): { hits: number; total: number } {
  const { words, cjk } = extractTerms(text)
  const haystack = content.toLowerCase()
  const terms = [...words, ...cjk]
  let hits = 0
  for (const term of terms) if (haystack.includes(term)) hits++
  return { hits, total: terms.length }
}

/**
 * Relevance floor for keyword matches: a short query needs one term, a
 * longer one needs a quarter of its terms (at least two). Stops a single
 * common word from surfacing an unrelated article.
 */
export function passesKeywordFloor(content: string, queryText: string): boolean {
  const { hits, total } = termHits(content, queryText)
  if (total === 0) return false
  const needed = total <= 2 ? 1 : Math.max(2, Math.ceil(total * 0.25))
  return hits >= needed
}

/** Map a stored/ISO language code (`zh-CN`, `ms_MY`, `en`…) to ours. */
export function normalizeLanguage(code: string | null | undefined): KbLanguage | null {
  if (!code) return null
  const base = code.toLowerCase().replace('_', '-').split('-')[0]
  if (base === 'zh' || base === 'cmn' || base === 'yue') return 'zh'
  if (base === 'ms' || base === 'may' || base === 'msa') return 'ms'
  if (base === 'en') return 'en'
  return null
}

/** Best-effort language of a free text: Chinese by script, Malay by
 *  common words, English otherwise. Null when there is nothing to read. */
export function detectLanguage(text: string): KbLanguage | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const cjkChars = (trimmed.match(/[㐀-䶿一-鿿]/g) ?? []).length
  const letters = (trimmed.match(/\p{L}/gu) ?? []).length
  if (letters === 0) return null
  if (cjkChars / letters >= 0.2) return 'zh'
  let malay = 0
  for (const w of trimmed.toLowerCase().match(/[a-z]+/g) ?? []) if (MALAY_MARKERS.has(w)) malay++
  if (malay >= 2) return 'ms'
  return 'en'
}
