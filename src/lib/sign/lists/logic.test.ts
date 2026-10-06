import { describe, expect, it } from "vitest";

import { cleanItems, itemProblems, listKeyFromName, metaProblems, normalizeSearch, removedValues, resetToDefault, sameItems, searchItems } from "./logic";
import { msicItems } from "./msic";
import { COUNTRIES, STATES_MY } from "./system-lists";
import type { ListItem } from "./types";

const it_ = (value: string, en: string, extra: Partial<ListItem["label"]> = {}, more: Partial<ListItem> = {}): ListItem => ({ value, label: { en, ...extra }, ...more });

describe("listKeyFromName", () => {
  it("makes a stable lower-case key, unique among the keys taken", () => {
    expect(listKeyFromName("Our suppliers", new Set())).toBe("our_suppliers");
    expect(listKeyFromName("Our suppliers", new Set(["our_suppliers"]))).toBe("our_suppliers_2");
    expect(listKeyFromName("Our suppliers", new Set(["our_suppliers", "our_suppliers_2"]))).toBe("our_suppliers_3");
    expect(listKeyFromName("Café & Bistro 2", new Set())).toBe("cafe_bistro_2");
  });

  it("starts with a letter, is never empty and never longer than the limit", () => {
    expect(listKeyFromName("2024 targets", new Set())).toBe("l_2024_targets");
    expect(listKeyFromName("马来西亚", new Set())).toBe("list");
    expect(listKeyFromName("x".repeat(100), new Set()).length).toBeLessThanOrEqual(40);
    expect(listKeyFromName("banks_my", new Set(["banks_my"]))).toBe("banks_my_2");
  });
});

describe("metaProblems", () => {
  it("wants a name of up to 120 characters and a description of up to 500", () => {
    expect(metaProblems({ name: "Suppliers", description: "x" })).toEqual([]);
    expect(metaProblems({})).toEqual([]);
    expect(metaProblems({ name: "  " })).toEqual([{ code: "bad_name" }]);
    expect(metaProblems({ name: "x".repeat(121) })).toEqual([{ code: "bad_name" }]);
    expect(metaProblems({ description: "x".repeat(501) })).toEqual([{ code: "bad_description" }]);
    expect(metaProblems({ description: null })).toEqual([]);
  });
});

describe("itemProblems", () => {
  it("accepts sound items", () => {
    expect(itemProblems([it_("a", "A"), it_("b_2", "B", { ms: "Bee", zh: "乙" }, { group: "g", archived: true })], "options")).toEqual([]);
    expect(itemProblems([], "options")).toEqual([]);
  });

  it("names every problem once, with the value it is about", () => {
    const codes = (items: unknown, kind: "options" | "msic" = "options") => itemProblems(items, kind).map((i) => `${i.code}:${i.field}`);
    expect(codes("nope")).toEqual(["bad_items:undefined"]);
    expect(codes([it_("a", "A"), it_("a", "Again")])).toEqual(["duplicate_value:a"]);
    expect(codes([it_("has space", "x")])).toEqual(["bad_value:has space"]);
    expect(codes([it_("a", " ")])).toEqual(["bad_label:a"]);
    expect(codes([it_("a", "x".repeat(301))])).toEqual(["label_too_long:a"]);
    expect(codes([it_("a", "A", {}, { group: "g".repeat(41) })])).toEqual(["bad_group:a"]);
    expect(codes([it_("1234", "Four")], "msic")).toEqual(["bad_msic_code:1234"]);
    expect(codes([it_("12345", "Five")], "msic")).toEqual([]);
    expect(codes([null, 5, { value: 1, label: {} }])).toEqual(["bad_item:1", "bad_item:2", "bad_item:3"]);
  });

  it("refuses a language that is not one of ours", () => {
    expect(itemProblems([{ value: "a", label: { en: "A", fr: "Un" } }], "options")).toEqual([{ code: "bad_label", field: "a" }]);
  });

  it("refuses more than 5,000 items", () => {
    const many = Array.from({ length: 5001 }, (_, i) => it_(`v${i}`, `Item ${i}`));
    expect(itemProblems(many, "options")).toEqual([{ code: "too_many_items", detail: "5000" }]);
  });
});

describe("cleanItems", () => {
  it("keeps only what an item is made of, trimmed", () => {
    const messy = [{ value: "a", label: { en: " A ", ms: " ", zh: "", ko: " 가 " }, group: " g ", archived: false, junk: 1 }] as unknown as ListItem[];
    expect(cleanItems(messy)).toEqual([{ value: "a", label: { en: "A", ko: "가" }, group: "g" }]);
    expect(cleanItems([it_("a", "A", {}, { archived: true })])).toEqual([{ value: "a", label: { en: "A" }, archived: true }]);
  });
});

