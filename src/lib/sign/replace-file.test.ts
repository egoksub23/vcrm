import { describe, expect, it } from "vitest";

import type { PageInfo, PlacedField } from "./pdf/types";
import { SIZE_TOLERANCE_PT, groupFlagged, insidePage, planReplace, sameSize } from "./replace-file";

const A4: PageInfo = { width: 595.28, height: 841.89, rotation: 0 };
const LETTER: PageInfo = { width: 612, height: 792, rotation: 0 };
const LANDSCAPE: PageInfo = { width: 841.89, height: 595.28, rotation: 0 };

const field = (key: string, page: number, over: Partial<PlacedField> = {}): PlacedField => ({ key, type: "text", role: "merchant", page, x: 0.1, y: 0.2, w: 0.4, h: 0.04, required: false, ...over });

describe("sameSize", () => {
  it("allows the rounding a PDF writer does, and nothing more", () => {
    expect(sameSize(A4, { width: 595.28 + SIZE_TOLERANCE_PT, height: 841.89 - SIZE_TOLERANCE_PT })).toBe(true);
    expect(sameSize(A4, { width: 595.28 + SIZE_TOLERANCE_PT + 0.5, height: 841.89 })).toBe(false);
    expect(sameSize(A4, LETTER)).toBe(false);
    expect(sameSize(A4, LANDSCAPE)).toBe(false);
  });
});

describe("insidePage", () => {
  it("is the layout rule: a positive box that lies inside the page", () => {
    expect(insidePage({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(insidePage({ x: 0.7, y: 0.1, w: 0.4, h: 0.1 })).toBe(false);
    expect(insidePage({ x: -0.1, y: 0.1, w: 0.2, h: 0.1 })).toBe(false);
    expect(insidePage({ x: 0.1, y: 0.1, w: 0, h: 0.1 })).toBe(false);
    expect(insidePage({ x: Number.NaN, y: 0.1, w: 0.2, h: 0.1 })).toBe(false);
  });
});

describe("planReplace", () => {
  it("keeps every field where it is when the page count and the sizes match", () => {
    const fields = [field("a", 0), field("b", 1)];
    const plan = planReplace(fields, [A4, A4], [A4, A4]);
    expect(plan).toMatchObject({ kept: 2, flagged: [], oldPageCount: 2, newPageCount: 2, pageCountChanged: false });
    expect(plan.fields).toEqual(fields);
  });

  it("flags a field whose page is gone, and moves it to the last page so it can still be found and fixed", () => {
    const plan = planReplace([field("a", 0), field("b", 2)], [A4, A4, A4], [A4]);
    expect(plan.flagged).toEqual([{ key: "b", reason: "page_missing", page: 2, movedTo: 0 }]);
    expect(plan.fields.map((f) => [f.key, f.page])).toEqual([["a", 0], ["b", 0]]);
    expect(plan).toMatchObject({ kept: 1, pageCountChanged: true, oldPageCount: 3, newPageCount: 1 });
  });

  it("flags only the fields on a page whose size or shape changed, and leaves them where they are", () => {
    const fields = [field("a", 0), field("b", 1), field("c", 2)];
    const plan = planReplace(fields, [A4, A4, A4], [A4, LETTER, LANDSCAPE]);
    expect(plan.flagged).toEqual([
      { key: "b", reason: "size_changed", page: 1 },
      { key: "c", reason: "size_changed", page: 2 },
    ]);
    expect(plan.fields).toEqual(fields);
    expect(plan.kept).toBe(1);
  });

  it("flags a field that was not inside its page, and keeps the page count change quiet when nothing else moved", () => {
    const plan = planReplace([field("a", 0, { x: 0.8, w: 0.4 })], [A4], [A4, A4]);
    expect(plan.flagged).toEqual([{ key: "a", reason: "outside_page", page: 0 }]);
    // a page added at the end flags nobody by itself
    const grown = planReplace([field("a", 0)], [A4], [A4, A4]);
    expect(grown).toMatchObject({ flagged: [], pageCountChanged: true, kept: 1 });
  });

  it("puts a missing page ahead of the other reasons, and counts every field once", () => {
    const plan = planReplace([field("a", 5, { x: 0.9, w: 0.5 })], [A4], [A4]);
    expect(plan.flagged).toEqual([{ key: "a", reason: "page_missing", page: 5, movedTo: 0 }]);
    expect(plan.kept + plan.flagged.length).toBe(1);
  });

  it("does not change the fields it was given", () => {
    const fields = [field("a", 3)];
    const copy = JSON.parse(JSON.stringify(fields));
    planReplace(fields, [A4], [A4]);
    expect(fields).toEqual(copy);
  });

  it("handles a document with no fields and a field on a page the old file did not have", () => {
    expect(planReplace([], [A4], [LETTER])).toMatchObject({ kept: 0, flagged: [], fields: [] });
    // the old page is unknown (the field was already wrong): nothing to compare, so only a missing new page flags it
    expect(planReplace([field("a", 1)], [A4], [A4, LETTER]).flagged).toEqual([]);
  });
});

describe("groupFlagged", () => {
  it("groups by reason in a fixed order and leaves out empty groups", () => {
    const g = groupFlagged([
      { key: "c", reason: "size_changed", page: 0 },
      { key: "a", reason: "page_missing", page: 4, movedTo: 1 },
      { key: "d", reason: "size_changed", page: 1 },
    ]);
    expect(g.map((x) => [x.reason, x.fields.map((f) => f.key)])).toEqual([["page_missing", ["a"]], ["size_changed", ["c", "d"]]]);
    expect(groupFlagged([])).toEqual([]);
  });
});
