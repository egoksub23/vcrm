// ============================================================
// Doc Sign editor: the arithmetic of a column of pages (pure). Which page is at a scroll position, where a
// page starts, and the fields of each page as arrays that keep their identity when nothing on that page
// changed (so a memoised page layer does not redraw when another page is edited).
// ============================================================

import type { PlacedField } from "../pdf/types";

export interface PageBox {
  /** Visible size in points. */
  width: number;
  height: number;
}

/** Height on screen of every page at `width` pixels wide. */
export function pageHeights(pages: readonly PageBox[], width: number): number[] {
  return pages.map((p) => (p.width > 0 ? (width * p.height) / p.width : 0));
}

/** Where each page starts, measured from the top of the column of pages (`gap` pixels between pages, `top` before the first). */
export function pageTops(heights: readonly number[], gap: number, top = 0): number[] {
  const tops: number[] = [];
  let y = top;
  for (const h of heights) {
    tops.push(y);
    y += h + gap;
  }
  return tops;
}

/**
 * The page the reader is on: the page covering the middle of the visible part, or the nearest one when the
 * middle falls in a gap. `scrollTop` and `viewport` are in the same pixels as `tops`.
 */
export function pageAtOffset(tops: readonly number[], heights: readonly number[], scrollTop: number, viewport: number): number {
  if (tops.length === 0) return 0;
  const mid = scrollTop + viewport / 2;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (tops[m] <= mid) lo = m;
    else hi = m - 1;
  }
  // `lo` is the last page that starts at or above the middle; the next page may be closer when the middle is in the gap
  const next = lo + 1;
  if (next < tops.length && mid > tops[lo] + heights[lo] && tops[next] - mid < mid - (tops[lo] + heights[lo])) return next;
  return lo;
}

function sameItems(a: readonly PlacedField[], b: readonly PlacedField[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const NO_FIELDS: PlacedField[] = [];

/** Fields grouped by page. A page whose fields are the same objects as in `previous` keeps its old array. */
export function groupFieldsByPage(previous: ReadonlyMap<number, PlacedField[]> | null, fields: readonly PlacedField[]): Map<number, PlacedField[]> {
  const fresh = new Map<number, PlacedField[]>();
  for (const f of fields) {
    const list = fresh.get(f.page);
    if (list) list.push(f);
    else fresh.set(f.page, [f]);
  }
  if (previous) {
    for (const [page, list] of fresh) {
      const old = previous.get(page);
      if (old && sameItems(old, list)) fresh.set(page, old);
    }
  }
  return fresh;
}

export const fieldsOnPage = (groups: ReadonlyMap<number, PlacedField[]>, page: number): PlacedField[] => groups.get(page) ?? NO_FIELDS;

// ---- zoom ---------------------------------------------------------------------------------------

export const ZOOM_STEPS = [50, 75, 100, 125, 150, 200] as const;
export type Zoom = "fit" | number;

/** CSS pixels in one point of a page at 100%. */
export const CSS_PX_PER_PT = 96 / 72;

/** The width of a page on screen: the available width for "fit", else the page's natural width at that percentage. */
export function pageWidthPx(zoom: Zoom, firstPageWidthPt: number, available: number): number {
  if (zoom === "fit") return Math.min(1800, Math.max(240, Math.floor(available)));
  const percent = Math.min(200, Math.max(50, zoom));
  return Math.round(firstPageWidthPt * CSS_PX_PER_PT * (percent / 100));
}

/** What percentage a page of `widthPx` pixels is, for the first page's natural width. */
export function percentOfWidth(widthPx: number, firstPageWidthPt: number): number {
  return firstPageWidthPt > 0 ? Math.round((widthPx / (firstPageWidthPt * CSS_PX_PER_PT)) * 100) : 100;
}

/** The next zoom step above or below `current` ("fit" counts as `fitPercent`). */
export function stepZoom(current: Zoom, fitPercent: number, direction: 1 | -1): number {
  const now = current === "fit" ? fitPercent : current;
  if (direction > 0) return ZOOM_STEPS.find((s) => s > now + 0.5) ?? 200;
  return [...ZOOM_STEPS].reverse().find((s) => s < now - 0.5) ?? 50;
}
