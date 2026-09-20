import { parseCsv, unguardCsvCell } from '@/lib/csv'
import { MAX_CONTENT_CHARS, MAX_TITLE_CHARS } from '@/lib/ai/knowledge-doc'
import { parseCsvPairs } from '@/lib/knowledge-import-parse'
import {
  kbHtmlToPlainText,
  plainTextToKbHtml,
  sanitizeKbHtml,
  splitKbHtml,
} from '@/lib/knowledge-format'

// ============================================================
// Turning an uploaded file, pasted Q&A pairs or a fetched page into draft
// articles. Everything here is pure (the byte-level work of reading a .docx
// or .pdf happens in the route); it decides titles, splits long text into
// several articles, and tells the caller what it could not use.
// ============================================================

export const MAX_IMPORT_PAIRS = 200
/** A long document becomes several articles; more than this is refused. */
export const MAX_IMPORT_ARTICLES = 20
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024
/** Each piece stays a little under the per-article limit. */
const PIECE_CHARS = Math.floor(MAX_CONTENT_CHARS * 0.75)

export interface ImportItem {
  title: string
  /** Plain text: what search and the AI read. */
  content: string
  /** Rich text, when the source had structure worth keeping. */
  content_html: string | null
  kind: 'article' | 'qa'
}

export type ExtractResult =
  | { ok: true; items: ImportItem[]; skipped: number }
  | { ok: false; error: string; status: number }

export type FileFormat = 'text' | 'markdown' | 'csv' | 'docx' | 'pdf'

const EXTENSIONS: Record<string, FileFormat> = {
  txt: 'text',
  text: 'text',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  docx: 'docx',
  pdf: 'pdf',
}

/** Work out what a file is from its name (browsers report unreliable types
 *  for .md and .csv) and its MIME type. Null = not supported. */
export function detectFileFormat(fileName: string, mime: string): FileFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase()
  if (ext && EXTENSIONS[ext]) return EXTENSIONS[ext]
  const m = mime.toLowerCase()
  if (m === 'application/pdf') return 'pdf'
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (m === 'text/csv') return 'csv'
  if (m === 'text/markdown') return 'markdown'
  if (m === 'text/plain') return 'text'
  return null
}

export function unsupportedFileMessage(fileName: string): string {
  const legacyWord = /\.(doc|rtf|odt)$/i.test(fileName)
  return legacyWord
    ? 'Older Word files (.doc) cannot be read. Save it as .docx or PDF and try again.'
    : 'This file type is not supported. Use PDF, Word (.docx), text, Markdown or CSV.'
}

export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const tidy = base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (tidy || 'Imported article').slice(0, MAX_TITLE_CHARS)
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

// ------------------------------------------------------------
// Q&A pairs
// ------------------------------------------------------------
export function pairsToItems(value: unknown): ExtractResult {
  if (!Array.isArray(value)) return { ok: false, error: 'pairs must be a list', status: 400 }
  if (value.length > MAX_IMPORT_PAIRS) {
    return { ok: false, error: `Import at most ${MAX_IMPORT_PAIRS} pairs at a time.`, status: 400 }
  }
  const items: ImportItem[] = []
  let skipped = 0
  for (const raw of value) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as { question?: unknown; answer?: unknown }
    const question = typeof p.question === 'string' ? p.question.trim() : ''
    const answer = typeof p.answer === 'string' ? p.answer.trim() : ''
    if (!question || !answer || answer.length > MAX_CONTENT_CHARS) {
      skipped++
      continue
    }
    items.push({ title: clip(question, MAX_TITLE_CHARS), content: answer, content_html: null, kind: 'qa' })
  }
  if (items.length === 0) return { ok: false, error: 'No question and answer pairs to import.', status: 400 }
  return { ok: true, items, skipped }
}

