// ============================================================
// Opening a PDF for the engine, with the limits the product promises: not encrypted, not damaged,
// at most MAX_PAGES pages. Errors carry a stable code the routes turn into a message.
// ============================================================

import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import { normalizeRotation, pageShownSize } from "./geometry";
import type { PdfInfo } from "./types";

export const MAX_PAGES = 200;
/**
 * Pages the engine adds after the file was accepted (the certificate and the audit trail). Opening the file again to seal it allows them: a
 * document of 199 or 200 pages was accepted at the door and then could never be sealed, five times over, for being too long by the pages we added.
 */
export const SEAL_EXTRA_PAGES = 40;
/** The most a single uploaded or generated file may weigh (matches the storage bucket). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type PdfErrorCode = "pdf_invalid" | "pdf_encrypted" | "pdf_too_many_pages" | "pdf_empty" | "pdf_too_large";

export class PdfError extends Error {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode, message: string) {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

export const PDF_ERROR_MESSAGES: Record<PdfErrorCode, string> = {
  pdf_invalid: "This file could not be read as a PDF. Try saving it again from the program that made it.",
  pdf_encrypted: "This PDF is password protected or restricted. Remove the protection and upload it again.",
  pdf_too_many_pages: `This PDF has more than ${MAX_PAGES} pages, which is the most that can be signed.`,
  pdf_empty: "This PDF has no pages.",
  pdf_too_large: "This file is larger than 25 MB.",
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isPdf(bytes: Uint8Array): boolean {
  // %PDF- within the first 1024 bytes, as readers accept
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

/** Open a PDF, refusing what the product does not handle. */
export async function openPdf(bytes: Uint8Array, opts: { maxPages?: number } = {}): Promise<PDFDocument> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new PdfError("pdf_too_large", PDF_ERROR_MESSAGES.pdf_too_large);
  if (!isPdf(bytes)) throw new PdfError("pdf_invalid", PDF_ERROR_MESSAGES.pdf_invalid);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/encrypted/i.test(msg)) throw new PdfError("pdf_encrypted", PDF_ERROR_MESSAGES.pdf_encrypted);
    throw new PdfError("pdf_invalid", PDF_ERROR_MESSAGES.pdf_invalid);
  }
  if (doc.isEncrypted) throw new PdfError("pdf_encrypted", PDF_ERROR_MESSAGES.pdf_encrypted);
  let n: number;
  try {
    // pdf-lib reads leniently: a file with a PDF header and nothing usable loads, then fails here
    n = doc.getPageCount();
  } catch {
    throw new PdfError("pdf_invalid", PDF_ERROR_MESSAGES.pdf_invalid);
  }
  if (n === 0) throw new PdfError("pdf_empty", PDF_ERROR_MESSAGES.pdf_empty);
  if (n > (opts.maxPages ?? MAX_PAGES)) throw new PdfError("pdf_too_many_pages", PDF_ERROR_MESSAGES.pdf_too_many_pages);
  return doc;
}

/** Page count and shown page sizes, for the editor and for validating placements. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await openPdf(bytes);
  const pages = doc.getPages().map((p) => {
    const box = p.getCropBox();
    const rotation = normalizeRotation(p.getRotation().angle);
    const size = pageShownSize(box.width, box.height, rotation);
    return { width: size.width, height: size.height, rotation };
  });
  return { pageCount: pages.length, pages };
}

/** Save with plain cross-reference tables: signature placeholders and older readers need them. */
export async function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false });
}
