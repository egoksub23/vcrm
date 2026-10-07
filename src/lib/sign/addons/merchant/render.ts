// ============================================================
// Merchant Application: draws the layout (layout.ts) onto a PDF with the bundled fonts, and summarizes a
// layout for the committed file that guards against drift. Node only (reads the fonts). Used by
// scripts/build-merchant-template.ts and by the tests; the installer reads the committed PDF, it never draws.
// ============================================================

import { createHash } from "node:crypto";

import { PDFDocument, rgb, type PDFFont } from "pdf-lib";

import { embedFonts, supports } from "../../pdf/fonts";
import type { PlacedField } from "../../pdf/types";
import { buildMerchantLayout, type LayoutOp, type MerchantLayout, type Tone } from "./layout";

const TONES: Record<Tone, ReturnType<typeof rgb>> = {
  ink: rgb(0.1, 0.12, 0.18),
  muted: rgb(0.36, 0.39, 0.45),
  faint: rgb(0.5, 0.53, 0.58),
  bar: rgb(0.17, 0.22, 0.32),
  white: rgb(1, 1, 1),
  line: rgb(0.6, 0.62, 0.67),
  tint: rgb(0.978, 0.98, 0.985),
  panel: rgb(0.935, 0.945, 0.965),
};

/** What a committed layout file records: enough to see drift without carrying every drawing instruction. */
export interface LayoutSummary {
  pageCount: number;
  pageSize: { w: number; h: number };
  opCount: number;
  opsSha256: string;
  placements: PlacedField[];
}

export function summarize(layout: MerchantLayout): LayoutSummary {
  return {
    pageCount: layout.pageCount,
    pageSize: layout.pageSize,
    opCount: layout.ops.length,
    opsSha256: createHash("sha256").update(JSON.stringify(layout.ops)).digest("hex"),
    placements: layout.placements,
  };
}

/** The fingerprint written into the PDF, so a file that is not made from the current layout is caught. */
export const summarySha256 = (s: LayoutSummary) => createHash("sha256").update(JSON.stringify(s)).digest("hex");

/** The text of every drawing instruction must be drawable and must fit the column it was given. */
function checkText(op: Extract<LayoutOp, { k: "text" }>, font: PDFFont, problems: string[]) {
  for (const ch of Array.from(op.text)) {
    if (!supports(font, ch)) problems.push(`the font cannot draw "${ch}" in "${op.text}"`);
  }
  const width = font.widthOfTextAtSize(op.text, op.size);
  if (op.maxW !== undefined && width > op.maxW + 0.01) {
    problems.push(`"${op.text}" is ${width.toFixed(1)} pt wide at ${op.size} pt, its column is ${op.maxW.toFixed(1)} pt`);
  }
  return width;
}

export async function renderMerchantPdf(layout: MerchantLayout = buildMerchantLayout()): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await embedFonts(doc);
  const pages = Array.from({ length: layout.pageCount }, () => doc.addPage([layout.pageSize.w, layout.pageSize.h]));
  const H = layout.pageSize.h;
  const problems: string[] = [];

  for (const op of layout.ops) {
    const page = pages[op.page];
    if (op.k === "rect") {
      page.drawRectangle({
        x: op.x,
        y: H - op.y - op.h,
        width: op.w,
        height: op.h,
        ...(op.fill ? { color: TONES[op.fill] } : {}),
        ...(op.stroke ? { borderColor: TONES[op.stroke], borderWidth: op.lw ?? 0.6 } : {}),
      });
    } else if (op.k === "line") {
      page.drawLine({ start: { x: op.x1, y: H - op.y1 }, end: { x: op.x2, y: H - op.y2 }, thickness: op.lw, color: TONES[op.tone] });
    } else {
      const font = op.bold ? fonts.bold : fonts.regular;
      const width = checkText(op, font, problems);
      const x = op.align === "right" ? op.x - width : op.x;
      // `y` is the top of the capital letters; the baseline is a cap height lower
      page.drawText(op.text, { x, y: H - op.y - op.size * 0.73, size: op.size, font, color: TONES[op.tone] });
    }
  }

  if (problems.length > 0) throw new Error(["merchant template: " + problems.length + " text problem(s):", ...problems].join("\n"));

  const summary = summarize(layout);
  doc.setTitle("Merchant Application / Permohonan Peniaga");
  doc.setSubject(`layout:${summarySha256(summary)}`);
  doc.setProducer("Vircle Secure Sign");
  doc.setCreator("Vircle Secure Sign");
  doc.setCreationDate(new Date("2026-10-06T00:00:00Z"));
  doc.setModificationDate(new Date("2026-10-06T00:00:00Z"));
  return doc.save({ useObjectStreams: false });
}

/** The two files the add-on ships: the PDF and the summary of its layout. */
export async function buildMerchantAssets(): Promise<{ pdf: Uint8Array; summary: LayoutSummary; summaryJson: string }> {
  const layout = buildMerchantLayout();
  const summary = summarize(layout);
  return { pdf: await renderMerchantPdf(layout), summary, summaryJson: `${JSON.stringify(summary, null, 2)}\n` };
}
