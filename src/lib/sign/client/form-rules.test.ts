import { describe, expect, it } from "vitest";

import { ruleProblems } from "../forms/rules";
import { MAX_RULE_DEPTH, MAX_RULE_NODES, type Rule } from "../forms/types";
import { fieldOf } from "./form-edit";
import { sampleForm } from "./form-fixtures";
import {
  addCondition,
  addGroup,
  canAdd,
  changeLeafField,
  changeLeafOp,
  describeRule,
  isBlankCondition,
  leafMessageKey,
  newCondition,
  nodeAt,
  operatorsFor,
  removeAt,
  ruleDepth,
  ruleNodeCount,
  ruleText,
  setAt,
  setGroupJoin,
  setLeafValue,
  toggleLeafValue,
  unwrapNot,
  valueChoices,
  withinLimits,
  type LeafRule,
  type RuleTranslator,
} from "./form-rules";

const form = sampleForm();
const f = (k: string) => fieldOf(form, k)!;
const A: Rule = { op: "eq", field: "tax_type", value: "sst" };
const B: Rule = { op: "notEmpty", field: "legal_name" };
const C: Rule = { op: "ne", field: "biz_type", value: "sole" };
const known = new Set(form.fields.map((x) => x.key));

describe("editing the tree", () => {
  it("adds a first condition, then a second as an all-of group", () => {
    expect(addCondition(undefined, [], A)).toEqual(A);
    const two = addCondition(A, [], B);
    expect(two).toEqual({ op: "and", rules: [A, B] });
    expect(addCondition(two, [], C)).toEqual({ op: "and", rules: [A, B, C] });
  });

  it("adds inside a nested group and nests a group", () => {
    const rule = addGroup({ op: "and", rules: [A, B] }, [], "or", C);
    expect(rule).toEqual({ op: "and", rules: [A, B, { op: "or", rules: [C] }] });
    expect(addCondition(rule, [2], A)).toEqual({ op: "and", rules: [A, B, { op: "or", rules: [C, A] }] });
    expect(nodeAt(rule, [2, 0])).toEqual(C);
    expect(nodeAt(rule, [5])).toBeUndefined();
  });

  it("removing a condition collapses a group left with one and drops an empty one", () => {
    expect(removeAt({ op: "and", rules: [A, B] }, [0])).toEqual(B);
    expect(removeAt(A, [])).toBeUndefined();
    const nested: Rule = { op: "and", rules: [A, { op: "or", rules: [B, C] }] };
    expect(removeAt(nested, [1, 0])).toEqual({ op: "and", rules: [A, C] });
    expect(removeAt({ op: "not", rule: A }, [0])).toBeUndefined();
    expect(removeAt({ op: "and", rules: [A, { op: "or", rules: [B] }] }, [1, 0])).toEqual(A);
  });

  it("changing a node does not collapse the group it sits in", () => {
    const wrapped: Rule = { op: "and", rules: [A] };
    expect(setAt(wrapped, [0], B)).toEqual({ op: "and", rules: [B] });
  });

  it("switches a group between all-of and any-of, and unwraps a not", () => {
    expect(setGroupJoin({ op: "and", rules: [A, B] }, [], "or")).toEqual({ op: "or", rules: [A, B] });
    expect(unwrapNot({ op: "not", rule: A }, [])).toEqual(A);
    expect(unwrapNot(A, [])).toBe(A);
  });

  it("measures depth and size and keeps inside the server's limits", () => {
    expect(ruleDepth(A)).toBe(1);
    expect(ruleDepth({ op: "and", rules: [A, { op: "or", rules: [B, C] }] })).toBe(3);
    expect(ruleNodeCount({ op: "and", rules: [A, { op: "or", rules: [B, C] }] })).toBe(5);

    let deep: Rule = A;
    for (let i = 0; i < MAX_RULE_DEPTH - 1; i++) deep = { op: i % 2 ? "and" : "or", rules: [deep] };
    expect(withinLimits(deep)).toBe(true);
    expect(canAdd(deep, [], "group")).toBe(true);
    // a group nested one level deeper than the limit is refused
    let path: number[] = [];
    let cur: Rule = deep;
    while (cur.op === "and" || cur.op === "or") {
      path = [...path, 0];
      cur = cur.rules[0];
    }
    const innermostGroup = path.slice(0, -1);
    expect(canAdd(deep, innermostGroup, "group")).toBe(false);

    const wide: Rule = { op: "and", rules: Array.from({ length: 10 }, () => A) };
    expect(withinLimits(wide)).toBe(true);
    expect(canAdd(wide, [], "condition")).toBe(false);
    const big: Rule = { op: "and", rules: Array.from({ length: 7 }, () => ({ op: "or", rules: [A, B, C] }) as Rule) };
    expect(ruleNodeCount(big)).toBeGreaterThan(MAX_RULE_NODES);
    expect(withinLimits(big)).toBe(false);
  });

  it("everything the editing functions build passes the server's check", () => {
    let rule: Rule | undefined;
    rule = addCondition(rule, [], newCondition(f("tax_type")));
    rule = addCondition(rule, [], newCondition(f("legal_name")));
    rule = addGroup(rule, [], "or", newCondition(f("biz_type")));
    rule = addCondition(rule, [2], newCondition(f("form9")));
    expect(ruleProblems(rule, known)).toEqual([]);
  });
});

