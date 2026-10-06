import { describe, expect, it } from "vitest";

import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import { ROLE_COLORS, ROLE_COLOR_COUNT, SENDER_COLOR, roleColor, roleColorIndex, roleColorStyle } from "./colors";
import { COALESCE_MS, HISTORY_LIMIT, canRedo, canUndo, initHistory, isPresent, pushState, redo, undo, type EditorState } from "./editor-history";
import { CSS_PX_PER_PT, fieldsOnPage, groupFieldsByPage, pageAtOffset, pageHeights, pageTops, pageWidthPx, percentOfWidth, stepZoom } from "./editor-pages";
import { formatDate, formatSampleNumber, initialsOf, sampleValue, type SampleContext } from "./editor-preview";

const f = (key: string, page = 0, over: Partial<PlacedField> = {}): PlacedField => ({ key, type: "text", role: "a", page, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: true, ...over });
const state = (n: number): EditorState => ({ fields: [f(`f_${n}`)], roles: [] as SignRole[] });

describe("role colours", () => {
  it("has six colours, each with a light and a dark value", () => {
    expect(ROLE_COLORS).toHaveLength(6);
    expect(new Set(ROLE_COLORS.map((c) => c.name)).size).toBe(6);
    for (const c of ROLE_COLORS) {
      for (const side of [c.light, c.dark]) {
        expect(side.solid).toMatch(/^#[0-9a-f]{6}$/);
        expect(side.fill).toMatch(/^rgba\(/);
        expect(side.text).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(c.light.solid).not.toBe(c.dark.solid);
    }
    expect(ROLE_COLOR_COUNT).toBe(6);
  });
  it("wraps any slot into 0..5", () => {
    expect(roleColorIndex(6)).toBe(0);
    expect(roleColorIndex(-1)).toBe(5);
    expect(roleColorIndex(2.7)).toBe(2);
    expect(roleColorIndex(NaN)).toBe(0);
    expect(roleColor(7)).toBe(ROLE_COLORS[1]);
  });
  it("gives CSS variables that follow light and dark, and a neutral colour for the sender", () => {
    const style = roleColorStyle(1) as Record<string, string>;
    expect(style["--rc-solid"]).toBe(`light-dark(${ROLE_COLORS[1].light.solid}, ${ROLE_COLORS[1].dark.solid})`);
    expect(Object.keys(style).sort()).toEqual(["--rc-fill", "--rc-solid", "--rc-text"]);
    expect((roleColorStyle(null) as Record<string, string>)["--rc-solid"]).toContain(SENDER_COLOR.light.solid);
    expect((roleColorStyle(2, "light") as Record<string, string>)["--rc-solid"]).toBe(ROLE_COLORS[2].light.solid);
  });
});

describe("history", () => {
  it("undoes and redoes whole states", () => {
    let h = initHistory(state(0));
    h = pushState(h, state(1), { now: 0 });
    h = pushState(h, state(2), { now: 10_000 });
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
    h = undo(h);
    expect(h.present.fields[0].key).toBe("f_1");
    h = undo(h);
    expect(h.present.fields[0].key).toBe("f_0");
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present.fields[0].key).toBe("f_1");
    expect(canRedo(h)).toBe(true);
  });
  it("drops the redo list when something new is done", () => {
    let h = initHistory(state(0));
    h = pushState(h, state(1), { now: 0 });
    h = undo(h);
    h = pushState(h, state(5), { now: 5000 });
    expect(canRedo(h)).toBe(false);
  });
  it("ignores a push of the same state", () => {
    const h = initHistory(state(0));
    expect(pushState(h, h.present)).toBe(h);
    expect(isPresent(h, { fields: h.present.fields, roles: h.present.roles })).toBe(true);
    expect(isPresent(h, state(0))).toBe(false);
  });
  it("merges quick edits of the same thing into one step", () => {
    let h = initHistory(state(0));
    h = pushState(h, state(1), { coalesceKey: "label:f_0", now: 0 });
    h = pushState(h, state(2), { coalesceKey: "label:f_0", now: COALESCE_MS - 1 });
    h = pushState(h, state(3), { coalesceKey: "label:f_0", now: COALESCE_MS * 3 });
    expect(h.past).toHaveLength(2);
    h = undo(h);
    expect(h.present.fields[0].key).toBe("f_2");
    h = undo(h);
    expect(h.present.fields[0].key).toBe("f_0");
  });
  it("does not merge edits of different things, or an edit with no step before it", () => {
    let h = initHistory(state(0));
    h = pushState(h, state(1), { coalesceKey: "a", now: 0 });
    h = pushState(h, state(2), { coalesceKey: "b", now: 10 });
    expect(h.past).toHaveLength(2);
  });
  it("keeps at most the limit", () => {
    let h = initHistory(state(0));
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = pushState(h, state(i), { now: i * 5000 });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.present.fields[0].key).toBe(`f_${HISTORY_LIMIT + 20}`);
  });
});

describe("pages", () => {
  const pages = [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
    { width: 800, height: 600 },
  ];
  it("measures heights and tops", () => {
    const heights = pageHeights(pages, 300);
    expect(heights).toEqual([400, 400, 225]);
    expect(pageTops(heights, 16)).toEqual([0, 416, 832]);
    expect(pageTops(heights, 16, 20)).toEqual([20, 436, 852]);
  });
  it("finds the page in the middle of the view", () => {
    const heights = pageHeights(pages, 300);
    const tops = pageTops(heights, 16);
    expect(pageAtOffset(tops, heights, 0, 300)).toBe(0);
    expect(pageAtOffset(tops, heights, 300, 300)).toBe(1);
    expect(pageAtOffset(tops, heights, 900, 300)).toBe(2);
    expect(pageAtOffset(tops, heights, 5000, 300)).toBe(2);
    expect(pageAtOffset([], [], 0, 100)).toBe(0);
  });
  it("picks the nearer page when the middle is in the gap", () => {
    const heights = [100, 100];
    const tops = pageTops(heights, 40);
    expect(pageAtOffset(tops, heights, 100, 20)).toBe(0);
    expect(pageAtOffset(tops, heights, 130, 20)).toBe(1);
  });
  it("keeps the array of a page nothing changed on", () => {
    const a = f("a", 0);
    const b = f("b", 1);
    const first = groupFieldsByPage(null, [a, b]);
    const edited = { ...b, x: 0.5 };
    const second = groupFieldsByPage(first, [a, edited]);
    expect(second.get(0)).toBe(first.get(0));
    expect(second.get(1)).not.toBe(first.get(1));
    expect(second.get(1)).toEqual([edited]);
    expect(fieldsOnPage(second, 7)).toEqual([]);
    expect(fieldsOnPage(second, 7)).toBe(fieldsOnPage(second, 8));
  });
});

describe("zoom", () => {
  it("sizes a page at a percentage of its natural width, or to fit", () => {
    expect(pageWidthPx(100, 600, 999)).toBe(Math.round(600 * CSS_PX_PER_PT));
    expect(pageWidthPx(50, 600, 999)).toBe(400);
    expect(pageWidthPx(500, 600, 999)).toBe(1600);
    expect(pageWidthPx("fit", 600, 700.9)).toBe(700);
    expect(pageWidthPx("fit", 600, 10)).toBe(240);
    expect(pageWidthPx("fit", 600, 99999)).toBe(1800);
  });
  it("reports the percentage of a width and steps through the zoom levels", () => {
    expect(percentOfWidth(800, 600)).toBe(100);
    expect(percentOfWidth(400, 600)).toBe(50);
    expect(percentOfWidth(400, 0)).toBe(100);
    expect(stepZoom(100, 80, 1)).toBe(125);
    expect(stepZoom(100, 80, -1)).toBe(75);
    expect(stepZoom("fit", 90, 1)).toBe(100);
    expect(stepZoom("fit", 90, -1)).toBe(75);
    expect(stepZoom(200, 80, 1)).toBe(200);
    expect(stepZoom(50, 80, -1)).toBe(50);
  });
});

describe("preview values", () => {
  const ctx: SampleContext = { now: new Date(2026, 9, 5), locale: "en", signerName: "Ali bin Ahmad", textPlaceholder: "Text" };
  it("writes dates with the field format", () => {
    const d = new Date(2026, 0, 7);
    expect(formatDate(d, "DD MMM YYYY", "en")).toBe("07 Jan 2026");
    expect(formatDate(d, "D MMMM YYYY", "en")).toBe("7 January 2026");
    expect(formatDate(d, "DD/MM/YYYY")).toBe("07/01/2026");
    expect(formatDate(d, "YY-M-D")).toBe("26-1-7");
    expect(formatDate(d, undefined)).toBe("07 Jan 2026");
    expect(formatDate(d, "MMM", "not a locale!!")).toBe("Jan");
  });
  it("writes a sample number with its decimals", () => {
    expect(formatSampleNumber(undefined)).toBe("1,235");
    expect(formatSampleNumber(2)).toBe("1,234.57");
  });
  it("takes initials from a name", () => {
    expect(initialsOf("Ali bin Ahmad")).toBe("ABA");
    expect(initialsOf("")).toBe("");
  });
  it("shows a typed name for signatures, today for the signing date, merge values for merge fields", () => {
    expect(sampleValue(f("s", 0, { type: "signature" }), ctx)).toEqual({ kind: "script", text: "Ali bin Ahmad" });
    expect(sampleValue(f("i", 0, { type: "initials" }), ctx)).toEqual({ kind: "script", text: "ABA" });
    expect(sampleValue(f("d", 0, { type: "date_signed", dateFormat: "DD/MM/YYYY" }), ctx)).toEqual({ kind: "text", text: "05/10/2026" });
    expect(sampleValue(f("m", 0, { merge: "company" }), { ...ctx, mergeValues: { company: "Kedai Runcit" } })).toEqual({ kind: "text", text: "Kedai Runcit" });
    expect(sampleValue(f("m", 0, { merge: "company" }), ctx)).toEqual({ kind: "text", text: "{{company}}", missing: true });
    expect(sampleValue(f("t", 0, { type: "static_text", text: "Fixed", role: "sender" }), ctx).text).toBe("Fixed");
    expect(sampleValue(f("c", 0, { type: "checkbox" }), ctx).kind).toBe("check");
    expect(sampleValue(f("u", 0, { type: "upload" }), ctx).kind).toBe("image");
    expect(sampleValue(f("o", 0, { type: "dropdown", options: ["Yes", "No"] }), ctx).text).toBe("Yes");
    expect(sampleValue(f("x", 0, { type: "text", label: "Address" }), ctx).text).toBe("Address");
    expect(sampleValue(f("n", 0, { type: "number", decimals: 2 }), ctx).text).toBe("1,234.57");
  });
});
