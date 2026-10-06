// ============================================================
// Doc Sign, signing page: turning a drawing or a picture into a data URL small enough to store. The
// arithmetic is in src/lib/sign/client/signer-images.ts; this is the part that needs a canvas.
// ============================================================

import {
  SIGNATURE_MAX_HEIGHT,
  SIGNATURE_MAX_WIDTH,
  TARGET_IMAGE_BYTES,
  UPLOAD_MAX_SIDE,
  dataUrlBytes,
  fitWithin,
  nextSmaller,
  padBounds,
  trimBounds,
} from "@/lib/sign/client/signer-images";

function newCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
}

/** Draw `source` into a canvas of `size`, optionally on white, and write it as PNG or JPEG. */
function encode(source: CanvasImageSource, from: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }, type: "image/png" | "image/jpeg", quality?: number): string | null {
  const out = newCanvas(size.width, size.height);
  if (!out) return null;
  if (type === "image/jpeg") {
    out.ctx.fillStyle = "#ffffff";
    out.ctx.fillRect(0, 0, size.width, size.height);
  }
  out.ctx.imageSmoothingQuality = "high";
  out.ctx.drawImage(source, from.x, from.y, from.width, from.height, 0, 0, size.width, size.height);
  return out.canvas.toDataURL(type, quality);
}

/**
 * The ink on a drawing pad as a PNG: cut to the ink with a small margin, scaled to fit 600 x 200 (never
 * enlarged) and made smaller still until it is under the size limit. Null when nothing is drawn.
 */
export function canvasToSignaturePng(source: HTMLCanvasElement): string | null {
  const ctx = source.getContext("2d");
  if (!ctx || source.width === 0 || source.height === 0) return null;
  const pixels = ctx.getImageData(0, 0, source.width, source.height);
  const ink = trimBounds(pixels.data, source.width, source.height);
  if (!ink) return null;
  const box = padBounds(ink, Math.round(Math.max(source.width, source.height) * 0.01) + 2, source.width, source.height);
  let size: { width: number; height: number } | null = fitWithin(box.width, box.height, SIGNATURE_MAX_WIDTH, SIGNATURE_MAX_HEIGHT);
  while (size) {
    const url = encode(source, box, size, "image/png");
    if (url && dataUrlBytes(url) > 0 && dataUrlBytes(url) <= TARGET_IMAGE_BYTES) return url;
    size = nextSmaller(size);
  }
  return null;
}

export type PictureResult = { ok: true; dataUrl: string } | { ok: false; reason: "unreadable" | "too_big" };

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void } | null> {
  try {
    if (typeof createImageBitmap === "function") {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    }
  } catch {
    // fall through to an <img>
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/**
 * A picture the person chose, made small enough: a signature is scaled to fit 600 x 200 and kept as a
 * PNG (so a transparent background stays); any other picture is scaled to 1600 on its longer side and
 * written as JPEG. Either is made smaller until it is under the size limit.
 */
export async function fileToImageDataUrl(file: File, kind: "signature" | "picture"): Promise<PictureResult> {
  const img = await decode(file);
  if (!img || img.width === 0 || img.height === 0) return { ok: false, reason: "unreadable" };
  try {
    const whole = { x: 0, y: 0, width: img.width, height: img.height };
    if (kind === "signature") {
      let size: { width: number; height: number } | null = fitWithin(img.width, img.height, SIGNATURE_MAX_WIDTH, SIGNATURE_MAX_HEIGHT);
      while (size) {
        const url = encode(img.source, whole, size, "image/png");
        if (url && dataUrlBytes(url) <= TARGET_IMAGE_BYTES) return { ok: true, dataUrl: url };
        size = nextSmaller(size);
      }
      return { ok: false, reason: "too_big" };
    }
    let size: { width: number; height: number } | null = fitWithin(img.width, img.height, UPLOAD_MAX_SIDE, UPLOAD_MAX_SIDE);
    while (size) {
      for (const quality of [0.85, 0.7, 0.55]) {
        const url = encode(img.source, whole, size, "image/jpeg", quality);
        if (url && dataUrlBytes(url) <= TARGET_IMAGE_BYTES) return { ok: true, dataUrl: url };
      }
      size = nextSmaller(size);
    }
    return { ok: false, reason: "too_big" };
  } finally {
    img.close();
  }
}
