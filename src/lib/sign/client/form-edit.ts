// ============================================================
// Doc Sign form builder: the editing operations on a form definition, as pure functions that return the
// new form. Adding, renaming, moving and deleting parts and data fields never leave anything orphaned: a
// deleted part takes its fields with it, a deleted field is taken out of every rule that named it, and
// every change says what else it touched so the builder can tell the sender.
// Pure: no React, no I/O.
// ============================================================

import { ruleFields } from "../forms/rules";
import { canBeSensitive } from "../forms/sensitive";
import { MAX_DATA_FIELDS, MAX_PARTS, type DataField, type DataFieldType, type FormDefinition, type FormPart, type L10n, type Rule } from "../forms/types";
import { keyFromLabel, optionValueFromLabel, takenPartKeys } from "./form-keys";

export const emptyForm = (): FormDefinition => ({ version: 1, parts: [], fields: [] });

/** Wording for the things the builder creates for the sender, supplied translated. */
export interface FormSeeds {
  newPart: string;
  newField: string;
  /** "Option 1" */
  option: (n: number) => string;
  /** The text of a new "acknowledge" field. */
  acknowledgeText: string;
  /** Added after the label of a duplicated field, for example " (copy)". */
  copySuffix: string;
}

// ---- ordering ---------------------------------------------------------------------------------------------------

/** `arr` with the item at `from` moved to index `to` (clamped). The same array comes back when nothing moves. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): readonly T[] {
  if (from < 0 || from >= arr.length) return arr;
  const target = Math.max(0, Math.min(arr.length - 1, to));
  if (target === from) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export const partOf = (form: FormDefinition, key: string): FormPart | undefined => form.parts.find((p) => p.key === key);
export const fieldOf = (form: FormDefinition, key: string): DataField | undefined => form.fields.find((f) => f.key === key);

/** The fields of one part, in the order they are asked. */
export const fieldsInPart = (form: FormDefinition, partKey: string): DataField[] => form.fields.filter((f) => f.part === partKey);

/** Every field, part by part: the order a signer meets them (and the order the builder lists them in a rule). */
export function fieldsInOrder(form: FormDefinition): DataField[] {
  return form.parts.flatMap((p) => fieldsInPart(form, p.key)).concat(form.fields.filter((f) => !form.parts.some((p) => p.key === f.part)));
}

/** The fields a rule on `ownerKey` may look at: every other field, in the order they are asked. */
export const ruleTargets = (form: FormDefinition, ownerKey?: string): DataField[] => fieldsInOrder(form).filter((f) => f.key !== ownerKey);

export const canAddPart = (form: FormDefinition): boolean => form.parts.length < MAX_PARTS;
export const canAddField = (form: FormDefinition): boolean => form.fields.length < MAX_DATA_FIELDS;

// ---- rules that name fields -------------------------------------------------------------------------------------

export interface RuleChange {
  /** Exactly one of these says whose rule it is. */
  field?: string;
  part?: string;
  which: "visibleIf" | "requiredIf";
  /** The whole rule went, or only some of its conditions. */
  result: "removed" | "trimmed";
}

/** The rule without the conditions that name a removed field; undefined when nothing is left. */
export function pruneRule(rule: Rule, removed: ReadonlySet<string>): Rule | undefined {
  switch (rule.op) {
    case "and":
    case "or": {
      const kept = rule.rules.map((r) => pruneRule(r, removed)).filter((r): r is Rule => r !== undefined);
      if (kept.length === 0) return undefined;
      if (kept.length === 1) return kept[0];
      return kept.length === rule.rules.length && kept.every((k, i) => k === rule.rules[i]) ? rule : { op: rule.op, rules: kept };
    }
    case "not": {
      const inner = pruneRule(rule.rule, removed);
      if (!inner) return undefined;
      return inner === rule.rule ? rule : { op: "not", rule: inner };
    }
    default:
      return removed.has(rule.field) ? undefined : rule;
  }
}

const refersTo = (rule: Rule | undefined, keys: ReadonlySet<string>): boolean => !!rule && ruleFields(rule).some((k) => keys.has(k));

/** Which rules name any of these fields (so the sender can be told before deleting one). */
export function rulesUsing(form: FormDefinition, keys: ReadonlySet<string>): RuleChange[] {
  const out: RuleChange[] = [];
  for (const f of form.fields) {
    if (keys.has(f.key)) continue;
    if (refersTo(f.visibleIf, keys)) out.push({ field: f.key, which: "visibleIf", result: "trimmed" });
    if (refersTo(f.requiredIf, keys)) out.push({ field: f.key, which: "requiredIf", result: "trimmed" });
  }
  for (const p of form.parts) if (refersTo(p.visibleIf, keys)) out.push({ part: p.key, which: "visibleIf", result: "trimmed" });
  return out;
}