// ------------------------------------------------------------
// Markdown
// ------------------------------------------------------------
function inlineMarkdown(escaped: string): string {
  return escaped
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * A small Markdown reader: headings, bullet and numbered lists, block quotes,
 * paragraphs, bold, italic, strike-through and links. Raw HTML in the source
 * is escaped (shown as text), and the result goes through the sanitiser
 * anyway.
 */
export function markdownToKbHtml(markdown: string): string {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let out = ''
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []
  let fenced = false

  const flushPara = () => {
    if (para.length) out += `<p>${inlineMarkdown(escapeHtml(para.join(' ')))}</p>`
    para = []
  }
  const flushList = () => {
    if (list) out += `<${list.kind}>${list.items.map((i) => `<li>${inlineMarkdown(escapeHtml(i))}</li>`).join('')}</${list.kind}>`
    list = null
  }
  const flushQuote = () => {
    if (quote.length) out += `<blockquote><p>${inlineMarkdown(escapeHtml(quote.join(' ')))}</p></blockquote>`
    quote = []
  }
  const flushAll = () => {
    flushPara()
    flushList()
    flushQuote()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      fenced = !fenced
      flushAll()
      continue
    }
    if (fenced) {
      // Code is kept as plain lines.
      if (line.trim()) out += `<p>${escapeHtml(line.trim())}</p>`
      continue
    }
    if (!line.trim()) {
      flushAll()
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1].length <= 2 ? 2 : 3
      out += `<h${level}>${inlineMarkdown(escapeHtml(heading[2]))}</h${level}>`
      continue
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushAll() // a horizontal rule
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*\S.*)$/.exec(line)
    const numbered = bullet ? null : /^\s*\d{1,3}[.)]\s+(.*\S.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      flushQuote()
      const kind = bullet ? 'ul' : 'ol'
      if (list && list.kind !== kind) flushList()
      if (!list) list = { kind, items: [] }
      list.items.push((bullet ?? numbered)![1].trim())
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      flushPara()
      flushList()
      quote.push(q[1].trim())
      continue
    }
    flushList()
    flushQuote()
    para.push(line.trim())
  }
  flushAll()
  return sanitizeKbHtml(out)
}

// ------------------------------------------------------------
// Body -> one or several article items
// ------------------------------------------------------------
function firstHeading(html: string): string | null {
  const m = /<h[23]>([\s\S]*?)<\/h[23]>/.exec(html)
  if (!m) return null
  const text = kbHtmlToPlainText(`<p>${m[1]}</p>`)
  return text && text.length <= 120 ? text : null
}

function partTitle(title: string, index: number): string {
  if (index === 0) return clip(title, MAX_TITLE_CHARS)
  const suffix = ` (part ${index + 1})`
  return `${clip(title, MAX_TITLE_CHARS - suffix.length)}${suffix}`
}

/** Hard-cut plain text into pieces at paragraph boundaries (last resort for
 *  text with no structure to split on). */
