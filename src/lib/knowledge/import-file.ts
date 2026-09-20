import {
  MAX_IMPORT_FILE_BYTES,
  csvToItems,
  decodeTextFile,
  detectFileFormat,
  documentHtmlToItems,
  isProbablyBinary,
  markdownToItems,
  pdfTextToPlain,
  plainTextToItems,
  titleFromFileName,
  unsupportedFileMessage,
  type ExtractResult,
} from './import-extract'

// ============================================================
// Reading an uploaded file into draft articles. The pure decisions live in
// import-extract.ts; this is the byte-level part: plain text, Markdown and CSV
// are decoded, Word (.docx) goes through `mammoth`, PDF through `unpdf` (a
// pure-JavaScript build of pdf.js, no native code). Both libraries are loaded
// only when a file of that type arrives.
// ============================================================

const MAX_PDF_PAGES = 200

function fail(error: string, status: number): ExtractResult {
  return { ok: false, error, status }
}

export async function extractFile(
  bytes: Uint8Array,
  fileName: string,
  mime: string,
): Promise<ExtractResult> {
  if (bytes.length === 0) return fail('This file is empty.', 422)
  if (bytes.length > MAX_IMPORT_FILE_BYTES) {
    return fail(`This file is too large to import (the limit is ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB).`, 413)
  }
  const format = detectFileFormat(fileName, mime)
  if (!format) return fail(unsupportedFileMessage(fileName), 415)

  if (format === 'text' || format === 'markdown' || format === 'csv') {
    const text = decodeTextFile(bytes)
    if (isProbablyBinary(text)) return fail('This does not look like a text file.', 415)
    if (format === 'csv') return csvToItems(text, fileName)
    if (format === 'markdown') return markdownToItems(text, fileName)
    return plainTextToItems(titleFromFileName(fileName), text)
  }

  if (format === 'docx') {
    try {
      const mammoth = await import('mammoth')
      const convert = mammoth.convertToHtml ?? mammoth.default?.convertToHtml
      const { value } = await convert({ buffer: Buffer.from(bytes) })
      return documentHtmlToItems(value, fileName)
    } catch (err) {
      console.warn('[knowledge import] docx read failed:', err)
      return fail('This Word file could not be read. Make sure it is a .docx file (not an older .doc) and that it is not damaged.', 422)
    }
  }

  // pdf
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    if (pdf.numPages > MAX_PDF_PAGES) {
      return fail(`This PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}. Split it into smaller files.`, 413)
    }
    const { text } = await extractText(pdf, { mergePages: true })
    return plainTextToItems(titleFromFileName(fileName), pdfTextToPlain(text))
  } catch (err) {
    console.warn('[knowledge import] pdf read failed:', err)
    return fail('This PDF could not be read. It may be password protected or damaged.', 422)
  }
}