/** Take the named fields out of every rule that used them. Fields in `removed` are assumed to be going too and are not touched. */
export function scrubRules(form: FormDefinition, removed: ReadonlySet<string>): { form: FormDefinition; changes: RuleChange[] } {
  const changes: RuleChange[] = [];
  const scrub = (rule: Rule | undefined, owner: { field?: string; part?: string }, which: "visibleIf" | "requiredIf"): Rule | undefined => {
    if (!rule || !refersTo(rule, removed)) return rule;
    const next = pruneRule(rule, removed);
    changes.push({ ...owner, which, result: next ? "trimmed" : "removed" });
    return next;
  };
  const without = <T extends object>(o: T, key: "visibleIf" | "requiredIf"): T => {
    const { [key]: dropped, ...rest } = o as T & Record<string, unknown>;
    void dropped;
    return rest as T;
  };
  const fields = form.fields.map((f) => {
    if (removed.has(f.key)) return f;
    let next = f;
    for (const which of ["visibleIf", "requiredIf"] as const) {
      const before = next[which];
      const after = scrub(before, { field: f.key }, which);
      if (after !== before) next = after ? { ...next, [which]: after } : without(next, which);
    }
    return next;
  });
  const parts = form.parts.map((p) => {
    const after = scrub(p.visibleIf, { part: p.key }, "visibleIf");
    return after === p.visibleIf ? p : after ? { ...p, visibleIf: after } : without(p, "visibleIf");
  });
  return changes.length === 0 ? { form, changes } : { form: { ...form, fields, parts }, changes };
}

function mapRuleFields(rule: Rule, map: (key: string) => string): Rule {
  switch (rule.op) {
    case "and":
    case "or":
      return { op: rule.op, rules: rule.rules.map((r) => mapRuleFields(r, map)) };
    case "not":
      return { op: "not", rule: mapRuleFields(rule.rule, map) };
    default:
      return { ...rule, field: map(rule.field) };
  }
}

// ---- parts ----------------------------------------------------------------------------------------------------------

/** Add a part at the end. Null at the maximum. */
export function addPart(form: FormDefinition, input: { title: string; role: string }): { form: FormDefinition; key: string } | null {
  if (!canAddPart(form)) return null;
  const key = keyFromLabel(input.title, takenPartKeys(form), "part");
  const part: FormPart = { key, title: { en: input.title }, role: input.role };
  return { form: { ...form, parts: [...form.parts, part] }, key };
}

export function updatePart(form: FormDefinition, key: string, patch: Partial<Omit<FormPart, "key">> | ((p: FormPart) => FormPart)): FormDefinition {
  let changed = false;
  const parts = form.parts.map((p) => {
    if (p.key !== key) return p;
    const next = typeof patch === "function" ? patch(p) : { ...p, ...patch };
    if (next !== p) changed = true;
    return next;
  });
  return changed ? { ...form, parts } : form;
}

/** Give a part another key (its fields follow). The new key must be free; otherwise nothing changes. */
export function renamePartKey(form: FormDefinition, from: string, to: string): FormDefinition {
  if (from === to || form.parts.some((p) => p.key === to) || !form.parts.some((p) => p.key === from)) return form;
  return {
    ...form,
    parts: form.parts.map((p) => (p.key === from ? { ...p, key: to } : p)),
    fields: form.fields.map((f) => (f.part === from ? { ...f, part: to } : f)),
  };
}

export function movePart(form: FormDefinition, key: string, to: number): FormDefinition {
  const from = form.parts.findIndex((p) => p.key === key);
  const parts = moveItem(form.parts, from, to);
  return parts === form.parts ? form : { ...form, parts: parts as FormPart[] };
}

export const stepPart = (form: FormDefinition, key: string, direction: -1 | 1): FormDefinition => movePart(form, key, form.parts.findIndex((p) => p.key === key) + direction);

export interface DeletePartResult {
  form: FormDefinition;
  /** The keys of the data fields that went with the part. */
  removedFields: string[];
  ruleChanges: RuleChange[];
}

/** Delete a part and its fields; any rule that named one of those fields loses that condition. */
export function deletePart(form: FormDefinition, key: string): DeletePartResult {
  const removedFields = form.fields.filter((f) => f.part === key).map((f) => f.key);
  const gone = new Set(removedFields);
  const base: FormDefinition = { ...form, parts: form.parts.filter((p) => p.key !== key), fields: form.fields.filter((f) => f.part !== key) };
  const scrubbed = scrubRules(base, gone);
  return { form: scrubbed.form, removedFields, ruleChanges: scrubbed.changes };
}

