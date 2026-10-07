import { describe, expect, it } from "vitest";

import { cleanTitle, defaultOrder, parseOrder } from "./order";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("parseOrder", () => {
  it("reads the JSON text or the list, keeping the order and the titles", () => {
    const list = [{ kind: "file", index: 1, title: " Annex " }, { kind: "template", id: A }, { kind: "file", index: 0 }];
    const expected = [{ kind: "file", index: 1, title: "Annex" }, { kind: "template", id: A }, { kind: "file", index: 0 }];
    expect(parseOrder(JSON.stringify(list), 2)).toEqual({ ok: true, entries: expected });
    expect(parseOrder(list, 2)).toEqual({ ok: true, entries: expected });
  });

  it("needs every file part named once", () => {
    expect(parseOrder([{ kind: "file", index: 0 }], 2)).toEqual({ ok: false, code: "bad_order" });
    expect(parseOrder([{ kind: "file", index: 0 }, { kind: "file", index: 0 }], 2)).toEqual({ ok: false, code: "bad_order" });
    expect(parseOrder([{ kind: "file", index: 2 }, { kind: "file", index: 0 }], 2)).toEqual({ ok: false, code: "bad_order" });
    expect(parseOrder([{ kind: "file", index: -1 }], 1)).toEqual({ ok: false, code: "bad_order" });
    expect(parseOrder([{ kind: "file", index: 0.5 }], 1)).toEqual({ ok: false, code: "bad_order" });
    expect(parseOrder([{ kind: "template", id: A }], 1)).toEqual({ ok: false, code: "bad_order" });
  });

  it("refuses a template twice, a template that is not an id, more than six, and anything that is not a list of entries", () => {
    expect(parseOrder([{ kind: "template", id: A }, { kind: "template", id: A.toUpperCase() }], 0)).toEqual({ ok: false, code: "envelope_duplicate_template" });
    expect(parseOrder([{ kind: "template", id: "x" }], 0)).toEqual({ ok: false, code: "bad_order" });
    expect(parseOrder(Array.from({ length: 7 }, (_, i) => ({ kind: "file", index: i })), 7)).toEqual({ ok: false, code: "envelope_size" });
    for (const junk of [null, 5, "{}", "[1]", [null], [[]], [{ kind: "x" }], { kind: "file", index: 0 }]) expect(parseOrder(junk, 0), JSON.stringify(junk)).toMatchObject({ ok: false });
  });

  it("allows a short list (the size is the service's to judge, with the minimum)", () => {
    expect(parseOrder([], 0)).toEqual({ ok: true, entries: [] });
  });
});

describe("defaultOrder and titles", () => {
  it("is the files as they came, then the templates", () => {
    expect(defaultOrder(2, [A, B])).toEqual([{ kind: "file", index: 0 }, { kind: "file", index: 1 }, { kind: "template", id: A }, { kind: "template", id: B }]);
    expect(defaultOrder(0, [])).toEqual([]);
  });

  it("cleans a title: one line, trimmed, at most 200 characters, empty is none", () => {
    expect(cleanTitle("  a\nb\tc  ")).toBe("a b c");
    expect(cleanTitle("x".repeat(300))).toHaveLength(200);
    expect(cleanTitle("   ")).toBeUndefined();
    expect(cleanTitle(5)).toBeUndefined();
  });
});
