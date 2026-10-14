// ============================================================
// Secure Sign, signing page: the company stamp made from the company's own details. A merchant who has no stamp file can ask the form to
// MAKE one: a round stamp in dark blue ink, the company name round the outer ring (along the top and down both sides, letters facing
// outward), an inner circle with the new registration number on the first line and the old one, in brackets, on the second, and a small
// star at the foot of the ring.
//
// This file is the part with no browser in it, so it is tested by reading the string it makes:
//   stampSvg      the picture as an SVG string (600 x 600, transparent, same input = same output byte for byte)
//   stampInputs   what the picture is made from, read out of the form's own answers (a hidden field counts as empty)
//   dataUrlToFile a PNG data URL as a File called company-stamp.png
// Turning the SVG into a PNG needs a canvas and lives in components/sign/signer/stamp-image.ts.
//
// Fonts: a generic sans-serif stack, no web font. Because the real font is unknown here, every text is given an explicit `textLength` (the
// width worked out from the metrics of Helvetica/Arial) so a wider fallback font is squeezed to fit instead of running into the star, and a
// Chinese, Japanese or Korean name is set smaller. Nothing here throws: any text gives a drawable stamp.
// ============================================================

import { fieldVisible } from "../forms/rules";
import type { AnswerMap, FormDefinition, StampSource } from "../forms/types";

export const STAMP_SIZE = 600;
/** The size of the PNG the browser makes from the SVG: twice the drawing, for print. */
export const STAMP_PNG_SIZE = 1200;
export const STAMP_FILE_NAME = "company-stamp.png";
/** Dark blue ink, as on a rubber stamp. */
export const STAMP_INK = "#2b2f8f";
export const STAMP_FONT_STACK = "'Helvetica Neue', Helvetica, Arial, 'Segoe UI', 'Noto Sans', 'Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC', sans-serif";

/** The longest name or number the drawing is made from (longer is cut: the forms limit them far below this). */
const MAX_NAME_CHARS = 200;
const MAX_NUMBER_CHARS = 30;

// ---- text -------------------------------------------------------------------------------------------------------------

/** Characters XML 1.0 cannot carry at all (most control characters), plus line breaks which a stamp does not have. */
const XML_BAD = /[\u0000-\u001f\u007f-\u009f￾￿]/g;

/** A name as it is stamped: no control characters or line breaks, single spaces, capital letters. */
export function cleanStampName(raw: string): string {
  const s = String(raw ?? "").normalize("NFC").replace(XML_BAD, " ").replace(/\s+/g, " ").trim().toUpperCase();
  return Array.from(s).slice(0, MAX_NAME_CHARS).join("").trim();
}

/** A registration number as it is stamped: no spaces, capital letters. */
export function cleanStampNumber(raw: string): string {
  const s = String(raw ?? "").normalize("NFC").replace(XML_BAD, "").replace(/\s+/g, "").toUpperCase();
  return Array.from(s).slice(0, MAX_NUMBER_CHARS).join("");
}

/** The old number in brackets: any brackets already typed are replaced by one pair; empty stays empty. */
export function bracketed(old: string): string {
  const inner = cleanStampNumber(old).replace(/^[([{（]+/, "").replace(/[)\]}）]+$/, "");
  return inner ? `(${inner})` : "";
}

/** XML-escape text for an element. Only the five characters that matter are touched. */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ---- measuring ----------------------------------------------------------------------------------------------------------

/** Advance widths (thousandths of an em) of Helvetica/Arial for the capitals, digits and marks a registration number or a name uses. */
const ADVANCE: Record<string, number> = {
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778,
  R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556, "8": 556, "9": 556,
  " ": 278, ".": 278, ",": 278, "-": 333, "&": 667, "(": 333, ")": 333, "/": 278, "'": 191, ":": 278, ";": 278, "+": 584, "@": 1015, "*": 389, "!": 278, "?": 556,
};
const DEFAULT_ADVANCE = 700;
const BOLD = 1.05;

/** A character that is a full em wide and tall: Chinese, Japanese and Korean, and the full-width forms. */
export function isWideChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd);
}

export const hasWideChars = (s: string): boolean => Array.from(s).some(isWideChar);

function advance(ch: string): number {
  if (isWideChar(ch)) return 1000;
  if (/\p{M}/u.test(ch)) return 0;
  const direct = ADVANCE[ch];
  if (direct !== undefined) return direct;
  const base = ch.normalize("NFD").charAt(0);
  return ADVANCE[base.toUpperCase()] ?? DEFAULT_ADVANCE;
}

/** The width of `text` at font size `fs` in bold, with `gap` between letters. */
export function textWidth(text: string, fs: number, gap = 0): number {
  const chars = Array.from(text);
  const sum = chars.reduce((w, ch) => w + (advance(ch) * BOLD * fs) / 1000, 0);
  return sum + gap * Math.max(0, chars.length - 1);
}

// ---- the drawing ---------------------------------------------------------------------------------------------------------