/** Give every part of one role to another (used when a role goes). */
export function reassignParts(form: FormDefinition, fromRole: string, toRole: string): FormDefinition {
  if (!form.parts.some((p) => p.role === fromRole)) return form;
  return { ...form, parts: form.parts.map((p) => (p.role === fromRole ? { ...p, role: toRole } : p)) };
}

// ---- data fields ---------------------------------------------------------------------------------------------------

/** A new data field of `type`, valid at once: choices come with two options, a file field accepts the usual kinds. */
export function createDataField(input: { type: DataFieldType; part: string; key: string; label: string; seeds: FormSeeds }): DataField {
  const { type, seeds } = input;
  const field: DataField = { key: input.key, type, part: input.part, label: { en: input.label }, required: true };
  if (type === "choice" || type === "multichoice") {
    const taken = new Set<string>();
    field.options = [1, 2].map((n) => {
      const label = seeds.option(n);
      const value = optionValueFromLabel(label, taken);
      taken.add(value);
      return { value, label: { en: label } };
    });
  }
  if (type === "file") Object.assign(field, { accept: ["pdf", "jpg", "png"], maxMb: 5, maxFiles: 1 });
  if (type === "acknowledge") field.text = { en: seeds.acknowledgeText };
  return field;
}

/** Add a data field at the end of a part. Null at the maximum or when the part does not exist. */
export function addField(form: FormDefinition, input: { part: string; type: DataFieldType; seeds: FormSeeds; taken: ReadonlySet<string>; label?: string }): { form: FormDefinition; key: string } | null {
  if (!canAddField(form) || !partOf(form, input.part)) return null;
  const label = input.label ?? input.seeds.newField;
  const key = keyFromLabel(label, new Set([...input.taken, ...form.fields.map((f) => f.key)]), "field");
  const field = createDataField({ type: input.type, part: input.part, key, label, seeds: input.seeds });
  const last = fieldsInPart(form, input.part).at(-1);
  const at = last ? form.fields.indexOf(last) + 1 : form.fields.length;
  return { form: { ...form, fields: [...form.fields.slice(0, at), field, ...form.fields.slice(at)] }, key };
}

export function updateField(form: FormDefinition, key: string, patch: Partial<DataField> | ((f: DataField) => DataField)): FormDefinition {
  let changed = false;
  const fields = form.fields.map((f) => {
    if (f.key !== key) return f;
    const next = typeof patch === "function" ? patch(f) : { ...f, ...patch };
    if (next !== f) changed = true;
    return next;
  });
  return changed ? { ...form, fields } : form;
}

/** Remove a property (a field's optional settings are absent, never undefined, so the stored form stays small). */
export function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
}

/** Give a data field another key; every rule that named it follows. The new key must be free in the form. */
export function renameField(form: FormDefinition, from: string, to: string): FormDefinition {
  if (from === to || !form.fields.some((f) => f.key === from) || form.fields.some((f) => f.key === to)) return form;
  const map = (k: string) => (k === from ? to : k);
  const rename = (r: Rule | undefined) => (r && refersTo(r, new Set([from])) ? mapRuleFields(r, map) : r);
  return {
    ...form,
    fields: form.fields.map((f) => {
      const next: DataField = { ...f, key: f.key === from ? to : f.key };
      if (f.visibleIf) next.visibleIf = rename(f.visibleIf);
      if (f.requiredIf) next.requiredIf = rename(f.requiredIf);
      return next;
    }),
    parts: form.parts.map((p) => (p.visibleIf && refersTo(p.visibleIf, new Set([from])) ? { ...p, visibleIf: rename(p.visibleIf) } : p)),
  };
}

/**
 * Put a field at `index` among the fields of `part` (moving it into that part if it is elsewhere). The same form
 * comes back when nothing changes.
 */
export function moveField(form: FormDefinition, key: string, target: { part: string; index: number }): FormDefinition {
  const field = fieldOf(form, key);
  if (!field || !partOf(form, target.part)) return form;
  const rest = form.fields.filter((f) => f.key !== key);
  const moved = field.part === target.part ? field : { ...field, part: target.part };
  const inTarget = rest.filter((f) => f.part === target.part);
  const index = Math.max(0, Math.min(inTarget.length, target.index));
  const at = inTarget.length === 0 ? rest.length : index >= inTarget.length ? rest.indexOf(inTarget[inTarget.length - 1]) + 1 : rest.indexOf(inTarget[index]);
  const fields = [...rest.slice(0, at), moved, ...rest.slice(at)];
  return fields.every((f, i) => f === form.fields[i]) ? form : { ...form, fields };
}

