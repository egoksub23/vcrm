import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FORM_ISSUE_CODES } from "../client/form-issues";
import { catalogueOf, type ListItem } from "../lists/types";
import type { SignRole } from "../types";
import { checkDataAnswer, displayValue, listOptions, listProblems, referencedLists, resolveFormLists, sameOptions, stripListOptions, validateForm, type DataField, type FormDefinition, type L10n } from "./index";

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });
const roles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];
const items = (...rows: [string, string, string?][]): ListItem[] => rows.map(([value, en, ms]) => ({ value, label: L(en, ms) }));

const STATES = items(["johor", "Johor"], ["kedah", "Kedah"], ["selangor", "Selangor"]);
const MSIC = items(["01111", "Growing of maize", "Penanaman jagung"], ["62010", "Computer programming activities", "Aktiviti pengaturcaraan komputer"], ["47111", "Provision stores", "Kedai runcit"]);
const lists = catalogueOf([
  { key: "states_my", kind: "options", items: STATES },
  { key: "msic", kind: "msic", items: MSIC },
  { key: "empty", kind: "options", items: [] },
  { key: "mostly_hidden", kind: "options", items: [{ value: "a", label: L("A"), archived: true }, { value: "b", label: L("B") }] },
]);

const field = (over: Partial<DataField> & Pick<DataField, "key" | "type">): DataField => ({ part: "p", label: L(over.key), required: false, ...over });
const form = (...fields: DataField[]): FormDefinition => ({ version: 1, parts: [{ key: "p", title: L("Part"), role: "merchant" }], fields });

describe("referencedLists", () => {
  it("names each list once, in the order they are first used", () => {
    expect(referencedLists(form(field({ key: "a", type: "choice", optionList: "states_my" }), field({ key: "b", type: "list", optionList: "msic" }), field({ key: "c", type: "choice", optionList: "states_my" }), field({ key: "d", type: "text" })))).toEqual(["states_my", "msic"]);
    expect(referencedLists(form(field({ key: "a", type: "text" })))).toEqual([]);
  });
});

describe("resolveFormLists", () => {
  it("copies the items into the options of a choice, a multiple choice and a list, keeping the list's key", () => {
    const f = form(field({ key: "state", type: "choice", optionList: "states_my" }), field({ key: "states", type: "multichoice", optionList: "states_my" }), field({ key: "codes", type: "list", optionList: "msic", maxItems: 5 }));
    const { form: out, problems } = resolveFormLists(f, lists);
    expect(problems).toEqual([]);
    expect(out.fields[0]).toMatchObject({ optionList: "states_my", options: [{ value: "johor", label: L("Johor") }, { value: "kedah", label: L("Kedah") }, { value: "selangor", label: L("Selangor") }] });
    expect(out.fields[1].options).toHaveLength(3);
    expect(out.fields[2].options?.[0]).toEqual({ value: "01111", label: L("Growing of maize", "Penanaman jagung") });
    expect(out.fields[2].maxItems).toBe(5);
    // the input is not changed
    expect(f.fields[0].options).toBeUndefined();
  });

  it("leaves a field with its own options exactly as it is, and a form with no list as the same object", () => {
    const inline = field({ key: "t", type: "choice", options: [{ value: "x", label: L("X") }] });
    const f = form(inline);
    const out = resolveFormLists(f, lists);
    expect(out.form).toBe(f);
    expect(out.problems).toEqual([]);
  });

  it("leaves out the archived items: a new form does not offer what the admin hid", () => {
    const out = resolveFormLists(form(field({ key: "c", type: "choice", optionList: "mostly_hidden" })), lists).form;
    expect(out.fields[0].options).toEqual([{ value: "b", label: L("B") }]);
    expect(listOptions([{ value: "a", label: L("A"), archived: true }])).toEqual([]);
  });

  it("takes the list's items over whatever options the field carried (the list is the source)", () => {
    const stale = field({ key: "s", type: "choice", optionList: "states_my", options: [{ value: "old", label: L("Old") }] });
    expect(resolveFormLists(form(stale), lists).form.fields[0].options?.map((o) => o.value)).toEqual(["johor", "kedah", "selangor"]);
  });

  it("is idempotent", () => {
    const once = resolveFormLists(form(field({ key: "s", type: "choice", optionList: "states_my" })), lists).form;
    expect(resolveFormLists(once, lists).form).toEqual(once);
  });

  it("saving a template reports a list that is missing, empty, of a bad key, or on a field that takes no options", () => {
    const f = form(field({ key: "a", type: "choice", optionList: "nope" }), field({ key: "b", type: "choice", optionList: "empty" }), field({ key: "c", type: "choice", optionList: "Bad Key" }), field({ key: "d", type: "text", optionList: "states_my" }));
    expect(resolveFormLists(f, lists, { strict: true }).problems).toEqual([
      { code: "unknown_list", field: "a", detail: "nope" },
      { code: "list_empty", field: "b", detail: "empty" },
      { code: "bad_list_key", field: "c" },
      { code: "list_wrong_type", field: "d" },
    ]);
  });

  it("making or sending a document never fails over a list: a field whose list has gone keeps the options it was prepared with", () => {
    const prepared = field({ key: "a", type: "choice", optionList: "gone", options: [{ value: "kept", label: L("Kept") }] });
    const r = resolveFormLists(form(prepared), lists, { strict: false });
    expect(r.problems).toEqual([]);
    expect(r.form.fields[0].options).toEqual([{ value: "kept", label: L("Kept") }]);
  });
});