const C = STAMP_SIZE / 2;
const R_OUTER = 289;
const R_RING = 270;
const R_INNER = 168;
/** The middle of the band between the inner circle and the thin ring: the name's letters are centred on it. */
const BAND_MID = (R_INNER + R_RING) / 2;
/** The name runs over this many degrees each side of the top; the rest, at the foot, is the star's. */
const ARC_HALF_DEG = 145;
const ARC_RAD = (ARC_HALF_DEG * 2 * Math.PI) / 180;
/** Cap height of the sans-serif fonts in ems. */
const CAP = 0.72;
const NAME_FS = { max: 56, maxWide: 44, min: 18 } as const;

const num = (v: number): string => String(Math.round(v * 100) / 100 + 0);

/** The name round the ring: font size, the radius of its baseline, and the width it is given. Pure, for the tests. */
export interface NameFit {
  fontSize: number;
  radius: number;
  /** The width the text is set to (the `textLength`). */
  length: number;
  /** The length of the arc it sits on. */
  arc: number;
  /** The name does not fit at the smallest size and its letters are squeezed to fit. */
  squeezed: boolean;
}

export function fitName(name: string): NameFit {
  const wide = hasWideChars(name);
  const max = wide ? NAME_FS.maxWide : NAME_FS.max;
  const at = (fs: number) => {
    const radius = BAND_MID - (CAP / 2) * fs;
    const arc = radius * ARC_RAD;
    return { radius, arc, natural: textWidth(name, fs, 0.06 * fs), room: arc * 0.97 };
  };
  for (let fs = max; fs >= NAME_FS.min; fs--) {
    const f = at(fs);
    if (f.natural <= f.room) return { fontSize: fs, radius: f.radius, length: f.natural, arc: f.arc, squeezed: false };
  }
  const f = at(NAME_FS.min);
  return { fontSize: NAME_FS.min, radius: f.radius, length: f.room, arc: f.arc, squeezed: true };
}

interface LineFit {
  fontSize: number;
  length: number;
  squeezed: boolean;
}

/** The largest size, up to `max`, at which `text` is no wider than `width`; below `min` it is squeezed to `width`. */
function fitLine(text: string, max: number, min: number, width: number): LineFit {
  for (let fs = max; fs >= min; fs--) {
    const w = textWidth(text, fs);
    if (w <= width) return { fontSize: fs, length: w, squeezed: false };
  }
  return { fontSize: min, length: width, squeezed: true };
}

function starPoints(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (-90 + i * 36) * (Math.PI / 180);
    const r = i % 2 === 0 ? outer : inner;
    pts.push(`${num(cx + r * Math.cos(a))},${num(cy + r * Math.sin(a))}`);
  }
  return pts.join(" ");
}

export interface StampText {
  /** The company's legal name (any case, any text). */
  name: string;
  /** The new registration number. */
  newNumber: string;
  /** The old registration number, if there is one (with or without brackets). */
  oldNumber?: string;
}

/**
 * The stamp as an SVG document (a string): 600 x 600, nothing behind it. Same input, same string. The name and the numbers are
 * XML-escaped; the name is in capitals. A missing old number leaves the second line out and centres the first.
 */
export function stampSvg(input: StampText): string {
  const name = cleanStampName(input.name);
  const first = cleanStampNumber(input.newNumber);
  const second = bracketed(input.oldNumber ?? "");
  const ink = STAMP_INK;
  const font = `font-family="${STAMP_FONT_STACK}" font-weight="700" fill="${ink}"`;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${STAMP_SIZE}" height="${STAMP_SIZE}" viewBox="0 0 ${STAMP_SIZE} ${STAMP_SIZE}">`);
  out.push(`<title>${xmlEscape(name)}</title>`);
  out.push(`<g fill="none" stroke="${ink}">`);
  out.push(`<circle cx="${C}" cy="${C}" r="${R_OUTER}" stroke-width="9"/>`);
  out.push(`<circle cx="${C}" cy="${C}" r="${R_RING}" stroke-width="3"/>`);
  out.push(`<circle cx="${C}" cy="${C}" r="${R_INNER}" stroke-width="5"/>`);
  out.push("</g>");

  if (name) {
    const fit = fitName(name);
    const half = (ARC_HALF_DEG * Math.PI) / 180;
    // the arc runs clockwise from the lower left, over the top, to the lower right: letters on it face outward and read left to right
    const x0 = C + fit.radius * Math.sin(-half);
    const y0 = C - fit.radius * Math.cos(-half);
    const x1 = C + fit.radius * Math.sin(half);
    const y1 = C - fit.radius * Math.cos(half);
    const offset = Math.max(0, (fit.arc - fit.length) / 2);
    out.push(`<defs><path id="stamp-arc" d="M ${num(x0)} ${num(y0)} A ${num(fit.radius)} ${num(fit.radius)} 0 1 1 ${num(x1)} ${num(y1)}"/></defs>`);
    out.push(
      `<text ${font} font-size="${fit.fontSize}"><textPath href="#stamp-arc" xlink:href="#stamp-arc" startOffset="${num(offset)}" textLength="${num(fit.length)}" lengthAdjust="${fit.squeezed ? "spacingAndGlyphs" : "spacing"}">${xmlEscape(name)}</textPath></text>`,
    );
  }

  // the two inner lines, centred on the stamp (or the first alone, in the middle)
  const lines: { text: string; fit: LineFit; centre: number }[] = [];
  if (first && second) {
    const a = fitLine(first, 54, 20, 296);
    const b = fitLine(second, Math.min(40, Math.round(a.fontSize * 0.8)), 16, 284);
    lines.push({ text: first, fit: a, centre: C - 28 }, { text: second, fit: b, centre: C + 26 });
  } else if (first || second) {
    const only = first || second;
    lines.push({ text: only, fit: fitLine(only, 60, 20, 300), centre: C });
  }
  for (const l of lines) {
    const baseline = l.centre + (CAP / 2) * l.fit.fontSize;
    const adjust = l.fit.squeezed ? ` textLength="${num(l.fit.length)}" lengthAdjust="spacingAndGlyphs"` : "";
    out.push(`<text x="${C}" y="${num(baseline)}" text-anchor="middle" ${font} font-size="${l.fit.fontSize}"${adjust}>${xmlEscape(l.text)}</text>`);
  }

  out.push(`<polygon points="${starPoints(C, C + BAND_MID, 26, 11)}" fill="${ink}"/>`);
  out.push("</svg>");
  return out.join("\n");
}

