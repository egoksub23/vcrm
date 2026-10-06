// ============================================================
// A JPG or PNG becomes a one-page PDF inside Halo, no converter needed. The page is A4, portrait or
// landscape to match the picture, with a margin, and the picture is scaled to fit.
// ============================================================

import { PDFDocument } from "pdf-lib";

import { savePdf } from "../pdf/load";

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 28;

export class ImageError extends Error {
  readonly code = "image_unreadable" as const;
  constructor() {
    super("This image could not be read. Try saving it again as a JPG or PNG.");
    this.name = "ImageError";
  }
}

export async function imageToPdf(bytes: Uint8Array, mime: "image/png" | "image/jpeg"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  let img;
  try {
    img = mime === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    throw new ImageError();
  }
  const landscape = img.width > img.height;
  const pageW = landscape ? A4.h : A4.w;
  const pageH = landscape ? A4.w : A4.h;
  const page = doc.addPage([pageW, pageH]);
  const scale = Math.min((pageW - MARGIN * 2) / img.width, (pageH - MARGIN * 2) / img.height, 1.5);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (pageW - w) / 2, y: pageH - MARGIN - h, width: w, height: h });
  return savePdf(doc);
}