describe("a form is frozen: a later change to a list changes nothing already made", () => {
  it("what was resolved is the same after the list changes, until it is resolved again", () => {
    const authored = form(field({ key: "state", type: "choice", optionList: "states_my" }));
    const frozen = resolveFormLists(authored, lists).form;
    const later = catalogueOf([{ key: "states_my", kind: "options", items: [...STATES, ...items(["perak", "Perak"])].map((i) => (i.value === "johor" ? { ...i, label: L("Johor Darul Takzim") } : i)) }]);
    // the frozen form still says what it said
    expect(frozen.fields[0].options?.map((o) => o.value)).toEqual(["johor", "kedah", "selangor"]);
    expect(frozen.fields[0].options?.[0].label.en).toBe("Johor");
    // and its answers are judged by it
    expect(checkDataAnswer(frozen.fields[0], { text: "perak" })).toEqual({ ok: false, code: "not_an_option" });
    expect(checkDataAnswer(frozen.fields[0], { text: "johor" })).toEqual({ ok: true, value: { text: "johor" } });
    expect(displayValue(frozen.fields[0], { text: "johor" }, "en")).toBe("Johor");
    // a new resolution does see the change
    const fresh = resolveFormLists(frozen, later).form;
    expect(fresh.fields[0].options).toHaveLength(4);
    expect(displayValue(fresh.fields[0], { text: "johor" }, "en")).toBe("Johor Darul Takzim");
  });
});

describe("stripListOptions", () => {
  it("removes the options of list-bound fields only, and returns the same object when there is nothing to remove", () => {
    const resolved = resolveFormLists(form(field({ key: "s", type: "choice", optionList: "states_my" }), field({ key: "t", type: "choice", options: [{ value: "x", label: L("X") }] })), lists).form;
    const stripped = stripListOptions(resolved);
    expect(stripped.fields[0]).toEqual({ key: "s", type: "choice", part: "p", label: L("s"), required: false, optionList: "states_my" });
    expect(stripped.fields[1].options).toHaveLength(1);
    const plain = form(field({ key: "t", type: "text" }));
    expect(stripListOptions(plain)).toBe(plain);
    expect(resolveFormLists(stripped, lists).form).toEqual(resolved);
  });
});

describe("listProblems", () => {
  it("accepts a field that names a list or carries options", () => {
    expect(listProblems(form(field({ key: "a", type: "choice", optionList: "states_my" }), field({ key: "b", type: "choice", options: [{ value: "x", label: L("X") }] })))).toEqual([]);
  });

  it("reports a reference to a list that does not exist, only when it is told which exist", () => {
    const f = form(field({ key: "a", type: "choice", optionList: "nope" }));
    expect(listProblems(f)).toEqual([]);
    expect(listProblems(f, { known: new Set(["states_my"]) })).toEqual([{ code: "unknown_list", field: "a", detail: "nope" }]);
    expect(listProblems(form(field({ key: "a", type: "choice", optionList: "states_my" })), { known: new Set(["states_my"]) })).toEqual([]);
  });

  it("as authored, a field names a list or carries options, never both; a resolved form has both and is fine", () => {
    const both = form(field({ key: "a", type: "choice", optionList: "states_my", options: [{ value: "x", label: L("X") }] }));
    expect(listProblems(both, { authored: true })).toEqual([{ code: "list_and_options", field: "a" }]);
    expect(listProblems(both)).toEqual([]);
    expect(listProblems(form(field({ key: "a", type: "choice", optionList: "states_my" })), { authored: true })).toEqual([]);
  });

  it("refuses a malformed key and a type that takes no options", () => {
    expect(listProblems(form(field({ key: "a", type: "choice", optionList: "Not A Key" })))).toEqual([{ code: "bad_list_key", field: "a" }]);
    expect(listProblems(form(field({ key: "a", type: "date", optionList: "states_my" })))).toEqual([{ code: "list_wrong_type", field: "a" }]);
  });

  it("raises only codes the builder can word (every code is in the builder's list of issue codes)", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/sign/forms/lists.ts"), "utf8");
    const codes = [...source.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(5);
    for (const c of new Set(codes)) expect(FORM_ISSUE_CODES as readonly string[], `no message for ${c}`).toContain(c);
  });
});

