// ============================================================
// Conditions on answers: "show the tax percentage only when the tax type is SST". A condition is the
// small JSON `Rule` of types.ts. This file evaluates one, checks that one is sound (refers to real
// fields, is small, has no loop), and works out whether a field or part is shown and required.
// ============================================================

import { MAX_RULE_DEPTH, MAX_RULE_NODES, type AnswerMap, type DataField, type FormDefinition, type FormPart, type FormValue, type Rule } from "./types";

/**
 * What an answer is, for comparing: a string, a list of strings, or nothing.
 * A yes or no is "yes" / "no"; a list of entries or a multiple choice is the array; files count as their names.
 */
export function factOf(value: FormValue | undefined): string | string[] | undefined {
  if (!value) return undefined;
  if ("text" in value) return value.text === "" ? undefined : value.text;
  if ("checked" in value) return value.checked ? "yes" : "no";
  if ("choices" in value) return value.choices.length ? value.choices : undefined;
  if ("list" in value) return value.list.length ? value.list : undefined;
  if ("files" in value) return value.files.length ? value.files.map((f) => f.name) : undefined;
  if ("image" in value) return value.image ? "image" : undefined;
  return undefined;
}

const isEmpty = (f: string | string[] | undefined) => f === undefined || (Array.isArray(f) ? f.length === 0 : f.trim() === "");
const has = (f: string | string[] | undefined, v: string) => (Array.isArray(f) ? f.includes(v) : f === v);

/** Does `rule` hold for these answers? */
export function evalRule(rule: Rule, answers: AnswerMap): boolean {
  switch (rule.op) {
    case "eq":
      return has(factOf(answers[rule.field]), rule.value);
    case "ne":
      return !has(factOf(answers[rule.field]), rule.value);
    case "in": {
      const f = factOf(answers[rule.field]);
      return rule.values.some((v) => has(f, v));
    }
    case "empty":
      return isEmpty(factOf(answers[rule.field]));
    case "notEmpty":
      return !isEmpty(factOf(answers[rule.field]));
    case "and":
      return rule.rules.every((r) => evalRule(r, answers));
    case "or":
      return rule.rules.some((r) => evalRule(r, answers));
    case "not":
      return !evalRule(rule.rule, answers);
    default:
      return false;
  }
}

/** The data field keys a rule refers to. */
export function ruleFields(rule: Rule): string[] {
  switch (rule.op) {
    case "and":
    case "or":
      return rule.rules.flatMap(ruleFields);
    case "not":
      return ruleFields(rule.rule);
    default:
      return [rule.field];
  }
}

/** Why a rule is not sound, as stable codes; empty when it is. `known` is the set of data field keys. */
export function ruleProblems(rule: unknown, known: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  let nodes = 0;
  const walk = (r: unknown, depth: number) => {
    nodes++;
    if (nodes > MAX_RULE_NODES) return;
    if (typeof r !== "object" || r === null) {
      problems.push("rule_shape");
      return;
    }
    if (depth > MAX_RULE_DEPTH) {
      problems.push("rule_too_deep");
      return;
    }
    const x = r as Record<string, unknown>;
    switch (x.op) {
      case "eq":
      case "ne":
        if (typeof x.field !== "string" || !known.has(x.field)) problems.push("rule_unknown_field");
        if (typeof x.value !== "string" || x.value.length > 200) problems.push("rule_value");
        return;
      case "in":
        if (typeof x.field !== "string" || !known.has(x.field)) problems.push("rule_unknown_field");
        if (!Array.isArray(x.values) || x.values.length === 0 || x.values.length > 50 || x.values.some((v) => typeof v !== "string" || v.length > 200)) problems.push("rule_value");
        return;
      case "empty":
      case "notEmpty":
        if (typeof x.field !== "string" || !known.has(x.field)) problems.push("rule_unknown_field");
        return;
      case "and":
      case "or":
        if (!Array.isArray(x.rules) || x.rules.length === 0 || x.rules.length > 10) {
          problems.push("rule_shape");
          return;
        }
        for (const c of x.rules) walk(c, depth + 1);
        return;
      case "not":
        walk(x.rule, depth + 1);
        return;
      default:
        problems.push("rule_shape");
    }
  };
  walk(rule, 1);
  if (nodes > MAX_RULE_NODES) problems.push("rule_too_big");
  return [...new Set(problems)];
}

// ---- visibility and requirement -----------------------------------------------------------------------------

export function partVisible(part: FormPart, answers: AnswerMap): boolean {
  return !part.visibleIf || evalRule(part.visibleIf, answers);
}

export function fieldVisible(form: FormDefinition, field: DataField, answers: AnswerMap): boolean {
  const part = form.parts.find((p) => p.key === field.part);
  if (!part || !partVisible(part, answers)) return false;
  return !field.visibleIf || evalRule(field.visibleIf, answers);
}

/** Visible, and required outright or by its own rule. */
export function fieldRequired(form: FormDefinition, field: DataField, answers: AnswerMap): boolean {
  if (!fieldVisible(form, field, answers)) return false;
  if (field.type === "acknowledge") return true;
  if (field.required) return true;
  return !!field.requiredIf && evalRule(field.requiredIf, answers);
}

/** Data fields that depend on one another must not form a loop (a field cannot, through others, decide its own visibility). */
export function dependencyCycle(form: FormDefinition): string | null {
  const deps = new Map<string, string[]>();
  const partRefs = new Map(form.parts.map((p) => [p.key, p.visibleIf ? ruleFields(p.visibleIf) : []]));
  for (const f of form.fields) {
    deps.set(f.key, [...(f.visibleIf ? ruleFields(f.visibleIf) : []), ...(f.requiredIf ? ruleFields(f.requiredIf) : []), ...(partRefs.get(f.part) ?? [])]);
  }
  const state = new Map<string, 1 | 2>();
  let found: string | null = null;
  const visit = (k: string) => {
    if (found) return;
    const s = state.get(k);
    if (s === 2) return;
    if (s === 1) {
      found = k;
      return;
    }
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) visit(d);
    state.set(k, 2);
  };
  for (const k of deps.keys()) visit(k);
  return found;
}
