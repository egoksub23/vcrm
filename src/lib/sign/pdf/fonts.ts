// ============================================================
// Fonts for the PDF engine. Noto Sans (regular, bold) for everything the engine writes and
// Dancing Script for typed signatures; both are SIL Open Font Licence, shipped under assets/
// with their licences. They cover Latin (including Malay, Vietnamese), Greek and Cyrillic.
//
// Chinese and Korean need a font that is far too large to ship in the repository. Point
// SIGN_CJK_FONT_PATH at a TrueType or OpenType file on the server (for example Noto Sans CJK) and
// it is used for any character the main font lacks; without it such a character is written as "?"
// and the engine reports an `unsupported_characters` warning so the sender can see it.
// ============================================================

import { readFile } from "node:fs/promises";
import path from "node:path";

import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

const ASSET_DIR = path.join(process.cwd(), "src", "lib", "sign", "pdf", "assets");

const cache = new Map<string, Promise<Uint8Array>>();

function loadBytes(file: string): Promise<Uint8Array> {
  let hit = cache.get(file);
  if (!hit) {
    hit = readFile(file).then((b) => new Uint8Array(b));
    // a failed read must not be remembered
    hit.catch(() => cache.delete(file));
    cache.set(file, hit);
  }
  return hit;
}

export interface EngineFonts {
  regular: PDFFont;
  bold: PDFFont;
  script: PDFFont;
  /** Optional fallback for characters the regular font lacks (Chinese, Korean). */
  cjk: PDFFont | null;
}

/**
 * Embed the engine's fonts in `doc`. The three bundled files are already cut down to Latin (about 70 KB
 * each) and are embedded whole: the library's own subsetter drops glyphs from them (found while
 * rendering, see fonts.test.ts), and a full embed of a small file is the safe choice. The optional
 * CJK font is large, so that one is subset.
 */
export async function embedFonts(doc: PDFDocument): Promise<EngineFonts> {
  doc.registerFontkit(fontkit);
  const [regular, bold, script] = await Promise.all([
    loadBytes(path.join(ASSET_DIR, "NotoSans_400Regular.ttf")),
    loadBytes(path.join(ASSET_DIR, "NotoSans_700Bold.ttf")),
    loadBytes(path.join(ASSET_DIR, "DancingScript_400Regular.ttf")),
  ]);
  const cjkPath = process.env.SIGN_CJK_FONT_PATH?.trim();
  let cjkBytes: Uint8Array | null = null;
  if (cjkPath) {
    try {
      cjkBytes = await loadBytes(cjkPath);
    } catch {
      cjkBytes = null;
    }
  }
  return {
    regular: await doc.embedFont(regular, { subset: false }),
    bold: await doc.embedFont(bold, { subset: false }),
    script: await doc.embedFont(script, { subset: false }),
    cjk: cjkBytes ? await doc.embedFont(cjkBytes, { subset: true }) : null,
  };
}

/** Characters `font` can draw. */
export function supports(font: PDFFont, ch: string): boolean {
  try {
    return font.getCharacterSet().includes(ch.codePointAt(0)!);
  } catch {
    return false;
  }
}

/**
 * Split text into runs that each use one font: the main font where it has the glyph, the CJK font
 * where only that has it. A character neither has becomes "?" and is counted.
 */
export function runsFor(
  text: string,
  main: PDFFont,
  cjk: PDFFont | null,
): { runs: { text: string; font: PDFFont }[]; unsupported: number } {
  const runs: { text: string; font: PDFFont }[] = [];
  let unsupported = 0;
  for (const ch of Array.from(text)) {
    if (ch === "\n" || ch === "\t" || supports(main, ch)) {
      push(runs, ch === "\t" ? " " : ch, main);
    } else if (cjk && supports(cjk, ch)) {
      push(runs, ch, cjk);
    } else {
      unsupported++;
      push(runs, "?", main);
    }
  }
  return { runs, unsupported };
}

function push(runs: { text: string; font: PDFFont }[], text: string, font: PDFFont) {
  const last = runs[runs.length - 1];
  if (last && last.font === font) last.text += text;
  else runs.push({ text, font });
}

/** Width of `text` at `size`, summing the runs. */
export function measureRuns(runs: { text: string; font: PDFFont }[], size: number): number {
  let w = 0;
  for (const r of runs) w += r.font.widthOfTextAtSize(r.text, size);
  return w;
}