describe("what a condition can say", () => {
  it("offers operators by the type of field", () => {
    expect(operatorsFor("choice")).toEqual(["eq", "ne", "in", "empty", "notEmpty"]);
    expect(operatorsFor("yesno")).toEqual(["eq", "ne"]);
    expect(operatorsFor("file")).toEqual(["notEmpty", "empty"]);
    expect(operatorsFor("text")).not.toContain("in");
  });

  it("offers a choice's options and yes / no as values, nothing for free text", () => {
    expect(valueChoices(f("tax_type"))!.map((c) => c.value)).toEqual(["sst", "na"]);
    expect(valueChoices({ ...f("legal_name"), type: "yesno" })!.map((c) => c.value)).toEqual(["yes", "no"]);
    expect(valueChoices(f("legal_name"))).toBeNull();
    expect(valueChoices(undefined)).toBeNull();
  });

  it("starts a condition that is valid at once", () => {
    expect(newCondition(f("tax_type"))).toEqual({ op: "eq", field: "tax_type", value: "sst" });
    expect(newCondition(f("legal_name"))).toEqual({ op: "notEmpty", field: "legal_name" });
    expect(newCondition({ ...f("tax_type"), options: [] })).toEqual({ op: "notEmpty", field: "tax_type" });
    for (const k of known) expect(ruleProblems(newCondition(f(k)), known)).toEqual([]);
  });

  it("re-aims a condition and keeps the operator and value where they still fit", () => {
    const leaf: LeafRule = { op: "eq", field: "tax_type", value: "sst" };
    expect(changeLeafField(leaf, f("biz_type"))).toEqual({ op: "eq", field: "biz_type", value: "sdn_bhd" });
    expect(changeLeafField({ op: "eq", field: "tax_type", value: "na" }, { ...f("tax_type"), key: "tax_kind" })).toEqual({ op: "eq", field: "tax_kind", value: "na" });
    expect(changeLeafField({ op: "in", field: "tax_type", values: ["sst"] }, f("legal_name"))).toEqual({ op: "notEmpty", field: "legal_name" });
  });

  it("changes the operator and carries the values over", () => {
    const eq: LeafRule = { op: "eq", field: "tax_type", value: "na" };
    expect(changeLeafOp(eq, "in", f("tax_type"))).toEqual({ op: "in", field: "tax_type", values: ["na"] });
    expect(changeLeafOp({ op: "in", field: "tax_type", values: ["sst", "na"] }, "ne", f("tax_type"))).toEqual({ op: "ne", field: "tax_type", value: "sst" });
    expect(changeLeafOp(eq, "empty", f("tax_type"))).toEqual({ op: "empty", field: "tax_type" });
    expect(changeLeafOp({ op: "empty", field: "tax_type" }, "eq", f("tax_type"))).toEqual({ op: "eq", field: "tax_type", value: "sst" });
    expect(changeLeafOp(eq, "eq", f("tax_type"))).toBe(eq);
  });

  it("sets and toggles values, keeping the options' order", () => {
    expect(setLeafValue({ op: "eq", field: "x", value: "a" }, "b")).toEqual({ op: "eq", field: "x", value: "b" });
    expect(setLeafValue({ op: "empty", field: "x" }, "b")).toEqual({ op: "empty", field: "x" });
    let leaf: LeafRule = { op: "in", field: "tax_type", values: ["na"] };
    leaf = toggleLeafValue(leaf, "sst", true, ["sst", "na"]) as LeafRule;
    expect(leaf).toEqual({ op: "in", field: "tax_type", values: ["sst", "na"] });
    expect(toggleLeafValue(leaf, "na", false)).toEqual({ op: "in", field: "tax_type", values: ["sst"] });
    expect(isBlankCondition({ op: "in", field: "x", values: [] })).toBe(true);
    expect(isBlankCondition({ op: "eq", field: "x", value: " " })).toBe(true);
    expect(isBlankCondition({ op: "notEmpty", field: "x" })).toBe(false);
  });
});