describe("validateForm with lists", () => {
  it("passes a form as authored (a list and no options) and as resolved (both)", () => {
    const authored = form(field({ key: "state", type: "choice", optionList: "states_my" }), field({ key: "codes", type: "list", optionList: "msic" }));
    expect(validateForm(authored, roles)).toEqual([]);
    expect(validateForm(resolveFormLists(authored, lists).form, roles)).toEqual([]);
  });

  it("reports an unknown list when it is told which exist, and the codes of listProblems", () => {
    const f = form(field({ key: "state", type: "choice", optionList: "nope" }));
    expect(validateForm(f, roles, [], { known: new Set(["states_my"]) })).toEqual([{ code: "unknown_list", field: "state", detail: "nope" }]);
    expect(validateForm(form(field({ key: "d", type: "date", optionList: "states_my" })), roles).map((i) => i.code)).toContain("list_wrong_type");
  });

  it("still needs options on a choice that names no list, and still has the small cap for typed options", () => {
    expect(validateForm(form(field({ key: "c", type: "choice" })), roles).map((i) => i.code)).toEqual(["bad_options"]);
    const many = Array.from({ length: 101 }, (_, i) => ({ value: `v${i}`, label: L(`V${i}`) }));
    expect(validateForm(form(field({ key: "c", type: "choice", options: many })), roles).map((i) => i.code)).toEqual(["bad_options"]);
  });

  it("lets a list's options run to 5,000 and its labels to 300 characters, and still checks their shape", () => {
    const big = Array.from({ length: 1500 }, (_, i) => ({ value: `v${i}`, label: L(`Option ${i}`) }));
    expect(validateForm(form(field({ key: "c", type: "choice", optionList: "countries", options: big })), roles)).toEqual([]);
    const long = [{ value: "a", label: L("x".repeat(250)) }];
    expect(validateForm(form(field({ key: "c", type: "choice", optionList: "msic", options: long })), roles)).toEqual([]);
    expect(validateForm(form(field({ key: "c", type: "choice", options: long })), roles).map((i) => i.code)).toEqual(["bad_options"]);
    const dup = [{ value: "a", label: L("A") }, { value: "a", label: L("B") }];
    expect(validateForm(form(field({ key: "c", type: "choice", optionList: "msic", options: dup })), roles).map((i) => i.code)).toEqual(["bad_options"]);
    const bad = [{ value: "has space", label: L("A") }];
    expect(validateForm(form(field({ key: "c", type: "choice", optionList: "msic", options: bad })), roles).map((i) => i.code)).toEqual(["bad_options"]);
  });

  it("leaves a free-text list field (no options) alone", () => {
    expect(validateForm(form(field({ key: "l", type: "list", itemFormat: "digits", itemLength: 5 })), roles)).toEqual([]);
  });
});

describe("answers to a list-bound field", () => {
  const resolved = resolveFormLists(form(field({ key: "state", type: "choice", optionList: "states_my" }), field({ key: "states", type: "multichoice", optionList: "states_my" }), field({ key: "codes", type: "list", optionList: "msic", maxItems: 2, itemFormat: "digits", itemLength: 5 })), lists).form;
  const [state, states, codes] = resolved.fields;

  it("accepts a value of the list and refuses any other, for a choice and a multiple choice", () => {
    expect(checkDataAnswer(state, { text: "kedah" })).toEqual({ ok: true, value: { text: "kedah" } });
    expect(checkDataAnswer(state, { text: "narnia" })).toEqual({ ok: false, code: "not_an_option" });
    expect(checkDataAnswer(states, { choices: ["johor", "kedah"] })).toEqual({ ok: true, value: { choices: ["johor", "kedah"] } });
    expect(checkDataAnswer(states, { choices: ["johor", "narnia"] })).toEqual({ ok: false, code: "not_an_option" });
  });

  it("takes, for a list of codes, only codes that are in the list, once each, up to the limit", () => {
    expect(checkDataAnswer(codes, { list: ["62010", "47111"] })).toEqual({ ok: true, value: { list: ["62010", "47111"] } });
    expect(checkDataAnswer(codes, { list: ["62010", "99999"] })).toEqual({ ok: false, code: "not_an_option" });
    expect(checkDataAnswer(codes, { list: ["62010", "62010"] })).toEqual({ ok: false, code: "duplicate_item" });
    expect(checkDataAnswer(codes, { list: ["62010", "47111", "01111"] })).toEqual({ ok: false, code: "too_many_items", detail: "2" });
    expect(checkDataAnswer(codes, { list: ["", "62010"] })).toEqual({ ok: true, value: { list: ["62010"] } });
    expect(checkDataAnswer(codes, { list: [] })).toEqual({ ok: true, value: null });
  });

  it("still takes any entry for a list field with no options", () => {
    const free: DataField = field({ key: "free", type: "list", itemFormat: "digits", itemLength: 5 });
    expect(checkDataAnswer(free, { list: ["12345"] })).toEqual({ ok: true, value: { list: ["12345"] } });
  });
});

describe("sameOptions", () => {
  it("compares values, order and wording", () => {
    expect(sameOptions(listOptions(STATES), listOptions(STATES))).toBe(true);
    expect(sameOptions(listOptions(STATES), listOptions(STATES).slice(1))).toBe(false);
    expect(sameOptions(undefined, [])).toBe(true);
    expect(sameOptions(listOptions(STATES), [...listOptions(STATES)].reverse())).toBe(false);
  });
});
