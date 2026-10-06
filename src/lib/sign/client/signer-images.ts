// ============================================================
// Doc Sign, signing page: the pure parts of making a signature or a picture small enough to be stored.
//
// The server accepts a data URL of a PNG or JPEG of at most MAX_IMAGE_BYTES (src/lib/sign/rules.ts). The
// drawing itself happens on a canvas in the browser (components/sign/signer/image-utils.ts); what is
// decided here is arithmetic: where the ink is, how big the result may be, whether it is under the limit.
// No DOM, no Node: `atob` exists in both.
// ============================================================

import { MAX_IMAGE_BYTES } from "../rules";

/** A drawn or uploaded signature is scaled to fit inside this (never enlarged). */
export const SIGNATURE_MAX_WIDTH = 600;
export const SIGNATURE_MAX_HEIGHT = 200;
/** A picture entered in an upload field is scaled so its longer side is at most this. */
export const UPLOAD_MAX_SIDE = 1600;
/** Aim a little under the limit, so a small difference in how the bytes are counted never tips it over. */
export const TARGET_IMAGE_BYTES = Math.floor(MAX_IMAGE_BYTES * 0.9);

const DATA_URL_RE = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/;

/** The number of bytes a base64 data URL decodes to (0 when it is not one). */
export function dataUrlBytes(dataUrl: string): number {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return 0;
  const b64 = m[2];
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Which image the bytes really are, from the first bytes (a data URL can claim any type). */
export function sniffImage(dataUrl: string): "image/png" | "image/jpeg" | null {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  let head: string;
  try {
    head = atob(m[2].slice(0, 8));
  } catch {
    return null;
  }
  const b = Array.from(head, (c) => c.charCodeAt(0));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

/**
 * The same test the server applies to an image answer (`decodeImageDataUrl`), without Node's Buffer so it
 * can run in the browser: a PNG or JPEG data URL, really that image, not empty, within the limit.
 */
export function checkImageDataUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = DATA_URL_RE.exec(value);
  if (!m) return false;
  if (m[2].length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) return false;
  const bytes = dataUrlBytes(value);
  if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) return false;
  return sniffImage(value) === m[1];
}

/** `width x height` scaled down (never up) to fit inside `maxWidth x maxHeight`, whole pixels, at least 1. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The smallest rectangle holding every pixel that has ink (alpha above `alphaMin`), from RGBA bytes.
 * Null for an empty canvas.
 */
export function trimBounds(rgba: ArrayLike<number>, width: number, height: number, alphaMin = 8): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] > alphaMin) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** `bounds` grown by `pad` pixels on every side, kept inside a `width x height` canvas. */
export function padBounds(bounds: Bounds, pad: number, width: number, height: number): Bounds {
  const x = Math.max(0, bounds.x - pad);
  const y = Math.max(0, bounds.y - pad);
  const right = Math.min(width, bounds.x + bounds.width + pad);
  const bottom = Math.min(height, bounds.y + bounds.height + pad);
  return { x, y, width: right - x, height: bottom - y };
}

/** The next, smaller size to try when an image is still over the limit (80 percent of each side), or null when it cannot shrink. */
export function nextSmaller(size: { width: number; height: number }): { width: number; height: number } | null {
  const width = Math.floor(size.width * 0.8);
  const height = Math.floor(size.height * 0.8);
  if (width < 24 || height < 8) return null;
  return { width, height };
}
