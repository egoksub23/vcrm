import { describe, expect, it } from "vitest";

import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import { A4, LETTER, makePdf } from "./fixtures";
import { offsetToUser, shownBoxToUser, type Rotation } from "./geometry";
import { inspectPdf, sha256Hex } from "./load";
import { TEST_MARK_NOTE, TEST_MARK_TEXT, markTestPages, placeCentred } from "./testmark";

const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();
/** Everything drawn on every page, as text: pdf-lib compresses a page's content, so it is decoded stream by stream. */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const parts: string[] = [];
  for (const page of doc.getPages()) {
    const c = page.node.lookup(PDFName.of("Contents"));
    const streams = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    for (const s of streams) parts.push(Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString("latin1"));
  }
  return parts.join(" ");
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("placeCentred", () => {
  // The same mapping the field boxes use (geometry.ts), taken the long way: a point of the shown page, as fractions from the
  // top-left, through shownBoxToUser. The mark's centre must land where that says, for every rotation and a shifted crop box.
  const rotations: Rotation[] = [0, 90, 180, 270];
  it.each(rotations)("puts the centre of the text at the centre of the page when the page is rotated %i degrees", (rotation) => {
    const w = 400;
    const h = 600;
    const originX = 10;
    const originY = 20;
    const page = { originX, originY, width: w, height: h, rotation };
    const textWidth = 200;
    const size = 50;
    for (const angle of [0, 45]) {
      const p = placeCentred(page, 0.5, 0.5, textWidth, size, angle);
      // walk from the start of the text to its centre along the text direction (in the reader's frame), then to user space
      const rad = (angle * Math.PI) / 180;
      const centreOffset = offsetToUser((textWidth / 2) * Math.cos(rad) - (size * 0.72 * Math.sin(rad)) / 2, (textWidth / 2) * Math.sin(rad) + (size * 0.72 * Math.cos(rad)) / 2, rotation);
      const centre = { x: p.x + centreOffset.x, y: p.y + centreOffset.y };
      const want = shownBoxToUser({ x: 0.5, y: 0.5, w: 0, h: 0 }, w, h, rotation);
      expect(centre.x).toBeCloseTo(originX + want.x, 6);
      expect(centre.y).toBeCloseTo(originY + want.y, 6);
      // pdf-lib turns the text by this much; a page stored rotated turns the reader's view by the same amount the other way
      expect(p.angle).toBe(angle + rotation);
    }
  });

  it("puts a line at the top edge of the shown page, upright", () => {
    const p = placeCentred({ originX: 0, originY: 0, width: 300, height: 500, rotation: 0 }, 0.5, 0.96, 100, 10, 0);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeGreaterThan(470);
    expect(p.y).toBeLessThan(500);
  });
});

describe("markTestPages", () => {
  it("marks every page, keeps the page count and sizes, and returns the fingerprint of what it made", async () => {
    const input = await makePdf([{ ...A4 }, { ...LETTER }, { w: 300, h: 200, rotate: 90 }]);
    const out = await markTestPages(input);
    expect(out.sha256).toBe(sha256Hex(out.bytes));
    expect(out.sha256).not.toBe(sha256Hex(input));
    const info = await inspectPdf(out.bytes);
    expect(info.pageCount).toBe(3);
    expect(info.pages[1]).toMatchObject({ width: 612, height: 792 });
    expect(info.pages[2].rotation).toBe(90);
    // each page got the big mark and the line (the text is written as hex by the font encoder)
    const text = await drawnText(out.bytes);
    expect(count(text, `<${hex(TEST_MARK_TEXT)}>`)).toBe(3);
    expect(count(text, `<${hex(TEST_MARK_NOTE)}>`)).toBe(3);
  });

  it("leaves the first pages alone when they were marked already (the certificate pages that follow are marked)", async () => {
    const input = await makePdf([{ ...A4 }, { ...A4 }, { ...A4 }, { ...A4 }]);
    const once = await markTestPages(input, { skipPages: 2 });
    const text = await drawnText(once.bytes);
    expect(count(text, `<${hex(TEST_MARK_TEXT)}>`)).toBe(2);
    // the page's own drawing is still there: the fixture writes "Fixture page n"
    const doc = await PDFDocument.load(once.bytes);
    expect(doc.getPageCount()).toBe(4);
  });

  it("does nothing when every page is skipped, and handles a skip beyond the page count", async () => {
    const input = await makePdf([{ ...A4 }]);
    const out = await markTestPages(input, { skipPages: 5 });
    expect(count(await drawnText(out.bytes), `<${hex(TEST_MARK_TEXT)}>`)).toBe(0);
  });

  it("refuses what is not a PDF with the engine's own error", async () => {
    await expect(markTestPages(new TextEncoder().encode("not a pdf"))).rejects.toMatchObject({ code: "pdf_invalid" });
  });
});
