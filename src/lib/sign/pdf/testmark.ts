// ============================================================
// The TEST mark (F-10): a document sent from a template to try it out carries a visible mark on every page, so a test can never
// be mistaken for a real agreement once it has been printed, forwarded or filed.
//
//   * a large, faint, diagonal "TEST" across the middle of the page, and
//   * one small line along the top edge: "TEST DOCUMENT - NOT A REAL AGREEMENT".
//
// It is drawn on top of the page like a stamp (the page's own content is untouched), in the built-in Helvetica Bold (plain ASCII,
// so no font file is embedded), and follows a page stored rotated or with a crop box that does not start at 0,0 by using the
// same geometry as the field stamps. It is applied to the file as it is SENT (so signers see it while they sign, and the sealed
// copy inherits it) and to the certificate pages that are added at sealing (`skipPages` leaves the pages already marked alone).
// ============================================================

import { StandardFonts, degrees, rgb } from "pdf-lib";

import { normalizeRotation, offsetToUser, pageShownSize, type Rotation } from "./geometry";
import { openPdf, savePdf, sha256Hex } from "./load";

export const TEST_MARK_TEXT = "TEST";
export const TEST_MARK_NOTE = "TEST DOCUMENT - NOT A REAL AGREEMENT";

const RED = rgb(0.78, 0.09, 0.09);
/** Cap height of Helvetica Bold as a fraction of the font size (placeCentred centres a line on its capitals; the footer stamp, idfooter.ts, uses the same figure to put a baseline where it wants it). */
export const CAP = 0.72;

export interface MarkPlacement {
  /** The text's start, in the page's own user space (what pdf-lib's drawText takes). */
  x: number;
  y: number;
  /** Counter-clockwise degrees to hand to pdf-lib, which already allows for the page's own /Rotate. */
  angle: number;
}

/**
 * Where to start a line of text so that, as a reader sees the page, its CENTRE lies at (`cx`, `cy`) (fractions of the shown page,
 * `cy` from the BOTTOM) and it runs at `visibleAngle` degrees counter-clockwise. Pure, so every rotation can be tested.
 */
export function placeCentred(
  page: { originX: number; originY: number; width: number; height: number; rotation: Rotation },
  cx: number,
  cy: number,
  textWidth: number,
  textSize: number,
  visibleAngle: number,
): MarkPlacement {
  const shown = pageShownSize(page.width, page.height, page.rotation);
  const rad = (visibleAngle * Math.PI) / 180;
  // from the centre of the text back to its start (left end of the baseline), as the reader sees it
  const dx = -(textWidth / 2) * Math.cos(rad) + (textSize * CAP * Math.sin(rad)) / 2;
  const dy = -(textWidth / 2) * Math.sin(rad) - (textSize * CAP * Math.cos(rad)) / 2;
  // the reader's bottom-left corner of the page, in user space (see geometry.ts: the same mapping the field boxes use)
  const corner = (() => {
    switch (page.rotation) {
      case 0:
        return { x: page.originX, y: page.originY };
      case 90:
        return { x: page.originX + page.width, y: page.originY };
      case 180:
        return { x: page.originX + page.width, y: page.originY + page.height };
      case 270:
        return { x: page.originX, y: page.originY + page.height };
    }
  })();
  // the reader's rotation-aware offset, from that corner to the text's start
  const off = offsetToUser(cx * shown.width + dx, cy * shown.height + dy, page.rotation);
  return { x: corner.x + off.x, y: corner.y + off.y, angle: visibleAngle + page.rotation };
}

export interface TestMarkOptions {
  /** Leave the first this-many pages as they are (they were marked already). */
  skipPages?: number;
}

/** Mark every page after `skipPages` with TEST. Returns the new file and its fingerprint. */
export async function markTestPages(input: Uint8Array, options: TestMarkOptions = {}): Promise<{ bytes: Uint8Array; sha256: string }> {
  const doc = await openPdf(input);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const skip = Math.max(0, Math.floor(options.skipPages ?? 0));
  doc.getPages().forEach((page, i) => {
    if (i < skip) return;
    const box = page.getCropBox();
    const rotation = normalizeRotation(page.getRotation().angle);
    const geom = { originX: box.x, originY: box.y, width: box.width, height: box.height, rotation };
    const shown = pageShownSize(box.width, box.height, rotation);

    // the diagonal: sized to the page, and kept inside it along the diagonal
    const size = Math.max(40, Math.min(shown.width, shown.height) * 0.38);
    const width = font.widthOfTextAtSize(TEST_MARK_TEXT, size);
    const big = placeCentred(geom, 0.5, 0.5, width, size, 45);
    page.drawText(TEST_MARK_TEXT, { x: big.x, y: big.y, size, font, color: RED, opacity: 0.17, rotate: degrees(big.angle) });

    // the line along the top
    const noteSize = Math.max(7, Math.min(11, shown.width / 55));
    const noteWidth = font.widthOfTextAtSize(TEST_MARK_NOTE, noteSize);
    const top = placeCentred(geom, 0.5, 1 - (noteSize * 1.8) / shown.height, noteWidth, noteSize, 0);
    page.drawText(TEST_MARK_NOTE, { x: top.x, y: top.y, size: noteSize, font, color: RED, opacity: 0.85, rotate: degrees(top.angle) });
  });
  const bytes = await savePdf(doc);
  return { bytes, sha256: sha256Hex(bytes) };
}