describe("reading a rule back in plain words", () => {
  const tr: RuleTranslator = {
    leaf: (w) => `${w.fieldLabel} ${leafMessageKey(w.op, w.fieldType)} ${w.values.map((v) => v.label).join("|")}`.trim(),
    join: (join, parts) => parts.join(join === "and" ? " AND " : " OR "),
    not: (t) => `NOT ${t}`,
  };

  it("resolves field and option labels in the language asked for, with a fallback to English", () => {
    const w = describeRule({ op: "eq", field: "tax_type", value: "sst" }, form, "en");
    expect(w).toEqual({ kind: "leaf", op: "eq", field: "tax_type", fieldLabel: "Tax type", fieldType: "choice", values: [{ value: "sst", label: "SST" }] });
    const ms = describeRule({ op: "notEmpty", field: "tax_pct" }, form, "ms");
    expect(ms).toMatchObject({ fieldLabel: "Peratusan cukai" });
    const en = describeRule({ op: "notEmpty", field: "tax_pct" }, form, "ko");
    expect(en).toMatchObject({ fieldLabel: "Tax percentage" });
  });

  it("flags a value the field no longer offers, and a field that is gone", () => {
    const stale = describeRule({ op: "eq", field: "tax_type", value: "gone" }, form, "en");
    expect(stale).toMatchObject({ values: [{ value: "gone", label: "gone", stale: true }] });
    const missing = describeRule({ op: "empty", field: "ghost" }, form, "en");
    expect(missing).toMatchObject({ fieldType: null, fieldLabel: "ghost" });
    expect(leafMessageKey("empty", null)).toBe("unknown");
  });

  it("words the operator by the kind of field", () => {
    expect(leafMessageKey("eq", "choice")).toBe("eq");
    expect(leafMessageKey("eq", "multichoice")).toBe("eq_many");
    expect(leafMessageKey("in", "list")).toBe("in_many");
    expect(leafMessageKey("empty", "file")).toBe("empty_file");
    expect(leafMessageKey("notEmpty", "image")).toBe("notEmpty_file");
    expect(leafMessageKey("empty", "text")).toBe("empty");
  });

  it("joins the parts with the translator's words and brackets nested groups", () => {
    const rule: Rule = { op: "and", rules: [A, { op: "or", rules: [B, C] }, { op: "not", rule: { op: "empty", field: "msic" } }] };
    const text = ruleText(describeRule(rule, form, "en"), tr);
    expect(text).toBe("Tax type eq SST AND (Legal name notEmpty OR Type ne Sole proprietor) AND NOT MSIC codes empty");
    expect(ruleText(describeRule(A, form, "en"), tr)).toBe("Tax type eq SST");
  });
});
