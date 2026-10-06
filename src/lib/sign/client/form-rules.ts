// ============================================================
// Doc Sign form builder: editing a rule without typing code. A rule (types.ts `Rule`) is a small tree of
// conditions ("Tax type is SST") joined by "all of" / "any of" groups. The builder shows it as rows made from
// lists; this file is everything under those rows: which operators suit a field, which values to offer,
// adding / changing / removing a node by its path, keeping inside the limits the server enforces, and the
// rule read back in plain words as structured data (so the sentence is translated, never concatenated here).
// Pure: no React, no I/O.
// ============================================================

import { pick, yesNoWord } from "../forms/text";
import { MAX_RULE_DEPTH, MAX_RULE_NODES, type DataField, type DataFieldType, type FormDefinition, type L10n, type Rule } from "../forms/types";
import type { SignLocale } from "../types";

export type LeafRule = Extract<Rule, { op: "eq" | "ne" | "in" | "empty" | "notEmpty" }>;
export type GroupRule = Extract<Rule, { op: "and" | "or" | "not" }>;
export type LeafOp = LeafRule["op"];
export type GroupJoin = GroupRule["op"];

export const LEAF_OPS: readonly LeafOp[] = ["eq", "ne", "in", "empty", "notEmpty"];
/** rules.ts ruleProblems: a group has 1 to 10 children; an "in" has 1 to 50 values. */
export const MAX_GROUP_CHILDREN = 10;
export const MAX_IN_VALUES = 50;
export const MAX_RULE_VALUE_LENGTH = 200;

export const isGroup = (r: Rule): r is GroupRule => r.op === "and" || r.op === "or" || r.op === "not";
export const isLeaf = (r: Rule): r is LeafRule => !isGroup(r);

/** Where a node is: the child index to take at each level. A `not` has one child, at index 0. */
export type RulePath = readonly number[];

export function childrenOf(rule: Rule): Rule[] {
  if (rule.op === "and" || rule.op === "or") return rule.rules;
  if (rule.op === "not") return [rule.rule];
  return [];
}

export function nodeAt(rule: Rule | undefined, path: RulePath): Rule | undefined {
  let node = rule;
  for (const i of path) {
    if (!node) return undefined;
    node = childrenOf(node)[i];
  }
  return node;
}

/** Levels in the tree (a lone condition is 1). The server allows MAX_RULE_DEPTH. */
export function ruleDepth(rule: Rule): number {
  return 1 + Math.max(0, ...childrenOf(rule).map(ruleDepth));
}

export function ruleNodeCount(rule: Rule): number {
  return 1 + childrenOf(rule).reduce((n, c) => n + ruleNodeCount(c), 0);
}

/** Is the rule inside every limit the server applies to its shape (depth, size, group width, value count)? */
export function withinLimits(rule: Rule): boolean {
  if (ruleDepth(rule) > MAX_RULE_DEPTH || ruleNodeCount(rule) > MAX_RULE_NODES) return false;
  const ok = (r: Rule): boolean => {
    if (r.op === "and" || r.op === "or") return r.rules.length >= 1 && r.rules.length <= MAX_GROUP_CHILDREN && r.rules.every(ok);
    if (r.op === "not") return ok(r.rule);
    if (r.op === "in") return r.values.length >= 1 && r.values.length <= MAX_IN_VALUES;
    return true;
  };
  return ok(rule);
}

// ---- changing the tree ---------------------------------------------------------------------------------------

/**
 * Replace the node at `path` with `fn(node)` (undefined removes it). A group that loses a child and is left with
 * one is replaced by that child, and one left with none disappears, so no group ever holds nothing.
 */
function rebuild(rule: Rule, path: RulePath, fn: (node: Rule) => Rule | undefined): Rule | undefined {
  if (path.length === 0) return fn(rule);
  const [i, ...rest] = path;
  if (rule.op === "and" || rule.op === "or") {
    const kids = rule.rules.map((r, idx) => (idx === i ? rebuild(r, rest, fn) : r));
    const kept = kids.filter((r): r is Rule => r !== undefined);
    if (kept.length === 0) return undefined;
    if (kept.length === 1 && kept.length < rule.rules.length) return kept[0];
    return { op: rule.op, rules: kept };
  }
  if (rule.op === "not") {
    if (i !== 0) return rule;
    const inner = rebuild(rule.rule, rest, fn);
    return inner ? { op: "not", rule: inner } : undefined;
  }
  return rule;
}

/** Put `next` where the node at `path` is. */
export function setAt(rule: Rule, path: RulePath, next: Rule): Rule {
  return rebuild(rule, path, () => next) ?? next;
}

