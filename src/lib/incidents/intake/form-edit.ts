// Editing the coach report as data: the operations the drag-and-drop builder performs, a strict check before a form can be published, and a plain-words
// comparison of two versions. Pure: every operation returns a new schema and leaves the old one untouched, so undo and "restore a version" are trivial.

import { INCIDENT_FLAGS } from "@/lib/incidents/constants";
import type { LangMap } from "@/lib/incidents/platform/roles";
import { SEVERITY_BANDS, type ChoiceOption, type Condition, type Effects, type FieldType, type FormField, type FormSchema, type FormStep } from "./form-schema";

export const FIELD_TYPES: readonly FieldType[] = ["involved", "choice", "text", "longtext", "yesno", "photo"];
export const LIMITS = { steps: 6, fields: 40, options: 12, label: 200, help: 400, key: 40 } as const;

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

// ---- operations -------------------------------------------------------------------------------------------------

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function uniqueKey(schema: FormSchema, base: string): string {
  const taken = new Set([...schema.steps.map((s) => s.key), ...schema.steps.flatMap((s) => s.fields.map((f) => f.key))]);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

export function slugKey(label: string, fallback: string): string {
  const base = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return /^[a-z]/.test(base) ? base : fallback;
}

/** A new field of the given type with sensible starting wording, placed in a step at a position (the end when omitted). */
export function addField(schema: FormSchema, stepKey: string, type: FieldType, index?: number): { schema: FormSchema; key: string } {
  const next = clone(schema);
  const step = next.steps.find((s) => s.key === stepKey);
  if (!step) return { schema, key: "" };
  const key = uniqueKey(next, type === "involved" ? "involved" : `${type}_field`);
  const label: Record<FieldType, string> = {
    involved: "Who was involved?",
    choice: "Choose one",
    text: "Short answer",
    longtext: "Tell us more",
    yesno: "Yes or no?",
    photo: "Add a photo (optional)",
  };
  const field: FormField = { key, type, label: { en: label[type] } };
  if (type === "choice") field.options = [{ value: "option_1", label: { en: "Option 1" } }, { value: "option_2", label: { en: "Option 2" } }];
  const at = index === undefined ? step.fields.length : Math.max(0, Math.min(index, step.fields.length));
  step.fields.splice(at, 0, field);
  return { schema: next, key };
}

function locate(schema: FormSchema, fieldKey: string): { step: FormStep; index: number } | null {
  for (const step of schema.steps) {
    const index = step.fields.findIndex((f) => f.key === fieldKey);
    if (index >= 0) return { step, index };
  }
  return null;
}

export function moveField(schema: FormSchema, fieldKey: string, toStepKey: string, toIndex: number): FormSchema {
  const next = clone(schema);
  const from = locate(next, fieldKey);
  const to = next.steps.find((s) => s.key === toStepKey);
  if (!from || !to) return schema;
  const [field] = from.step.fields.splice(from.index, 1);
  // Dropping after itself in the same step: the removal shifted everything above it down by one.
  const adjusted = from.step === to && toIndex > from.index ? toIndex - 1 : toIndex;
  to.fields.splice(Math.max(0, Math.min(adjusted, to.fields.length)), 0, field);
  return next;
}

export function removeField(schema: FormSchema, fieldKey: string): FormSchema {
  const next = clone(schema);
  for (const step of next.steps) step.fields = step.fields.filter((f) => f.key !== fieldKey);
  // Another field that was shown only when this one had a value would never show again: it is shown always instead.
  for (const step of next.steps) for (const f of step.fields) if (f.showIf?.field === fieldKey) delete f.showIf;
  return next;
}

export function updateField(schema: FormSchema, fieldKey: string, patch: Partial<Omit<FormField, "key" | "type">>): FormSchema {
  const next = clone(schema);
  const at = locate(next, fieldKey);
  if (!at) return schema;
  at.step.fields[at.index] = { ...at.step.fields[at.index], ...patch };
  return next;
}

export function addStep(schema: FormSchema, title = "New step"): { schema: FormSchema; key: string } {
  const next = clone(schema);
  const key = uniqueKey(next, "step");
  next.steps.push({ key, title: { en: title }, fields: [] });
  return { schema: next, key };
}

export function updateStep(schema: FormSchema, stepKey: string, title: LangMap): FormSchema {
  const next = clone(schema);
  const step = next.steps.find((s) => s.key === stepKey);
  if (!step) return schema;
  step.title = title;
  return next;
}

export function moveStep(schema: FormSchema, stepKey: string, toIndex: number): FormSchema {
  const next = clone(schema);
  const from = next.steps.findIndex((s) => s.key === stepKey);
  if (from < 0) return schema;
  const [step] = next.steps.splice(from, 1);
  next.steps.splice(Math.max(0, Math.min(toIndex, next.steps.length)), 0, step);
  return next;
}

/** Remove a step; its fields move to the previous step (or the next, for the first) so nothing is lost by accident. */
export function removeStep(schema: FormSchema, stepKey: string): FormSchema {
  if (schema.steps.length <= 1) return schema;
  const next = clone(schema);
  const idx = next.steps.findIndex((s) => s.key === stepKey);
  if (idx < 0) return schema;
  const [gone] = next.steps.splice(idx, 1);
  next.steps[Math.max(0, idx - 1)].fields.push(...gone.fields);
  return next;
}

export function addOption(schema: FormSchema, fieldKey: string): FormSchema {
  const next = clone(schema);
  const at = locate(next, fieldKey);
  const field = at?.step.fields[at.index];
  if (!field || field.type !== "choice") return schema;
  const options = field.options ?? [];
  let n = options.length + 1;
  while (options.some((o) => o.value === `option_${n}`)) n++;
  field.options = [...options, { value: `option_${n}`, label: { en: `Option ${n}` } }];
  return next;
}

export function updateOption(schema: FormSchema, fieldKey: string, value: string, patch: Partial<Omit<ChoiceOption, "value">>): FormSchema {
  const next = clone(schema);
  const at = locate(next, fieldKey);
  const field = at?.step.fields[at.index];
  const opt = field?.options?.find((o) => o.value === value);
  if (!field || !opt) return schema;
  Object.assign(opt, patch);
  return next;
}

export function removeOption(schema: FormSchema, fieldKey: string, value: string): FormSchema {
  const next = clone(schema);
  const at = locate(next, fieldKey);
  const field = at?.step.fields[at.index];
  if (!field?.options) return schema;
  field.options = field.options.filter((o) => o.value !== value);
  for (const step of next.steps) for (const f of step.fields) if (f.showIf?.field === fieldKey && f.showIf.equals === value) delete f.showIf;
  return next;
}

/** The fields a field may depend on: choices that come before it (a rule can only look backwards, so a form never waits on a later answer). */
export function conditionCandidates(schema: FormSchema, fieldKey: string): FormField[] {
  const all = schema.steps.flatMap((s) => s.fields);
  const at = all.findIndex((f) => f.key === fieldKey);
  return all.slice(0, Math.max(0, at)).filter((f) => f.type === "choice");
}

export function setCondition(schema: FormSchema, fieldKey: string, cond: Condition | undefined): FormSchema {
  const next = clone(schema);
  const at = locate(next, fieldKey);
  if (!at) return schema;
  const field = at.step.fields[at.index];
  if (cond) field.showIf = cond;
  else delete field.showIf;
  return next;
}

// ---- validation -------------------------------------------------------------------------------------------------

export interface SchemaContext {
  /** Category codes in the school's active template. */
  categoryCodes: readonly string[];
}

const isLang = (m: unknown, max: number): m is LangMap =>
  typeof m === "object" && m !== null && !Array.isArray(m) && typeof (m as LangMap).en === "string" && (m as LangMap).en.trim().length > 0 && Object.values(m).every((v) => typeof v === "string" && v.length <= max);

function checkEffects(e: unknown, where: string, ctx: SchemaContext, problems: string[]): void {
  if (e === undefined) return;
  if (typeof e !== "object" || e === null) return void problems.push(`${where}: the effects are not valid.`);
  const fx = e as Effects;
  if (fx.category !== undefined && !ctx.categoryCodes.includes(fx.category)) problems.push(`${where}: the school's template has no category "${fx.category}".`);
  for (const f of fx.flags ?? []) if (!(INCIDENT_FLAGS as readonly string[]).includes(f)) problems.push(`${where}: "${f}" is not a flag Halo knows.`);
  if (fx.band !== undefined && !SEVERITY_BANDS.includes(fx.band)) problems.push(`${where}: unknown severity band.`);
}

/** Plain-words problems that stop a form being published. Empty means it is safe to publish. Runs on the server, whatever the browser sent. */
export function validateSchema(input: unknown, ctx: SchemaContext): string[] {
  const problems: string[] = [];
  if (typeof input !== "object" || input === null) return ["The form is empty."];
  const schema = input as FormSchema;
  if (schema.version !== 1) problems.push("This form format is not supported.");
  if (!Array.isArray(schema.steps) || schema.steps.length === 0) return [...problems, "Add at least one step."];
  if (schema.steps.length > LIMITS.steps) problems.push(`A form can have at most ${LIMITS.steps} steps.`);

  const stepKeys = new Set<string>();
  const keys = new Set<string>();
  const seenFields: FormField[] = [];
  let fieldCount = 0;
  for (const [si, step] of schema.steps.entries()) {
    const sw = `Step ${si + 1}`;
    if (!step || typeof step.key !== "string" || !KEY_RE.test(step.key) || stepKeys.has(step.key)) problems.push(`${sw}: its key is missing or repeated.`);
    else stepKeys.add(step.key);
    if (!isLang(step?.title, LIMITS.label)) problems.push(`${sw}: give it a title.`);
    if (!Array.isArray(step?.fields)) {
      problems.push(`${sw}: it has no field list.`);
      continue;
    }
    if (step.fields.length === 0) problems.push(`${sw}: it is empty. Add a field or delete the step.`);
    for (const f of step.fields) {
      fieldCount += 1;
      const w = `"${isLang(f?.label, LIMITS.label) ? f.label.en : f?.key}"`;
      if (!f || typeof f.key !== "string" || !KEY_RE.test(f.key) || keys.has(f.key)) problems.push(`${w}: its key is missing or repeated.`);
      else keys.add(f.key);
      if (!FIELD_TYPES.includes(f?.type)) problems.push(`${w}: unknown field type.`);
      if (!isLang(f?.label, LIMITS.label)) problems.push(`${w}: give the question some words.`);
      if (f?.help !== undefined && !isLang(f.help, LIMITS.help)) problems.push(`${w}: the help text is not valid.`);
      if (f?.type === "choice") {
        const opts = f.options ?? [];
        if (opts.length < 2) problems.push(`${w}: a choice needs at least two options.`);
        if (opts.length > LIMITS.options) problems.push(`${w}: at most ${LIMITS.options} options.`);
        const values = new Set<string>();
        for (const o of opts) {
          if (!o || typeof o.value !== "string" || !KEY_RE.test(o.value) || values.has(o.value)) problems.push(`${w}: an option's key is missing or repeated.`);
          else values.add(o.value);
          if (!isLang(o?.label, LIMITS.label)) problems.push(`${w}: every option needs some words.`);
          if (o?.help !== undefined && !isLang(o.help, LIMITS.help)) problems.push(`${w}: an option's help text is not valid.`);
          checkEffects(o?.effects, `${w}, option "${isLang(o?.label, LIMITS.label) ? o.label.en : o?.value}"`, ctx, problems);
        }
      } else if (f?.options !== undefined) {
        problems.push(`${w}: only a choice has options.`);
      }
      if (f?.type === "yesno") checkEffects(f.ifYes, `${w}, when the answer is yes`, ctx, problems);
      else if (f?.ifYes !== undefined) problems.push(`${w}: only a yes or no question can have effects.`);
      if (f?.maxLength !== undefined && (!Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 2000)) problems.push(`${w}: the length limit must be between 1 and 2000.`);
      if (f?.showIf) {
        const target = seenFields.find((p) => p.key === f.showIf?.field);
        if (!target) problems.push(`${w}: it depends on a question that does not come before it.`);
        else if (target.type !== "choice") problems.push(`${w}: it can only depend on a choice.`);
        else if (f.showIf.equals !== undefined && !target.options?.some((o) => o.value === f.showIf?.equals)) problems.push(`${w}: it depends on an option that no longer exists.`);
      }
      if (f) seenFields.push(f);
    }
  }
  if (fieldCount > LIMITS.fields) problems.push(`A form can have at most ${LIMITS.fields} fields.`);

  // What Halo needs to file a report at all.
  const all = schema.steps.flatMap((s) => (Array.isArray(s?.fields) ? s.fields : []));
  if (!all.some((f) => f?.type === "involved")) problems.push("Add a \"Who was involved?\" field.");
  if (all.filter((f) => f?.type === "involved").length > 1) problems.push("Only one \"Who was involved?\" field is allowed.");
  const filing = all.filter((f) => f?.type === "choice" && f.options?.some((o) => o.effects?.category));
  if (filing.length === 0) problems.push("Add a choice whose options say what kind of incident it is (each option files under a category).");
  for (const f of filing) {
    const unfiled = (f.options ?? []).filter((o) => !o.effects?.category);
    if (unfiled.length > 0 && f.required) problems.push(`"${f.label?.en}": every option must file under a category, or a report could not be filed.`);
    if (f.showIf) problems.push(`"${f.label?.en}": the question about the kind of incident must always be shown.`);
    if (!f.required) problems.push(`"${f.label?.en}": the question about the kind of incident must be required.`);
  }
  return problems;
}

// ---- comparing versions -----------------------------------------------------------------------------------------

export interface SchemaDiff {
  added: string[];
  removed: string[];
  changed: string[];
  moved: string[];
  same: boolean;
}

const fieldsOf = (s: FormSchema) => s.steps.flatMap((st) => st.fields.map((f) => ({ f, step: st.key })));
const name = (f: FormField) => f.label?.en ?? f.key;

/** What changed between two versions, in the words an admin would use: questions added, removed, reworded or changed, and moved to another step. */
export function diffSchemas(before: FormSchema, after: FormSchema): SchemaDiff {
  const a = new Map(fieldsOf(before).map((x) => [x.f.key, x]));
  const b = new Map(fieldsOf(after).map((x) => [x.f.key, x]));
  const added = [...b.keys()].filter((k) => !a.has(k)).map((k) => name(b.get(k)!.f));
  const removed = [...a.keys()].filter((k) => !b.has(k)).map((k) => name(a.get(k)!.f));
  const changed: string[] = [];
  const moved: string[] = [];
  for (const [k, now] of b) {
    const was = a.get(k);
    if (!was) continue;
    if (JSON.stringify(was.f) !== JSON.stringify(now.f)) changed.push(name(now.f));
    if (was.step !== now.step) moved.push(name(now.f));
  }
  const stepsBefore = before.steps.map((s) => s.title.en).join("|");
  const stepsAfter = after.steps.map((s) => s.title.en).join("|");
  const same = added.length + removed.length + changed.length + moved.length === 0 && stepsBefore === stepsAfter;
  return { added, removed, changed, moved, same };
}
