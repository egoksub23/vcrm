// ============================================================
// Writing field values onto a PDF: the "freeze" at send (merge and static fields) and the render
// of what the signers entered. The same code does both; only the values differ.
// ============================================================

import { PDFDocument, PDFFont, PDFImage, PDFPage, degrees, rgb } from "pdf-lib";

import { embedFonts, measureRuns, runsFor, type EngineFonts } from "./fonts";
import {
  DEFAULT_DATE_FORMAT,
  fitText,
  formatDate,
  formatIsoDate,
  formatNumber,
  type EngineLocale,
} from "./format";
import { normalizeRotation, offsetToUser, shownBoxToUser, type Rotation } from "./geometry";
import { openPdf, savePdf, sha256Hex } from "./load";
import type { FieldValue, FieldValues, PlacedField, StampOptions, StampResult, StampWarning } from "./types";

const INK = rgb(0.06, 0.07, 0.12);
const PAD = 2;

interface PageGeom {
  page: PDFPage;
  originX: number;
  originY: number;
  width: number;
  height: number;
  rotation: Rotation;
}

function geomOf(page: PDFPage): PageGeom {
  const box = page.getCropBox();
  return {
    page,
    originX: box.x,
    originY: box.y,
    width: box.width,
    height: box.height,
    rotation: normalizeRotation(page.getRotation().angle),
  };
}

/** Where `field` sits on its page, in user space, with the page's own origin added. */
function userBox(field: PlacedField, g: PageGeom) {
  const b = shownBoxToUser(field, g.width, g.height, g.rotation);
  return { ...b, x: b.x + g.originX, y: b.y + g.originY };
}

/** Move from a box origin by a shown-space offset (right, up). */
function at(box: { x: number; y: number }, dx: number, dy: number, rotation: Rotation) {
  const o = offsetToUser(dx, dy, rotation);
  return { x: box.x + o.x, y: box.y + o.y };
}

interface Ctx {
  doc: PDFDocument;
  fonts: EngineFonts;
  locale: EngineLocale;
  timeZone: string;
  warnings: StampWarning[];
  images: Map<Uint8Array, PDFImage>;
}

/** The text a field shows for `value`, or null when it shows no text. */
function textFor(field: PlacedField, value: FieldValue, ctx: Ctx): string | null {
  switch (field.type) {
    case "date_signed":
      return value.at ? formatDate(value.at, field.dateFormat ?? DEFAULT_DATE_FORMAT, ctx.locale, ctx.timeZone) : (value.text ?? null);
    case "date":
      return value.text ? formatIsoDate(value.text, field.dateFormat ?? DEFAULT_DATE_FORMAT, ctx.locale) : null;
    case "number":
      return value.text ? formatNumber(value.text, field.decimals) : null;
    case "static_text":
    case "text":
    case "name":
    case "dropdown":
    case "upload":
      return value.text ? value.text : null;
    default:
      return null;
  }
}

function drawFittedText(page: PDFPage, field: PlacedField, text: string, g: PageGeom, ctx: Ctx, opts: { font?: "regular" | "bold" | "script"; fixedSize?: number; multiline?: boolean }) {
  const box = userBox(field, g);
  const main: PDFFont = ctx.fonts[opts.font ?? "regular"];
  const cjk = opts.font === "script" ? null : ctx.fonts.cjk;
  const { runs, unsupported } = runsFor(text, main, cjk);
  if (unsupported > 0) {
    ctx.warnings.push({ field: field.key, code: "unsupported_characters", detail: String(unsupported) });
  }
  // The size search asks about the same strings at every size, and shaping a string is the costly part (fontkit): a string is shaped once, at a
  // fixed size, and its width at any other size is that width scaled (a width is exactly proportional to the size).
  const widths = new Map<string, number>();
  const REFERENCE_SIZE = 1000;
  const measureAt = (size: number) => (s: string) => {
    let w = widths.get(s);
    if (w === undefined) {
      w = measureRuns(runsFor(s, main, cjk).runs, REFERENCE_SIZE);
      widths.set(s, w);
    }
    return (w * size) / REFERENCE_SIZE;
  };
  const display = runs.map((r) => r.text).join("");
  const fit = fitText(display, { w: box.w, h: box.h }, measureAt, {
    multiline: opts.multiline ?? field.multiline,
    fixedSize: opts.fixedSize ?? field.fontSize,
    padding: PAD,
  });
  if (fit.truncated) ctx.warnings.push({ field: field.key, code: "text_truncated" });

  const ascent = main.heightAtSize(fit.fontSize, { descender: false });
  const total = main.heightAtSize(fit.fontSize);
  const descent = total - ascent;
  const multi = fit.lines.length > 1 || (opts.multiline ?? field.multiline);

  fit.lines.forEach((line, i) => {
    const lineRuns = runsFor(line, main, cjk).runs;
    const width = measureRuns(lineRuns, fit.fontSize);
    const align = field.align ?? (field.type === "number" ? "right" : "left");
    const dx = align === "center" ? (box.w - width) / 2 : align === "right" ? box.w - PAD - width : PAD;
    const baseline = multi
      ? box.h - PAD - ascent - i * fit.lineHeight
      : (box.h - (ascent + descent)) / 2 + descent;
    let cursor = dx;
    for (const run of lineRuns) {
      const p = at(box, cursor, baseline, g.rotation);
      page.drawText(run.text, { x: p.x, y: p.y, size: fit.fontSize, font: run.font, color: INK, rotate: degrees(box.angle) });
      cursor += run.font.widthOfTextAtSize(run.text, fit.fontSize);
    }
  });
}

