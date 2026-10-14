// ============================================================
// Secure Sign, signing page: the company stamp as a PNG. The drawing is an SVG string (src/lib/sign/client/stamp.ts, no browser needed);
// this is the part that needs one: the SVG is drawn onto a transparent canvas and written as a PNG, 1200 x 1200 for print, which is made
// smaller (900, then 600) only if it would be over the size the server takes for a picture. The result is an ordinary PNG data URL (and a File
// called company-stamp.png): the page saves it exactly like a picture the person chose themselves, and the server cannot tell the two apart.
// ============================================================

import { STAMP_FILE_NAME, STAMP_PNG_SIZE, dataUrlToFile } from "@/lib/sign/client/stamp";
import { TARGET_IMAGE_BYTES, checkImageDataUrl, dataUrlBytes } from "@/lib/sign/client/signer-images";

export type StampPngResult = { ok: true; dataUrl: string; file: File } | { ok: false; reason: "unsupported" | "too_big" };

/** The sides tried, largest first: the stamp is line art and is well under the limit at the first. */
const SIDES = [STAMP_PNG_SIZE, 900, 600] as const;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the stamp drawing could not be read"));
    img.src = url;
  });
}

/** Draw the SVG onto a transparent canvas and write a PNG. Never throws: a browser that cannot do it answers `unsupported`. */
export async function stampSvgToPng(svg: string): Promise<StampPngResult> {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = await loadImage(url);
    for (const side of SIDES) {
      const canvas = document.createElement("canvas");
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, reason: "unsupported" };
      ctx.clearRect(0, 0, side, side);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, side, side);
      const dataUrl = canvas.toDataURL("image/png");
      // the same test the server applies to any picture it is given
      if (dataUrlBytes(dataUrl) > TARGET_IMAGE_BYTES || !checkImageDataUrl(dataUrl)) continue;
      const file = dataUrlToFile(dataUrl, STAMP_FILE_NAME);
      return file ? { ok: true, dataUrl, file } : { ok: false, reason: "unsupported" };
    }
    return { ok: false, reason: "too_big" };
  } catch {
    return { ok: false, reason: "unsupported" };
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
