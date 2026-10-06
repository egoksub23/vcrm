// ============================================================
// Replace the file of a draft (F-77): the new file takes the old one's place and the fields already placed stay where they are
// when they still fit. This is the pure half: which fields keep their place and which are flagged, so the dialog can say so
// BEFORE anything changes and the server applies the very same decision. No I/O.
//
// Fields are placed as fractions of the page as a reader sees it (pdf/types.ts), so a field keeps working on any page of any size;
// what can go wrong is that it no longer means the same thing:
//   page_missing   the new file has fewer pages: the field's page is gone. It is moved to the last page (so it can still be seen and
//                  fixed in the editor) and flagged.
//   size_changed   the page it is on is a different size or shape (A4 became Letter, portrait became landscape): its fraction now
//                  points somewhere else on the new page. It stays where it is and is flagged to be checked.
//   outside_page   the field's own box is not inside the page (it was already wrong, or a page of an unknown size): flagged.
// A page count that differs without any of the above is reported (`pageCountChanged`) but flags nothing by itself: a file with a page
// added at the end leaves every field where it was.
// ============================================================

import type { PageInfo, PlacedField } from "./pdf/types";

/** Pages whose shown width and height are within this many points of each other are "the same size" (PDF writers round). */
export const SIZE_TOLERANCE_PT = 2;

export const FLAG_REASONS = ["page_missing", "size_changed", "outside_page"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export interface FlaggedField {
  key: string;
  reason: FlagReason;
  /** The 0-based page the field was on. */
  page: number;
  /** For page_missing: the page it was moved to. */
  movedTo?: number;
}

export interface ReplacePlan {
  /** The fields as they will be stored: unchanged, except those moved off a page that is gone. */
  fields: PlacedField[];
  kept: number;
  flagged: FlaggedField[];
  oldPageCount: number;
  newPageCount: number;
  pageCountChanged: boolean;
}

export const sameSize = (a: Pick<PageInfo, "width" | "height">, b: Pick<PageInfo, "width" | "height">): boolean =>
  Math.abs(a.width - b.width) <= SIZE_TOLERANCE_PT && Math.abs(a.height - b.height) <= SIZE_TOLERANCE_PT;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Is the field's box inside the page, by the rule the layout check uses (rules.ts `outside_page`)? */
export function insidePage(f: Pick<PlacedField, "x" | "y" | "w" | "h">): boolean {
  return [f.x, f.y, f.w, f.h].every(finite) && f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0 && f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001;
}

export function planReplace(fields: readonly PlacedField[], oldPages: readonly PageInfo[], newPages: readonly PageInfo[]): ReplacePlan {
  const flagged: FlaggedField[] = [];
  const last = Math.max(0, newPages.length - 1);
  const out = fields.map((f): PlacedField => {
    if (!Number.isInteger(f.page) || f.page >= newPages.length) {
      flagged.push({ key: f.key, reason: "page_missing", page: f.page, movedTo: last });
      return { ...f, page: last };
    }
    if (!insidePage(f)) {
      flagged.push({ key: f.key, reason: "outside_page", page: f.page });
      return f;
    }
    const before = oldPages[f.page];
    if (before && !sameSize(before, newPages[f.page])) flagged.push({ key: f.key, reason: "size_changed", page: f.page });
    return f;
  });
  return {
    fields: out,
    kept: fields.length - flagged.length,
    flagged,
    oldPageCount: oldPages.length,
    newPageCount: newPages.length,
    pageCountChanged: oldPages.length !== newPages.length,
  };
}

/** Flagged fields grouped by reason, in the order the dialog lists them. */
export function groupFlagged(flagged: readonly FlaggedField[]): { reason: FlagReason; fields: FlaggedField[] }[] {
  return FLAG_REASONS.map((reason) => ({ reason, fields: flagged.filter((f) => f.reason === reason) })).filter((g) => g.fields.length > 0);
}
