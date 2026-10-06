// ============================================================
// Where a placed field goes on a PDF page, including pages stored rotated.
//
// A field is a box in "shown" coordinates: fractions of the page as a reader sees it,
// origin top-left. A PDF page is drawn in its own user space (origin bottom-left, the
// MediaBox size) and may carry /Rotate, so the same shown box lands on a different
// place and direction in user space. This maps one to the other.
// ============================================================

import type { PageInfo } from "./types";

export type Rotation = 0 | 90 | 180 | 270;

export interface UserBox {
  /** The bottom-left corner of the box as the reader sees it, in user space. */
  x: number;
  y: number;
  /** Size along the reader's horizontal and vertical axes, in points. */
  w: number;
  h: number;
  /** Rotate drawing by this many degrees counter-clockwise (pdf-lib `degrees`). */
  angle: Rotation;
}

export function normalizeRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

/**
 * Map a shown box (fractions, top-left origin) to user space for a page whose unrotated
 * MediaBox is `mediaW` x `mediaH` and whose rotation is `rotation`.
 */
export function shownBoxToUser(
  box: { x: number; y: number; w: number; h: number },
  mediaW: number,
  mediaH: number,
  rotation: Rotation,
): UserBox {
  const swapped = rotation === 90 || rotation === 270;
  const shownW = swapped ? mediaH : mediaW;
  const shownH = swapped ? mediaW : mediaH;
  const vx = box.x * shownW; // from the left of the shown page
  const vy = box.y * shownH; // from the top of the shown page
  const w = box.w * shownW;
  const h = box.h * shownH;
  // The drawing origin is the bottom-left corner of the box as shown: (vx, vy + h).
  const ox = vx;
  const oy = vy + h;
  switch (rotation) {
    case 0:
      return { x: ox, y: mediaH - oy, w, h, angle: 0 };
    case 90:
      // shown x runs along user y, shown y runs along user x
      return { x: oy, y: ox, w, h, angle: 90 };
    case 180:
      return { x: mediaW - ox, y: oy, w, h, angle: 180 };
    case 270:
      return { x: mediaW - oy, y: mediaH - ox, w, h, angle: 270 };
  }
}

/** The page as a reader sees it. */
export function pageShownSize(mediaW: number, mediaH: number, rotation: Rotation): Pick<PageInfo, "width" | "height"> {
  return rotation === 90 || rotation === 270 ? { width: mediaH, height: mediaW } : { width: mediaW, height: mediaH };
}

/**
 * Rotate an offset (dx to the right, dy up, as the reader sees it) into user space, so text
 * and images can be positioned relative to a box's origin whatever the page rotation is.
 */
export function offsetToUser(dx: number, dy: number, rotation: Rotation): { x: number; y: number } {
  switch (rotation) {
    case 0:
      return { x: dx, y: dy };
    case 90:
      return { x: -dy, y: dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: dy, y: -dx };
  }
}