async function imageFor(value: FieldValue["image"], ctx: Ctx, field: string): Promise<PDFImage | null> {
  if (!value) return null;
  const hit = ctx.images.get(value.bytes);
  if (hit) return hit;
  try {
    const img = value.mime === "image/png" ? await ctx.doc.embedPng(value.bytes) : await ctx.doc.embedJpg(value.bytes);
    ctx.images.set(value.bytes, img);
    return img;
  } catch {
    ctx.warnings.push({ field, code: "bad_image" });
    return null;
  }
}

function drawImageFit(page: PDFPage, field: PlacedField, img: PDFImage, g: PageGeom) {
  const box = userBox(field, g);
  const maxW = Math.max(box.w - PAD * 2, 1);
  const maxH = Math.max(box.h - PAD * 2, 1);
  const scale = Math.min(maxW / img.width, maxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const p = at(box, (box.w - w) / 2, (box.h - h) / 2, g.rotation);
  page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: degrees(box.angle) });
}

function drawCheck(page: PDFPage, field: PlacedField, g: PageGeom) {
  const box = userBox(field, g);
  const side = Math.min(box.w, box.h) - PAD * 2;
  if (side <= 0) return;
  const ox = (box.w - side) / 2;
  const oy = (box.h - side) / 2;
  const pt = (fx: number, fy: number) => at(box, ox + side * fx, oy + side * fy, g.rotation);
  const stroke = Math.max(side * 0.12, 0.8);
  const a = pt(0.14, 0.52);
  const b = pt(0.4, 0.2);
  const c = pt(0.86, 0.8);
  page.drawLine({ start: a, end: b, thickness: stroke, color: INK });
  page.drawLine({ start: b, end: c, thickness: stroke, color: INK });
}

/**
 * Write `values` onto the fields of a PDF. A field with no value is left blank. Returns the new
 * file (plain cross-reference table, ready for certificate pages and a signature) and any warnings.
 */
export async function stampFields(
  input: Uint8Array,
  fields: readonly PlacedField[],
  values: FieldValues,
  options: StampOptions = {},
): Promise<StampResult> {
  const doc = await openPdf(input);
  const fonts = await embedFonts(doc);
  const ctx: Ctx = {
    doc,
    fonts,
    locale: options.locale ?? "en",
    timeZone: options.timeZone ?? "UTC",
    warnings: [],
    images: new Map(),
  };
  const pages = doc.getPages();
  const geoms = pages.map(geomOf);

  for (const field of fields) {
    const value = values[field.key];
    if (!value) continue;
    const g = geoms[field.page];
    if (!g) {
      ctx.warnings.push({ field: field.key, code: "missing_page", detail: String(field.page) });
      continue;
    }
    const page = g.page;

    if (field.type === "checkbox") {
      if (value.checked) drawCheck(page, field, g);
      continue;
    }

    if (field.type === "signature" || field.type === "initials") {
      const img = await imageFor(value.image, ctx, field.key);
      if (img) {
        drawImageFit(page, field, img, g);
      } else if (value.typed?.trim()) {
        drawFittedText(page, field, value.typed.trim(), g, ctx, { font: "script", multiline: false, fixedSize: field.fontSize });
      }
      continue;
    }

    if (field.type === "upload" && value.image) {
      const img = await imageFor(value.image, ctx, field.key);
      if (img) drawImageFit(page, field, img, g);
      continue;
    }

    const text = textFor(field, value, ctx);
    if (text) drawFittedText(page, field, text, g, ctx, { font: "regular" });
  }

  const bytes = await savePdf(doc);
  return { bytes, warnings: ctx.warnings };
}

/**
 * The values of the fields the sender fixes before sending: static text, and any field bound to a
 * merge key. Used for the "freeze" step, so the base file already carries them.
 */
export function staticValues(fields: readonly PlacedField[], merge: Readonly<Record<string, unknown>>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f.merge) {
      const v = merge[f.merge];
      if (v !== undefined && v !== null && String(v) !== "") out[f.key] = { text: String(v) };
    } else if (f.type === "static_text" && f.text) {
      out[f.key] = { text: f.text };
    }
  }
  return out;
}

/** The fields whose value comes from a person, as opposed to the sender's static and merge fields. */
export function answerFields(fields: readonly PlacedField[]): PlacedField[] {
  return fields.filter((f) => !f.merge && !f.data && f.type !== "static_text");
}

/** Freeze: write the static and merge values onto the template file and fingerprint the result. */
export async function freezeBase(
  template: Uint8Array,
  fields: readonly PlacedField[],
  merge: Readonly<Record<string, unknown>>,
  options: StampOptions = {},
): Promise<StampResult & { sha256: string }> {
  const staticFields = fields.filter((f) => !f.data && (f.merge || f.type === "static_text"));
  const result = await stampFields(template, staticFields, staticValues(staticFields, merge), options);
  return { ...result, sha256: sha256Hex(result.bytes) };
}
