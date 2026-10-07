import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";

import { drawIdFooters, idFooterText, ID_FOOTER_LIFT, ID_FOOTER_MIN_SIZE, ID_FOOTER_SIZE } from "./idfooter";
import { sealPdf } from "./seal";
import { createSelfSignedP12 } from "./p12";
import { stampFields } from "./stamp";
import { verifySealed } from "./verify";
import type { PlacedField } from "./types";

// The ID line on every page of a sealed document: "Vircle Secure Sign · [COL-...] · ID <id>", small and grey, centred in the bottom margin, on pages of
// every kind (portrait, landscape, stored rotated, with a crop box that does not start at 0,0, with a crop box inside the media box, very narrow, too small),
// and it can never fail what it is part of. The pages are made here with pdf-lib; the stamp is read back from the file with the same reader the product's
// own tests use, in the coordinates a person sees (origin top-left, /Rotate applied).

const DOC_ID = "7b2e9c1a-4d3f-4e8a-9b6c-1f2a3b4c5d6e";
const TEXT = idFooterText({ documentId: DOC_ID });

interface Spec {
  name: string;
  w: number;
  h: number;
  rotate?: 0 | 90 | 180 | 270;
  /** MediaBox and CropBox start here instead of 0,0. */
  origin?: [number, number];
  /** A crop box (x, y, width, height in user space): inside the media box, or, with `visible`, larger than it. */
  crop?: [number, number, number, number];
  /** What a reader sees when it is not the crop box itself: the crop box cut to the media box (x, y, width, height). */
  visible?: [number, number, number, number];
}

async function build(specs: Spec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  specs.forEach((s, i) => {
    const page = doc.addPage([s.w, s.h]);
    if (s.origin) {
      page.setMediaBox(s.origin[0], s.origin[1], s.w, s.h);
      page.setCropBox(s.origin[0], s.origin[1], s.w, s.h);
    }
    if (s.crop) page.setCropBox(...s.crop);
    // the sample line goes inside the part of the page a reader sees (the crop box when there is a smaller one)
    const [vx, vy, , vh] = s.visible ?? s.crop ?? [s.origin?.[0] ?? 0, s.origin?.[1] ?? 0, s.w, s.h];
    page.drawText(`Sample ${s.name} (page ${i + 1})`, { x: vx + 40, y: vy + vh - 60, size: 14, font });
    if (s.rotate) page.setRotation(degrees(s.rotate));
  });
  return doc.save({ useObjectStreams: false });
}

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every page's text with where it sits as a reader sees the page (baseline origin, points from the top-left), and the page's shown size. */
async function read(bytes: Uint8Array): Promise<{ W: number; H: number; items: Item[] }[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: { W: number; H: number; items: Item[] }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      W: viewport.width,
      H: viewport.height,
      items: content.items
        .filter((it): it is typeof it & { str: string; transform: number[]; width: number; height: number } => "str" in it && it.str.trim() !== "")
        .map((it) => {
          const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
          return { str: it.str, x, y, width: it.width, height: it.height };
        }),
    });
  }
  return pages;
}

const stampOf = (items: Item[]) => items.find((it) => it.str.includes("Vircle Secure Sign"));
const joined = (items: Item[]) => items.map((it) => it.str).join(" ").replace(/\s+/g, " ");

/** The page's own sample text is where it was, and the stamp is in the bottom margin, centred, grey-sized and inside the page. */
function expectStampedWell(page: { W: number; H: number; items: Item[] }, text = TEXT) {
  const stamp = stampOf(page.items)!;
  expect(stamp, "the stamp is on the page").toBeDefined();
  expect(joined(page.items)).toContain(text);
  // its baseline is ID_FOOTER_LIFT above the bottom edge as a reader sees the page
  expect(stamp.y).toBeGreaterThan(page.H - ID_FOOTER_LIFT - 1.5);
  expect(stamp.y).toBeLessThan(page.H - ID_FOOTER_LIFT + 1.5);
  // centred, and inside the page on both sides
  expect(Math.abs(stamp.x + stamp.width / 2 - page.W / 2)).toBeLessThan(1.5);
  expect(stamp.x).toBeGreaterThanOrEqual(0);
  expect(stamp.x + stamp.width).toBeLessThanOrEqual(page.W);
}

const SPECS: Spec[] = [
  { name: "A4 portrait", w: 595.28, h: 841.89 },
  { name: "Letter landscape", w: 792, h: 612 },
  { name: "Letter rotated 90", w: 612, h: 792, rotate: 90 },
  { name: "Letter rotated 180", w: 612, h: 792, rotate: 180 },
  { name: "Letter rotated 270", w: 612, h: 792, rotate: 270 },
  { name: "A4 landscape rotated 90", w: 841.89, h: 595.28, rotate: 90 },
  { name: "origin offset", w: 500, h: 700, origin: [30, 50] },
  { name: "origin offset rotated 90", w: 500, h: 700, origin: [30, 50], rotate: 90 },
  { name: "crop box inside media box", w: 612, h: 792, crop: [20, 30, 400, 500] },
  { name: "crop box inside media box rotated 270", w: 612, h: 792, crop: [20, 30, 400, 500], rotate: 270 },
  // a crop box that reaches outside the media box shows only the part inside it: the line goes at the bottom of THAT, not of the crop box
  { name: "crop box larger than media box", w: 612, h: 792, crop: [-40, -60, 700, 900], visible: [0, 0, 612, 792] },
];