/** Remove the node at `path`; undefined when nothing is left. */
export function removeAt(rule: Rule, path: RulePath): Rule | undefined {
  return rebuild(rule, path, () => undefined);
}

/**
 * Add a condition next to the node at `path`'s group: into the group when `path` is a group, otherwise the node
 * and the new condition become an "all of" group. With no rule yet, the condition is the rule.
 */
export function addCondition(rule: Rule | undefined, path: RulePath, leaf: Rule): Rule {
  if (!rule) return leaf;
  const target = nodeAt(rule, path);
  if (!target) return rule;
  if (target.op === "and" || target.op === "or") {
    if (target.rules.length >= MAX_GROUP_CHILDREN) return rule;
    return setAt(rule, path, { op: target.op, rules: [...target.rules, leaf] });
  }
  return setAt(rule, path, { op: "and", rules: [target, leaf] });
}

/** Add a nested group (holding one condition) inside the group at `path`. */
export function addGroup(rule: Rule, path: RulePath, join: "and" | "or", leaf: Rule): Rule {
  const target = nodeAt(rule, path);
  if (!target) return rule;
  const group: Rule = { op: join, rules: [leaf] };
  if (target.op === "and" || target.op === "or") {
    if (target.rules.length >= MAX_GROUP_CHILDREN) return rule;
    return setAt(rule, path, { op: target.op, rules: [...target.rules, group] });
  }
  return setAt(rule, path, { op: "and", rules: [target, group] });
}

export function setGroupJoin(rule: Rule, path: RulePath, join: "and" | "or"): Rule {
  const target = nodeAt(rule, path);
  if (!target || (target.op !== "and" && target.op !== "or") || target.op === join) return rule;
  return setAt(rule, path, { op: join, rules: target.rules });
}

/** Take the "not" off: its one condition stays. */
export function unwrapNot(rule: Rule, path: RulePath): Rule {
  const target = nodeAt(rule, path);
  if (!target || target.op !== "not") return rule;
  return setAt(rule, path, target.rule);
}

/** Would adding a condition (or a nested group) at `path` stay inside the server's limits? */
export function canAdd(rule: Rule | undefined, path: RulePath, kind: "condition" | "group", sample: Rule = { op: "notEmpty", field: "x" }): boolean {
  if (!rule) return kind === "condition";
  const next = kind === "condition" ? addCondition(rule, path, sample) : addGroup(rule, path, "or", sample);
  return next !== rule && withinLimits(next);
}

// ---- what a condition can say about a field -------------------------------------------------------------------------

/** The operators that make sense for a field of this type. */
export function operatorsFor(type: DataFieldType | null): LeafOp[] {
  switch (type) {
    case "choice":
    case "multichoice":
      return ["eq", "ne", "in", "empty", "notEmpty"];
    case "yesno":
    case "acknowledge":
      return ["eq", "ne"];
    case "file":
    case "image":
      return ["notEmpty", "empty"];
    case null:
      return ["eq", "ne", "in", "empty", "notEmpty"];
    default:
      return ["eq", "ne", "empty", "notEmpty"];
  }
}

const YES_NO_VALUES = (): { value: string; label: L10n }[] => [
  { value: "yes", label: { en: yesNoWord(true, "en"), ms: yesNoWord(true, "ms"), zh: yesNoWord(true, "zh"), ko: yesNoWord(true, "ko") } },
  { value: "no", label: { en: yesNoWord(false, "en"), ms: yesNoWord(false, "ms"), zh: yesNoWord(false, "zh"), ko: yesNoWord(false, "ko") } },
];

/** The values to pick from for a condition on this field, or null when the value is free text. */
export function valueChoices(field: DataField | undefined): { value: string; label: L10n }[] | null {
  if (!field) return null;
  if (field.type === "choice" || field.type === "multichoice") return (field.options ?? []).map((o) => ({ value: o.value, label: o.label }));
  if (field.type === "yesno" || field.type === "acknowledge") return YES_NO_VALUES();
  return null;
}

/** A first condition for `field`, one that is valid at once. */
export function newCondition(field: DataField): LeafRule {
  const choices = valueChoices(field);
  if (choices && choices.length > 0) return { op: "eq", field: field.key, value: choices[0].value };
  return { op: "notEmpty", field: field.key };
}

const leafValues = (r: LeafRule): string[] => (r.op === "eq" || r.op === "ne" ? [r.value] : r.op === "in" ? r.values : []);

/** The condition re-aimed at another field: its operator and value are kept when they still make sense. */
export function changeLeafField(leaf: LeafRule, field: DataField): LeafRule {
  if (!operatorsFor(field.type).includes(leaf.op)) return newCondition(field);
  const choices = valueChoices(field);
  const values = leafValues(leaf);
  if (choices && values.some((v) => !choices.some((c) => c.value === v))) return newCondition(field);
  return { ...leaf, field: field.key } as LeafRule;
}

