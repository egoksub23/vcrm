// Test fixtures for the PDF engine: small PDFs built in code, so no binary files live in the repo.
// Imported only by tests.

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import sharp from "sharp";

export interface FixturePage {
  w: number;
  h: number;
  rotate?: 0 | 90 | 180 | 270;
  /** MediaBox does not start at 0,0 (a cropped scan). */
  originX?: number;
  originY?: number;
}

export async function makePdf(pages: FixturePage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach((p, i) => {
    const page = doc.addPage([p.w, p.h]);
    if (p.originX || p.originY) {
      page.setMediaBox(p.originX ?? 0, p.originY ?? 0, p.w, p.h);
      page.setCropBox(p.originX ?? 0, p.originY ?? 0, p.w, p.h);
    }
    page.drawText(`Fixture page ${i + 1}`, { x: (p.originX ?? 0) + 40, y: (p.originY ?? 0) + p.h - 60, size: 18, font, color: rgb(0.2, 0.2, 0.2) });
    if (p.rotate) page.setRotation(degrees(p.rotate));
  });
  return doc.save({ useObjectStreams: false });
}

export const A4 = { w: 595.28, h: 841.89 };
export const LETTER = { w: 612, h: 792 };

/** A transparent-background PNG that looks like a scribble: some strokes on a 300x100 canvas. */
export async function scribblePng(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><path d="M10 70 C 40 10, 70 90, 110 40 S 180 20, 290 60" stroke="#101a6e" stroke-width="5" fill="none" stroke-linecap="round"/></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}
