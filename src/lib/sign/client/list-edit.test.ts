import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ListItem } from "../lists/types";
import { IMPORT_PROBLEM_CODES, LIST_ERROR_CODES, appendItem, draftOf, draftProblems, emptyDraft, hasRoom, importProblemKey, itemFromDraft, itemsChanged, listErrorKey, moveItemBy, paginate, replaceItem, setItemArchived } from "./list-edit";
import { pickerKey } from "./picker-keys";

const item = (value: string, en: string, more: Partial<ListItem> = {}): ListItem => ({ value, label: { en }, ...more });
const three = [item("a", "A"), item("b", "B"), item("c", "C")];

describe("paging", () => {
  it("cuts a list into pages of 50, keeping the page it is asked for within what exists", () => {
    const many = Array.from({ length: 120 }, (_, i) => i);
    expect(paginate(many, 1)).toMatchObject({ page: 1, pages: 3, total: 120 });
    expect(paginate(many, 1).rows).toHaveLength(50);
    expect(paginate(many, 3).rows).toEqual(many.slice(100));
    expect(paginate(many, 9).page).toBe(3);
    expect(paginate(many, 0).page).toBe(1);
    expect(paginate([], 4)).toEqual({ rows: [], page: 1, pages: 1, total: 0 });
  });
});

describe("an item as a form", () => {
  it("round-trips, leaving out empty languages and an empty group", () => {
    const full = item("62010", "Computer programming", { group: "62", label: { en: "Computer programming", ms: "Pengaturcaraan", zh: "编程" } });
    expect(draftOf(full)).toEqual({ value: "62010", en: "Computer programming", ms: "Pengaturcaraan", zh: "编程", ko: "", group: "62" });
    expect(itemFromDraft(draftOf(full))).toEqual(full);
    expect(itemFromDraft({ ...emptyDraft(), value: " a ", en: " A ", ms: "  " })).toEqual({ value: "a", label: { en: "A" } });
  });

  it("carries a hidden item's flag over when it is edited", () => {
    const hidden = item("a", "A", { archived: true });
    expect(itemFromDraft({ ...draftOf(hidden), en: "A2" }, hidden)).toEqual({ value: "a", label: { en: "A2" }, archived: true });
  });

  it("says what is wrong with a new item, and does not look at the value of an existing one", () => {
    const taken = new Set(["a"]);
    expect(draftProblems({ ...emptyDraft(), value: "b", en: "B" }, "options", taken, true)).toEqual([]);
    expect(draftProblems(emptyDraft(), "options", taken, true)).toEqual(["empty_value", "empty_label"]);
    expect(draftProblems({ ...emptyDraft(), value: "has space", en: "x" }, "options", taken, true)).toEqual(["bad_value"]);
    expect(draftProblems({ ...emptyDraft(), value: "a", en: "x" }, "options", taken, true)).toEqual(["duplicate_value"]);
    expect(draftProblems({ ...emptyDraft(), value: "1234", en: "x" }, "msic", taken, true)).toEqual(["bad_msic_code"]);
    expect(draftProblems({ ...emptyDraft(), value: "12345", en: "x" }, "msic", taken, true)).toEqual([]);
    expect(draftProblems({ ...emptyDraft(), value: "a", en: "" }, "options", taken, false)).toEqual(["empty_label"]);
    expect(draftProblems({ ...emptyDraft(), value: "b", en: "x".repeat(301) }, "options", taken, true)).toEqual(["label_too_long"]);
    expect(draftProblems({ ...emptyDraft(), value: "b", en: "x", group: "g".repeat(41) }, "options", taken, true)).toEqual(["group_too_long"]);
  });
});

describe("changing the items", () => {
  it("adds last, replaces one in place, and does not touch the input", () => {
    expect(appendItem(three, item("d", "D")).map((i) => i.value)).toEqual(["a", "b", "c", "d"]);
    expect(replaceItem(three, "b", item("b", "Bee")).map((i) => i.label.en)).toEqual(["A", "Bee", "C"]);
    expect(three).toHaveLength(3);
    expect(hasRoom(three)).toBe(true);
    expect(hasRoom(Array.from({ length: 5000 }, (_, i) => item(`v${i}`, "x")))).toBe(false);
  });

  it("archives and restores an item", () => {
    const hidden = setItemArchived(three, "b", true);
    expect(hidden[1]).toEqual({ value: "b", label: { en: "B" }, archived: true });
    expect(hidden[0]).toBe(three[0]);
    expect(setItemArchived(hidden, "b", false)[1]).toEqual(three[1]);
    expect("archived" in setItemArchived(hidden, "b", false)[1]).toBe(false);
  });

  it("moves an item up or down in the whole list, and not off either end", () => {
    expect(moveItemBy(three, "b", -1).map((i) => i.value)).toEqual(["b", "a", "c"]);
    expect(moveItemBy(three, "b", 1).map((i) => i.value)).toEqual(["a", "c", "b"]);
    expect(moveItemBy(three, "a", -1).map((i) => i.value)).toEqual(["a", "b", "c"]);
    expect(moveItemBy(three, "c", 1).map((i) => i.value)).toEqual(["a", "b", "c"]);
    expect(moveItemBy(three, "zz", 1).map((i) => i.value)).toEqual(["a", "b", "c"]);
    expect(itemsChanged(three, moveItemBy(three, "b", -1))).toBe(true);
    expect(itemsChanged(three, [...three])).toBe(false);
  });
});