/** The condition with another operator; the values it already had are carried over where they still apply. */
export function changeLeafOp(leaf: LeafRule, op: LeafOp, field: DataField | undefined): LeafRule {
  if (leaf.op === op) return leaf;
  const key = leaf.field;
  const choices = valueChoices(field);
  const old = leafValues(leaf);
  const first = old[0] ?? choices?.[0]?.value ?? "";
  switch (op) {
    case "eq":
    case "ne":
      return { op, field: key, value: first };
    case "in":
      return { op, field: key, values: old.length > 0 ? old : first ? [first] : choices?.[0] ? [choices[0].value] : [] };
    default:
      return { op, field: key };
  }
}

export function setLeafValue(leaf: LeafRule, value: string): LeafRule {
  if (leaf.op === "eq" || leaf.op === "ne") return { ...leaf, value: value.slice(0, MAX_RULE_VALUE_LENGTH) };
  return leaf;
}

/** Tick or untick one value of an "is one of" condition (keeping the options' order). */
export function toggleLeafValue(leaf: LeafRule, value: string, on: boolean, order: readonly string[] = []): LeafRule {
  if (leaf.op !== "in") return leaf;
  const next = on ? [...new Set([...leaf.values, value])] : leaf.values.filter((v) => v !== value);
  next.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
  });
  return { ...leaf, values: next };
}

/** A condition that does not say anything yet (a value left empty, nothing ticked): the builder asks to complete it. */
export function isBlankCondition(leaf: LeafRule): boolean {
  if (leaf.op === "eq" || leaf.op === "ne") return leaf.value.trim() === "";
  if (leaf.op === "in") return leaf.values.length === 0;
  return false;
}

// ---- reading a rule back in plain words ---------------------------------------------------------------------------------

export interface WordValue {
  value: string;
  label: string;
  /** The value is not one of the field's options any more. */
  stale?: boolean;
}

export type RuleWords =
  | { kind: "leaf"; op: LeafOp; field: string; fieldLabel: string; fieldType: DataFieldType | null; values: WordValue[] }
  | { kind: "group"; join: GroupJoin; items: RuleWords[] };

/** The rule as structured words in `locale`: field labels and option labels resolved, nothing joined yet. */
export function describeRule(rule: Rule, form: FormDefinition, locale: SignLocale): RuleWords {
  if (rule.op === "and" || rule.op === "or") return { kind: "group", join: rule.op, items: rule.rules.map((r) => describeRule(r, form, locale)) };
  if (rule.op === "not") return { kind: "group", join: "not", items: [describeRule(rule.rule, form, locale)] };
  const field = form.fields.find((f) => f.key === rule.field);
  const choices = valueChoices(field);
  const label = (value: string): WordValue => {
    const c = choices?.find((x) => x.value === value);
    if (c) return { value, label: pick(c.label, locale) || value };
    return choices ? { value, label: value, stale: true } : { value, label: value };
  };
  return {
    kind: "leaf",
    op: rule.op,
    field: rule.field,
    fieldLabel: field ? pick(field.label, locale) || field.key : rule.field,
    fieldType: field ? field.type : null,
    values: leafValues(rule).map(label),
  };
}

/** The message key (under the builder's `rule.leaf`) that words a condition: it depends on the operator and on the kind of field. */
export function leafMessageKey(op: LeafOp, type: DataFieldType | null): string {
  if (type === null) return "unknown";
  const many = type === "multichoice" || type === "list";
  const file = type === "file" || type === "image";
  if (file) return op === "empty" ? "empty_file" : "notEmpty_file";
  if (many && (op === "eq" || op === "ne" || op === "in")) return `${op}_many`;
  return op;
}

export interface RuleTranslator {
  /** One condition as a sentence part, e.g. "Tax type is SST". */
  leaf: (words: Extract<RuleWords, { kind: "leaf" }>) => string;
  /** The words joined by "and" / "or". */
  join: (join: "and" | "or", parts: string[]) => string;
  /** "not (...)" */
  not: (text: string) => string;
}

/** The rule as one line of text, nested groups in brackets. The wording comes from `tr` (messages), never from here. */
export function ruleText(words: RuleWords, tr: RuleTranslator, nested = false): string {
  if (words.kind === "leaf") return tr.leaf(words);
  const parts = words.items.map((w) => ruleText(w, tr, true));
  if (words.join === "not") return tr.not(parts.join(" "));
  const text = tr.join(words.join, parts);
  return nested && parts.length > 1 ? `(${text})` : text;
}
