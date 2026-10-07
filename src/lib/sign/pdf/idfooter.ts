// ============================================================
// The ID stamp: a small grey line centred in the bottom margin of EVERY page of a sealed document, so that a printed page, a photographed
// page or one page pulled out of a bundle can be traced back to its document:
//
//     Vircle Secure Sign · ID 7b2e9c1a-....                         a document on its own
//     Vircle Secure Sign · COL-2026-000004 · ID 7b2e9c1a-....       a document of a collection (the collection's reference too)
//
// The ID is the document's id, the one in the address of its verify page and in the certificate's QR code. It is stamped by the sealing step, in
// the same pass that writes the signers' answers (stampFields), BEFORE the file is sealed and fingerprinted, so the seal covers it. A draft, a
// preview and a document that is still being signed never carry it.
//
// Geometry: the stamp follows the page the way a reader sees it (the same mapping the field stamps and the TEST mark use): /Rotate of 0, 90, 180
// and 270, a crop box that does not start at 0,0, a crop box smaller than the media box, landscape and odd sizes. It sits FOOTER_LIFT points above
// the bottom edge (so it is not on the very edge of a printed page), is centred, 7 pt in grey, and is kept inside the page: a line that would be
// wider than the page less its side margins is made smaller (down to FOOTER_MIN_SIZE), and left off a page too small to hold it even then.
//
// It uses the font the engine already embedded (Noto Sans, Latin): the text is the brand, a reference and a UUID, nothing that needs another.
// It can never fail a seal: every page is drawn inside its own try/catch and a page that fails is counted and left as it was.
// ============================================================

import { degrees, rgb, type PDFDocument, type PDFPage } from "pdf-lib";

import { runsFor, measureRuns, type EngineFonts } from "./fonts";
import { normalizeRotation, pageShownSize } from "./geometry";
import { CAP, placeCentred } from "./testmark";
import type { FooterResult } from "./types";

export const ID_FOOTER_BRAND = "Vircle Secure Sign";
/** The size the stamp starts at, in points. */
export const ID_FOOTER_SIZE = 7;
/** Points from the bottom edge of the visible page to the baseline of the text. */
export const ID_FOOTER_LIFT = 14;
/** The smallest the stamp is made to fit a narrow page; below it the page is left without. */
export const ID_FOOTER_MIN_SIZE = 4.5;
/** Room kept clear on each side of the line. */
const SIDE = 12;
const GREY = rgb(0.45, 0.46, 0.5);

/** The words of the stamp: the brand, the collection's reference when the document is one of a collection, and the ID. */
export function idFooterText(a: { documentId: string; collectionReference?: string | null }): string {
  const collection = a.collectionReference?.trim();
  return [ID_FOOTER_BRAND, ...(collection ? [collection] : []), `ID ${a.documentId}`].join(" · ");
}

/** The part of the page a reader sees: the crop box inside the media box (a crop box that lies outside it, or is empty, is ignored). */
function visibleBox(page: PDFPage): { x: number; y: number; width: number; height: number } {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x0 = Math.max(crop.x, media.x);
  const y0 = Math.max(crop.y, media.y);
  const x1 = Math.min(crop.x + crop.width, media.x + media.width);
  const y1 = Math.min(crop.y + crop.height, media.y + media.height);
  if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) return { x: media.x, y: media.y, width: media.width, height: media.height };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Stamp one page. `skipped`: the page is too small to hold the line. Throws when the page cannot be drawn on (the caller counts it). */
export function drawIdFooter(page: PDFPage, fonts: Pick<EngineFonts, "regular">, text: string): "stamped" | "skipped" {
  const box = visibleBox(page);
  const rotation = normalizeRotation(page.getRotation().angle);
  const shown = pageShownSize(box.width, box.height, rotation);
  const { runs } = runsFor(text, fonts.regular, null);
  if (runs.length === 0) return "skipped";
  const wide = (size: number) => measureRuns(runs, size);
  const room = shown.width - SIDE * 2;
  let size = ID_FOOTER_SIZE;
  if (wide(size) > room) size = Math.max(ID_FOOTER_MIN_SIZE, (ID_FOOTER_SIZE * room) / wide(ID_FOOTER_SIZE));
  // too narrow even at the smallest size, or too short to hold a line above its lift
  if (!(room > 0) || wide(size) > room + 0.01 || shown.height < ID_FOOTER_LIFT + size * 2) return "skipped";
  const geom = { originX: box.x, originY: box.y, width: box.width, height: box.height, rotation };
  // the baseline goes ID_FOOTER_LIFT above the bottom edge: placeCentred centres a line on its capitals, so ask for the centre half a cap height higher
  const at = placeCentred(geom, 0.5, (ID_FOOTER_LIFT + (size * CAP) / 2) / shown.height, wide(size), size, 0);
  for (const run of runs) page.drawText(run.text, { x: at.x, y: at.y, size, font: run.font, color: GREY, rotate: degrees(at.angle) });
  return "stamped";
}

/** Stamp every page of `doc`. Never throws: a page that fails is counted and left as it was. */
export function drawIdFooters(doc: PDFDocument, fonts: Pick<EngineFonts, "regular">, text: string): FooterResult {
  const out: FooterResult = { stamped: 0, skipped: 0, failed: 0 };
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch {
    return { ...out, failed: 1 };
  }
  for (const page of pages) {
    try {
      out[drawIdFooter(page, fonts, text)]++;
    } catch {
      out.failed++;
    }
  }
  return out;
}
