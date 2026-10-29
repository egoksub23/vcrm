// Stamps a diagonal repeating text watermark on every page of a PDF.

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

export async function watermarkPdf(bytes: Uint8Array, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(36, width / 12);
    const textWidth = font.widthOfTextAtSize(label, fontSize);
    const cx = width / 2;

    // Three diagonal stamps: top third, centre, bottom third
    const yPositions = [height * 0.25, height * 0.5, height * 0.75];
    for (const yPos of yPositions) {
      page.drawText(label, {
        x: cx - textWidth / 2,
        y: yPos,
        size: fontSize,
        font,
        color: rgb(0.75, 0.75, 0.75),
        rotate: degrees(45),
        opacity: 0.35,
      });
    }
  }

  return doc.save();
}