describe("what a list may lose", () => {
  it("lists the values that are gone", () => {
    expect(removedValues([it_("a", "A"), it_("b", "B")], [it_("b", "Bee")])).toEqual(["a"]);
    expect(removedValues([it_("a", "A")], [it_("a", "A"), it_("c", "C")])).toEqual([]);
  });

  it("puts a system list back as shipped and keeps what the workspace added", () => {
    const shipped = [it_("a", "Apple", { ms: "Epal" }), it_("b", "Banana")];
    const edited = [it_("b", "Pisang!", { ms: "Pisang" }, { archived: true }), it_("a", "Apple (changed)"), it_("mine", "Mine")];
    const back = resetToDefault(edited, shipped);
    expect(back.map((i) => i.value)).toEqual(["a", "b", "mine"]);
    expect(back[0]).toEqual(shipped[0]);
    expect(back[1]).toEqual(shipped[1]);
    expect(back[2]).toEqual(edited[2]);
    // a copy: changing the result never changes the shipped data
    back[0].label.en = "x";
    expect(shipped[0].label.en).toBe("Apple");
    expect(sameItems(resetToDefault(shipped, shipped), shipped)).toBe(true);
  });
});

describe("searchItems", () => {
  const states = STATES_MY;

  it("returns everything (up to the limit) for an empty search", () => {
    expect(searchItems(states, "", "en")).toHaveLength(16);
    expect(searchItems(states, "   ", "en", 5)).toHaveLength(5);
  });

  it("finds by a word of the label, in any case, without accents", () => {
    expect(searchItems(states, "SELANG", "en").map((i) => i.value)).toEqual(["selangor"]);
    expect(normalizeSearch("  Pulau   PINANG ")).toBe("pulau pinang");
    expect(searchItems(COUNTRIES, "cote", "en").map((i) => i.value)).toEqual(["CI"]);
    expect(searchItems(COUNTRIES, "reunion", "en").map((i) => i.value)).toEqual(["RE"]);
  });

  it("needs every word, in any order", () => {
    expect(searchItems(states, "w.p. lumpur", "en").map((i) => i.value)).toEqual(["wp_kuala_lumpur"]);
    expect(searchItems(states, "lumpur zzz", "en")).toEqual([]);
  });

  it("finds a name in another language, whatever language the page is in", () => {
    expect(searchItems(COUNTRIES, "singapura", "en").map((i) => i.value)).toEqual(["SG"]);
    expect(searchItems(COUNTRIES, "新加坡", "ms").map((i) => i.value)).toEqual(["SG"]);
    expect(searchItems(COUNTRIES, "싱가포르", "en")[0].value).toBe("SG");
  });

  it("puts a code that starts with the search first, then a label that starts with it, then the rest", () => {
    const list = [it_("x1", "Ocean food"), it_("food_1", "Plain"), it_("x2", "Food court")];
    expect(searchItems(list, "food", "en").map((i) => i.value)).toEqual(["food_1", "x2", "x1"]);
  });

  it("searches the MSIC list by code or by words, in English or Bahasa Melayu", () => {
    const msic = msicItems();
    expect(searchItems(msic, "62010", "en")[0].value).toBe("62010");
    expect(searchItems(msic, "6201", "en").map((i) => i.value)).toContain("62010");
    expect(searchItems(msic, "computer programming", "en")[0].value).toBe("62010");
    expect(searchItems(msic, "pengaturcaraan komputer", "ms")[0].value).toBe("62010");
    expect(searchItems(msic, "maize", "en").map((i) => i.value)).toContain("01111");
    expect(searchItems(msic, "provision stores", "en")[0].value).toBe("47111");
    // the group is searchable too: a division number lists its classes
    expect(searchItems(msic, "62", "en", 100).filter((i) => i.value.startsWith("62")).length).toBe(5);
  });

  it("is fast enough to run on every keystroke over the whole MSIC list", () => {
    const msic = msicItems();
    const started = performance.now();
    for (let i = 0; i < 20; i++) searchItems(msic, "retail sale of", "en");
    expect((performance.now() - started) / 20).toBeLessThan(40);
  });

  it("stops at the limit", () => {
    expect(searchItems(msicItems(), "a", "en", 50)).toHaveLength(50);
  });
});
