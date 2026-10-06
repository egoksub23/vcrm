// ============================================================
// Preparing an upload: whatever the sender gives (PDF, Word, image) becomes the one PDF that is
// edited and signed. The original is kept beside it. Nothing here touches storage or the database.
// ============================================================
import { inspectPdf, openPdf, sha256Hex } from "../pdf/load";
import type { PdfInfo } from "../pdf/types";
import { convertWordToPdf, type ConvertOptions } from "./client";
import { classifyUpload, MIME_FOR_KIND, type UploadKind } from "./detect";
import { imageToPdf } from "./image";

export * from "./client";
export * from "./detect";
export { imageToPdf, ImageError } from "./image";

export interface PreparedUpload {
  /** The PDF that is edited and signed. */
  pdf: Uint8Array;
  pdfSha256: string;
  info: PdfInfo;
  original: {
    bytes: Uint8Array;
    kind: UploadKind;
    mime: string;
    sha256: string;
    name: string;
  };
  /** True when the PDF was produced from a Word file or an image (so the editor shows "This is exactly what will be signed"). */
  converted: boolean;
}

/**
 * Accept an upload: check what it is, convert it when it is not already a PDF, and check the result.
 * Throws UploadError, ConvertError, ImageError or PdfError, each with a stable `code` and a message
 * that is safe to show.
 */
export async function prepareUpload(bytes: Uint8Array, filename: string, options: ConvertOptions = {}): Promise<PreparedUpload> {
  const kind = classifyUpload(bytes, filename);
  const original = { bytes, kind, mime: MIME_FOR_KIND[kind], sha256: sha256Hex(bytes), name: filename };

  let pdf: Uint8Array;
  let converted = false;
  if (kind === "pdf") {
    await openPdf(bytes); // refuses encrypted, damaged, empty and over-long files
    pdf = bytes;
  } else if (kind === "png" || kind === "jpeg") {
    pdf = await imageToPdf(bytes, kind === "png" ? "image/png" : "image/jpeg");
    converted = true;
  } else {
    pdf = (await convertWordToPdf(bytes, filename, options)).pdf;
    converted = true;
  }
  return { pdf, pdfSha256: sha256Hex(pdf), info: await inspectPdf(pdf), original, converted };
}