/** The SVG as a data URL an `<img>` can show (an image document cannot run scripts, whatever the text said). */
export const stampDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// ---- what the stamp is made from -----------------------------------------------------------------------------------------

export interface StampInputs {
  name: string;
  newNumber: string;
  oldNumber: string;
  /** The keys of the fields still to fill in, in the order they are asked (name first). */
  missing: string[];
  /** Not stopping: the new number is not 12 digits. */
  warnNumber: boolean;
}

function answerText(form: Pick<FormDefinition, "parts" | "fields">, key: string | undefined, answers: AnswerMap): string {
  if (!key) return "";
  const field = form.fields.find((f) => f.key === key);
  // an answer to a field that is not shown is ignored, here as everywhere else in the form
  if (!field || !fieldVisible(form as FormDefinition, field, answers)) return "";
  const v = answers[key];
  return v && "text" in v && typeof v.text === "string" ? v.text : "";
}

/** The new registration number is 12 digits, as the Companies Commission issues it. */
export const isNewRegistrationNumber = (s: string): boolean => /^\d{12}$/.test(s);

export function stampInputs(form: Pick<FormDefinition, "parts" | "fields">, source: StampSource, answers: AnswerMap): StampInputs {
  const name = cleanStampName(answerText(form, source.nameField, answers));
  const newNumber = cleanStampNumber(answerText(form, source.newNumberField, answers));
  const oldNumber = cleanStampNumber(answerText(form, source.oldNumberField, answers)).replace(/^[([{（]+/, "").replace(/[)\]}）]+$/, "");
  const missing: string[] = [];
  if (!name) missing.push(source.nameField);
  if (!newNumber) missing.push(source.newNumberField);
  return { name, newNumber, oldNumber, missing, warnNumber: newNumber !== "" && !isNewRegistrationNumber(newNumber) };
}

/** Everything the picture is made from, as one string: two stamps with the same signature look the same. */
export const stampSignature = (i: Pick<StampInputs, "name" | "newNumber" | "oldNumber">): string => JSON.stringify([i.name, i.newNumber, i.oldNumber]);

/** A stamp made earlier from other details than these now: the answers changed since, and the stamp is out of date. */
export const stampIsStale = (madeFrom: string | null, now: Pick<StampInputs, "name" | "newNumber" | "oldNumber">): boolean => madeFrom !== null && madeFrom !== stampSignature(now);

/** Can a stamp be drawn now? Both the name and the new number are there. */
export const canMakeStamp = (i: Pick<StampInputs, "missing">): boolean => i.missing.length === 0;

/** The two ways to give a stamp. */
export type StampWay = "upload" | "create";

/** The way a field opens in: uploading, always; the signer chooses to create. A picture already given is shown in the upload way. */
export const initialStampWay = (): StampWay => "upload";

/**
 * What the "create" card shows. `needs`: the name or the number is not filled in yet, so it says what to fill in and links to it.
 * `preview`: the stamp drawn live from the answers, with "Use this stamp". `saved`: a stamp made here is the field's answer: its
 * thumbnail, "Created from your company details", and the ways to replace or remove it (`replacing`: the person chose to replace it).
 */
export type StampCardState = "needs" | "preview" | "saved";

export function stampCardState(o: { inputs: Pick<StampInputs, "missing">; created: boolean; replacing: boolean }): StampCardState {
  if (o.created && !o.replacing) return "saved";
  return canMakeStamp(o.inputs) ? "preview" : "needs";
}

// ---- the file ----------------------------------------------------------------------------------------------------------------

/** A PNG data URL as a File named company-stamp.png; null for anything that is not a base64 PNG. */
export function dataUrlToFile(dataUrl: string, name = STAMP_FILE_NAME): File | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: "image/png" });
  } catch {
    return null;
  }
}