function splitPlain(text: string, max: number): string[] {
  const pieces: string[] = []
  let current = ''
  for (const para of text.split(/\n{2,}/)) {
    let rest = para
    while (rest.length > max) {
      if (current) {
        pieces.push(current)
        current = ''
      }
      pieces.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    if (current && current.length + rest.length + 2 > max) {
      pieces.push(current)
      current = ''
    }
    current = current ? `${current}\n\n${rest}` : rest
  }
  if (current.trim()) pieces.push(current)
  return pieces
}

/**
 * Rich text (already reduced to what an article may hold) to draft articles:
 * one, or several when it is longer than an article can be. Returns an error
 * when there is no text, or it would need more than `MAX_IMPORT_ARTICLES`.
 */
export function htmlToItems(title: string, html: string): ExtractResult {
  const clean = sanitizeKbHtml(html)
  if (!kbHtmlToPlainText(clean).trim()) {
    return {
      ok: false,
      error: 'No text could be read from this file. If it is a scan or an image, it needs to be typed out or run through OCR first.',
      status: 422,
    }
  }

  const items: ImportItem[] = []
  for (const piece of splitKbHtml(clean, PIECE_CHARS)) {
    const plain = kbHtmlToPlainText(piece)
    if (!plain.trim()) continue
    if (plain.length <= MAX_CONTENT_CHARS) {
      items.push({ title: '', content: plain, content_html: piece, kind: 'article' })
    } else {
      // A single block longer than an article: fall back to plain text.
      for (const part of splitPlain(plain, PIECE_CHARS)) {
        items.push({ title: '', content: part, content_html: plainTextToKbHtml(part), kind: 'article' })
      }
    }
  }
  if (items.length > MAX_IMPORT_ARTICLES) {
    return {
      ok: false,
      error: `This document is too long to import (it would make ${items.length} articles; the limit is ${MAX_IMPORT_ARTICLES}). Split it into smaller files.`,
      status: 413,
    }
  }
  items.forEach((item, i) => {
    item.title = partTitle(title, i)
  })
  return { ok: true, items, skipped: 0 }
}

export function plainTextToItems(title: string, text: string): ExtractResult {
  return htmlToItems(title, plainTextToKbHtml(text))
}

// ------------------------------------------------------------
// Files
// ------------------------------------------------------------
/** A CSV with question and answer columns becomes one Q&A draft per row;
 *  any other CSV becomes one article holding its rows as lines. */
export function csvToItems(text: string, fileName: string): ExtractResult {
  const pairs = parseCsvPairs(text)
  if (!pairs.missingColumns) {
    if (pairs.pairs.length > MAX_IMPORT_PAIRS) {
      return { ok: false, error: `This file has more than ${MAX_IMPORT_PAIRS} rows. Import at most ${MAX_IMPORT_PAIRS} at a time.`, status: 413 }
    }
    const res = pairsToItems(pairs.pairs)
    return res.ok ? { ...res, skipped: res.skipped + pairs.skipped } : res
  }
  const rows = parseCsv(text)
    .map((r) => r.map((c) => unguardCsvCell(c).trim()))
    .filter((r) => r.some(Boolean))
  if (rows.length === 0) return { ok: false, error: 'This CSV file is empty.', status: 422 }
  const body = rows.map((r) => r.filter(Boolean).join(' | ')).join('\n')
  return plainTextToItems(titleFromFileName(fileName), body)
}

export function markdownToItems(text: string, fileName: string): ExtractResult {
  const html = markdownToKbHtml(text)
  return htmlToItems(firstHeading(html) ?? titleFromFileName(fileName), html)
}

/** HTML from Word (mammoth) or any other source. */
export function documentHtmlToItems(html: string, fileName: string): ExtractResult {
  const clean = sanitizeKbHtml(html)
  return htmlToItems(firstHeading(clean) ?? titleFromFileName(fileName), clean)
}

export function decodeTextFile(bytes: Uint8Array): string {
  // UTF-8 (with or without a BOM); UTF-16 files carry a BOM we honour.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
}

export function isProbablyBinary(text: string): boolean {
  const sample = text.slice(0, 4000)
  const controls = (sample.match(/[\x00-\x08\x0e-\x1f]/g) ?? []).length
  return sample.length > 0 && controls / sample.length > 0.02
}

// ------------------------------------------------------------
// PDF text
// ------------------------------------------------------------
const SENTENCE_END = /[.!?:;。！？：；]["')\]]?$/
const LIST_START = /^(?:[-•*·▪●]\s+|\d{1,3}[.)]\s+)/

/**
 * A PDF gives text one printed line at a time. Join the lines of a wrapped
 * paragraph back together, and keep a break where a sentence ended, where a
 * list item starts, or where the PDF left a blank line.
 */
export function pdfTextToPlain(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim())
  const paragraphs: string[] = []
  let current = ''
  const flush = () => {
    if (current) paragraphs.push(current)
    current = ''
  }
  for (const line of lines) {
    if (!line) {
      flush()
      continue
    }
    if (current && (SENTENCE_END.test(current) || LIST_START.test(line))) flush()
    // A hyphen at the end of a printed line is a split word.
    current = current ? (current.endsWith('-') ? current.slice(0, -1) + line : `${current} ${line}`) : line
  }
  flush()
  // List items were flushed as separate paragraphs; put them back on
  // consecutive lines so they read as a list.
  const out: string[] = []
  for (const p of paragraphs) {
    const prev = out[out.length - 1]
    if (prev !== undefined && LIST_START.test(p) && LIST_START.test(prev.split('\n').pop() ?? '')) {
      out[out.length - 1] = `${prev}\n${p}`
    } else out.push(p)
  }
  return out.join('\n\n')
}