/** One place up or down among the fields of its part. */
export function stepField(form: FormDefinition, key: string, direction: -1 | 1): FormDefinition {
  const field = fieldOf(form, key);
  if (!field) return form;
  const siblings = fieldsInPart(form, field.part);
  const i = siblings.findIndex((f) => f.key === key);
  const to = i + direction;
  if (to < 0 || to >= siblings.length) return form;
  return moveField(form, key, { part: field.part, index: to });
}

const withSuffix = (text: L10n, suffix: string): L10n => Object.fromEntries(Object.entries(text).map(([k, v]) => [k, v && v.trim() ? `${v}${suffix}` : v])) as L10n;

/** A copy right after the original, with a new key and "(copy)" on its label. */
export function duplicateField(form: FormDefinition, key: string, taken: ReadonlySet<string>, seeds: FormSeeds): { form: FormDefinition; key: string } | null {
  const field = fieldOf(form, key);
  if (!field || !canAddField(form)) return null;
  const label = withSuffix(field.label, seeds.copySuffix);
  const newKey = keyFromLabel(label.en, new Set([...taken, ...form.fields.map((f) => f.key)]), "field");
  const copy: DataField = { ...field, key: newKey, label };
  const at = form.fields.indexOf(field) + 1;
  return { form: { ...form, fields: [...form.fields.slice(0, at), copy, ...form.fields.slice(at)] }, key: newKey };
}

export interface DeleteFieldResult {
  form: FormDefinition;
  ruleChanges: RuleChange[];
}

/** Delete a data field; any rule that named it loses that condition. */
export function deleteField(form: FormDefinition, key: string): DeleteFieldResult {
  if (!fieldOf(form, key)) return { form, ruleChanges: [] };
  const base: FormDefinition = { ...form, fields: form.fields.filter((f) => f.key !== key) };
  const scrubbed = scrubRules(base, new Set([key]));
  return { form: scrubbed.form, ruleChanges: scrubbed.changes };
}

// ---- changing the type of a data field -------------------------------------------------------------------------------

const TEXT_LIKE: readonly DataFieldType[] = ["text", "multiline", "email", "phone", "number", "date"];

/** Types that may fill a contact field (validate.ts: not files, pictures, lists or multiple choice). */
export const contactCapable = (type: DataFieldType): boolean => type !== "file" && type !== "image" && type !== "list" && type !== "multichoice";

/**
 * The same field as another type: what it has in common (labels, help, required, rules, locked) is kept, the settings that belong to
 * the old type are dropped and the new type gets what it needs to be valid (options, accepted files, the acknowledge text).
 */
export function retypeField(field: DataField, type: DataFieldType, seeds: FormSeeds): DataField {
  if (field.type === type) return field;
  const fresh = createDataField({ type, part: field.part, key: field.key, label: field.label.en, seeds });
  const next: DataField = { ...fresh, label: field.label, required: field.required };
  for (const k of ["help", "placeholder", "requiredIf", "visibleIf", "writeBack", "locked"] as const) {
    if (field[k] !== undefined) Object.assign(next, { [k]: field[k] });
  }
  if (field.sensitive === true && canBeSensitive(type)) {
    // a sensitive field stays sensitive (and keeps how it prints) when it becomes another kind of text; it fills no contact field
    next.sensitive = true;
    if (field.printMasked !== undefined) next.printMasked = field.printMasked;
  } else if (field.contactField !== undefined && contactCapable(type)) next.contactField = field.contactField;
  if ((type === "text" || type === "multiline") && (field.type === "text" || field.type === "multiline")) {
    for (const k of ["format", "minLength", "maxLength"] as const) if (field[k] !== undefined) Object.assign(next, { [k]: field[k] });
  }
  if (TEXT_LIKE.includes(type) && TEXT_LIKE.includes(field.type) && field.defaultValue !== undefined) next.defaultValue = field.defaultValue;
  if ((type === "choice" || type === "multichoice") && (field.type === "choice" || field.type === "multichoice") && field.options) {
    next.options = field.options;
    if (field.optionList !== undefined) next.optionList = field.optionList;
    if (field.defaultValue !== undefined && type === "choice") next.defaultValue = field.defaultValue;
  }
  if (type === "acknowledge") next.required = true;
  return next;
}

/** The parts a role holds, in order. */
export const partsOfRole = (form: FormDefinition, roleKey: string): FormPart[] => form.parts.filter((p) => p.role === roleKey);