describe("the ID line", () => {
  it("is the brand, the id, and for a document of a collection its reference (the words of the product's own certificate and verify page)", () => {
    expect(idFooterText({ documentId: DOC_ID })).toBe(`Vircle Secure Sign · ID ${DOC_ID}`);
    expect(idFooterText({ documentId: DOC_ID, collectionReference: "COL-2026-000004" })).toBe(`Vircle Secure Sign · COL-2026-000004 · ID ${DOC_ID}`);
    expect(idFooterText({ documentId: DOC_ID, collectionReference: "  " })).toBe(`Vircle Secure Sign · ID ${DOC_ID}`);
    expect(idFooterText({ documentId: DOC_ID, collectionReference: null })).toBe(`Vircle Secure Sign · ID ${DOC_ID}`);
  });

  it("is on EVERY page of a multi-page file of portrait, landscape, rotated, offset and cropped pages, at the bottom, centred, 7 pt and inside the page", async () => {
    const src = await build(SPECS);
    const out = await stampFields(src, [], {}, { idFooter: TEXT });
    expect(out.footer).toEqual({ stamped: SPECS.length, skipped: 0, failed: 0 });
    const pages = await read(out.bytes);
    expect(pages).toHaveLength(SPECS.length);
    pages.forEach((page, i) => {
      // the page as a reader sees it
      const s = SPECS[i];
      const swapped = s.rotate === 90 || s.rotate === 270;
      const w = s.visible ? s.visible[2] : s.crop ? s.crop[2] : s.w;
      const h = s.visible ? s.visible[3] : s.crop ? s.crop[3] : s.h;
      expect(page.W, s.name).toBeCloseTo(swapped ? h : w, 1);
      expect(page.H, s.name).toBeCloseTo(swapped ? w : h, 1);
      expectStampedWell(page);
      // its own content is still there, and the stamp is one line of 7 pt
      expect(joined(page.items)).toContain(`Sample ${s.name}`);
      expect(stampOf(page.items)!.height, s.name).toBeCloseTo(ID_FOOTER_SIZE, 0);
    });
  });

  it("adds the collection's reference on the same line, on every page", async () => {
    const text = idFooterText({ documentId: DOC_ID, collectionReference: "COL-2026-000004" });
    const out = await stampFields(await build(SPECS.slice(0, 4)), [], {}, { idFooter: text });
    const pages = await read(out.bytes);
    for (const page of pages) {
      expect(joined(page.items)).toContain(`Vircle Secure Sign · COL-2026-000004 · ID ${DOC_ID}`);
      expectStampedWell(page, text);
    }
  });

  it("makes the line smaller to fit a narrow page, leaves a page that is too small without it, and still stamps the others", async () => {
    const out = await stampFields(
      await build([
        { name: "narrow", w: 200, h: 300 },
        { name: "tiny", w: 100, h: 50 },
        { name: "short", w: 595, h: 24 },
        { name: "normal", w: 595.28, h: 841.89 },
      ]),
      [],
      {},
      { idFooter: TEXT },
    );
    expect(out.footer).toEqual({ stamped: 2, skipped: 2, failed: 0 });
    const [narrow, tiny, short, normal] = await read(out.bytes);
    const small = stampOf(narrow.items)!;
    expect(small.height).toBeLessThan(ID_FOOTER_SIZE);
    expect(small.height).toBeGreaterThanOrEqual(ID_FOOTER_MIN_SIZE - 0.05);
    expect(small.x).toBeGreaterThanOrEqual(0);
    expect(small.x + small.width).toBeLessThanOrEqual(narrow.W);
    expect(stampOf(tiny.items)).toBeUndefined();
    expect(stampOf(short.items)).toBeUndefined();
    expectStampedWell(normal);
  });

  it("is not there unless it is asked for: a draft, a preview and a document being signed are stamped without it", async () => {
    const src = await build(SPECS.slice(0, 3));
    const out = await stampFields(src, [], {});
    expect(out.footer).toBeUndefined();
    for (const page of await read(out.bytes)) expect(stampOf(page.items)).toBeUndefined();
  });

  it("goes on after the answers, so an answer that reaches the bottom margin is not covered by it, and the answers are where they were", async () => {
    const fields: PlacedField[] = [{ key: "low", type: "text", role: "a", page: 0, x: 0.1, y: 0.9, w: 0.3, h: 0.03, required: true }];
    const out = await stampFields(await build([{ name: "A4", w: 595.28, h: 841.89 }]), fields, { low: { text: "Answer near the foot" } }, { idFooter: TEXT });
    const [page] = await read(out.bytes);
    expect(joined(page.items)).toContain("Answer near the foot");
    expectStampedWell(page);
  });

  it("can never fail: a page it cannot be drawn on is counted and left as it was, and the call still answers", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]);
    // a font that cannot measure anything stands in for whatever might go wrong on an odd page
    const broken = { widthOfTextAtSize: () => { throw new Error("odd page"); }, getCharacterSet: () => [0x20, 0x41] } as never;
    expect(drawIdFooters(doc, { regular: broken }, TEXT)).toEqual({ stamped: 0, skipped: 0, failed: 2 });
    // a document whose pages cannot even be listed is reported, not thrown
    const unreadable = { getPages: () => { throw new Error("no page tree"); } } as never;
    expect(drawIdFooters(unreadable, { regular: broken }, TEXT)).toEqual({ stamped: 0, skipped: 0, failed: 1 });
  });

  it("is covered by the seal: the sealed file verifies and every page still carries the line", async () => {
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    const stamped = await stampFields(await build(SPECS.slice(0, 5)), [], {}, { idFooter: TEXT });
    const sealed = await sealPdf(stamped.bytes, p12, "pw", { signingTime: new Date("2026-10-06T08:00:00Z") });
    const verified = verifySealed(sealed.bytes);
    expect(verified.ok, verified.problems.join("; ")).toBe(true);
    const pages = await read(sealed.bytes);
    expect(pages).toHaveLength(5);
    for (const page of pages) expectStampedWell(page);
  });
});