describe("wording a failure", () => {
  it("has a message key for every known code and a generic one for the rest", () => {
    expect(listErrorKey("list_values_locked")).toBe("errors.list_values_locked");
    expect(listErrorKey("something_new")).toBe("errors.generic");
    expect(listErrorKey(null)).toBe("errors.generic");
    expect(importProblemKey("code_padded")).toBe("import.problems.code_padded");
    expect(importProblemKey("something_new")).toBe("import.problems.unknown");
  });

  it("covers every code the checks and the routes can answer with", () => {
    const root = join(process.cwd(), "src/lib/sign");
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    // codes the item checks raise
    const raised = new Set([...read("lists/logic.ts").matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]));
    for (const c of raised) expect(LIST_ERROR_CODES as readonly string[], `no message for ${c}`).toContain(c);
    // codes the service answers with (`invalid_layout` is what saving a template says about its lists: the builder words it)
    const served = new Set([...read("service/lists.ts").matchAll(/new SignError\("([a-z_]+)"/g)].map((m) => m[1]).filter((c) => c !== "invalid_layout"));
    for (const c of served) expect(LIST_ERROR_CODES as readonly string[], `no message for ${c}`).toContain(c);
    // problems found in an imported file
    const found = new Set([...read("lists/csv.ts").matchAll(/(?:err|fail)\("([a-z_]+)"|code: "([a-z_]+)"/g)].map((m) => m[1] ?? m[2]).filter((c) => c !== undefined));
    for (const c of found) expect(IMPORT_PROBLEM_CODES as readonly string[], `no message for ${c}`).toContain(c);
  });
});

// Once the messages are merged into messages/*.json (Sign.lists), every code must be worded in every language.
const catalogue = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign?: { lists?: { errors?: Record<string, unknown>; import?: { problems?: Record<string, unknown> } } } };
const merged = catalogue("en").Sign?.lists !== undefined;
describe.runIf(merged)("the Lists screen's messages in the catalogues", () => {
  for (const locale of ["en", "ms", "zh", "ko"]) {
    it(`words every error and every import problem in ${locale}`, () => {
      const lists = catalogue(locale).Sign?.lists;
      for (const code of LIST_ERROR_CODES) expect(lists?.errors?.[code], `errors.${code}`).toBeTypeOf("string");
      expect(lists?.errors?.generic).toBeTypeOf("string");
      for (const code of IMPORT_PROBLEM_CODES) expect(lists?.import?.problems?.[code], `import.problems.${code}`).toBeTypeOf("string");
      expect(lists?.import?.problems?.unknown).toBeTypeOf("string");
    });
  }
});

describe("the search picker's keyboard", () => {
  const closed = { open: false, active: 0 };
  const open = (active = 0) => ({ open: true, active });

  it("opens on an arrow, then moves through the matches without leaving the box", () => {
    expect(pickerKey("ArrowDown", closed, 5)).toEqual({ handled: true, state: open(0) });
    expect(pickerKey("ArrowDown", open(0), 5).state).toEqual(open(1));
    expect(pickerKey("ArrowDown", open(4), 5).state).toEqual(open(4));
    expect(pickerKey("ArrowUp", open(2), 5).state).toEqual(open(1));
    expect(pickerKey("ArrowUp", open(0), 5).state).toEqual(open(0));
    expect(pickerKey("Home", open(3), 5).state).toEqual(open(0));
    expect(pickerKey("End", open(1), 5).state).toEqual(open(4));
    expect(pickerKey("Home", closed, 5).handled).toBe(false);
  });

  it("picks the highlighted match on Enter, and never lets Enter through to the form", () => {
    expect(pickerKey("Enter", open(2), 5)).toMatchObject({ handled: true, pick: true, state: open(2) });
    // closed, or nothing to pick: Enter opens the list and is still not passed on
    expect(pickerKey("Enter", closed, 5)).toEqual({ handled: true, state: open(0) });
    expect(pickerKey("Enter", open(0), 0)).toEqual({ handled: true, state: open(0) });
  });

  it("closes on Escape (dropping what was typed), and on Tab leaves without taking the key", () => {
    expect(pickerKey("Escape", open(3), 5)).toEqual({ handled: true, state: closed, cancel: true });
    expect(pickerKey("Escape", closed, 5).handled).toBe(false);
    expect(pickerKey("Tab", open(1), 5)).toEqual({ handled: false, state: closed, cancel: true });
    expect(pickerKey("a", open(1), 5)).toEqual({ handled: false, state: open(1) });
  });

  it("keeps the highlight in range when there are no matches", () => {
    expect(pickerKey("ArrowDown", open(0), 0).state).toEqual(open(0));
    expect(pickerKey("End", open(0), 0).state).toEqual(open(0));
  });
});
