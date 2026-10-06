// ============================================================
// How far along a form is: the state of each part (not started, in progress, done), what is still
// missing, and whether the sign step may open. The browser draws these as the overview; the server runs
// the same functions as the authority when the signature arrives, so a browser's idea of "done" is never
// trusted.
// ============================================================

import { recheckStored } from "./check";
import { fieldRequired, fieldVisible, partVisible } from "./rules";
import type { AnswerMap, DataField, FormDefinition, FormPart, PartProgress } from "./types";

const hasAnswer = (answers: AnswerMap, key: string) => answers[key] !== undefined;

/** The parts a role completes, in order, that are shown for these answers. */
export function partsForRole(form: FormDefinition, roleKey: string, answers: AnswerMap): FormPart[] {
  return form.parts.filter((p) => p.role === roleKey && partVisible(p, answers));
}

/** The shown fields of a part, in order. */
export function fieldsOfPart(form: FormDefinition, partKey: string, answers: AnswerMap): DataField[] {
  return form.fields.filter((f) => f.part === partKey && fieldVisible(form, f, answers));
}

export function partProgress(form: FormDefinition, part: FormPart, answers: AnswerMap, lastSavedAt?: string | null): PartProgress {
  const fields = fieldsOfPart(form, part.key, answers);
  const required = fields.filter((f) => fieldRequired(form, f, answers));
  const doneRequired = required.filter((f) => hasAnswer(answers, f.key)).length;
  const anyAnswer = fields.some((f) => hasAnswer(answers, f.key));
  let state: PartProgress["state"];
  if (required.length > 0 ? doneRequired === required.length : anyAnswer) state = "done";
  else if (anyAnswer) state = "in_progress";
  else state = "not_started";
  return { key: part.key, state, done: doneRequired, total: required.length, visible: fields.length, lastSavedAt: lastSavedAt ?? null };
}

/** Progress of every part a role completes. `savedAt` is when each data field's answer was last saved. */
export function roleProgress(form: FormDefinition, roleKey: string, answers: AnswerMap, savedAt: Readonly<Record<string, string | undefined>> = {}): PartProgress[] {
  return partsForRole(form, roleKey, answers).map((part) => {
    const keys = form.fields.filter((f) => f.part === part.key).map((f) => f.key);
    const last = keys.map((k) => savedAt[k]).filter((x): x is string => !!x).sort().pop() ?? null;
    return partProgress(form, part, answers, last);
  });
}

/** The required fields of a role's parts with no answer yet. */
export function missingFormRequired(form: FormDefinition, roleKey: string, answers: AnswerMap): DataField[] {
  const out: DataField[] = [];
  for (const part of partsForRole(form, roleKey, answers)) {
    for (const f of fieldsOfPart(form, part.key, answers)) {
      if (fieldRequired(form, f, answers) && !hasAnswer(answers, f.key)) out.push(f);
    }
  }
  return out;
}

/** Every shown answer of a role's parts that is no longer sound (the definition may have changed rules, never the answers). */
export function unsoundAnswers(form: FormDefinition, roleKey: string, answers: AnswerMap): { field: string; code: string }[] {
  const out: { field: string; code: string }[] = [];
  for (const part of partsForRole(form, roleKey, answers)) {
    for (const f of fieldsOfPart(form, part.key, answers)) {
      const v = answers[f.key];
      if (!v) continue;
      const r = recheckStored(f, v);
      if (!r.ok) out.push({ field: f.key, code: r.code });
    }
  }
  return out;
}

/** May the sign step open? Every required field of the role's parts is answered. A role with no parts is always ready. */
export function signReady(form: FormDefinition, roleKey: string, answers: AnswerMap): boolean {
  return missingFormRequired(form, roleKey, answers).length === 0;
}

/** Share of required fields answered across a role's parts, 0 to 100. */
export function overallPercent(progress: readonly PartProgress[]): number {
  const total = progress.reduce((n, p) => n + p.total, 0);
  if (total === 0) return progress.every((p) => p.state === "done") ? 100 : 0;
  return Math.round((progress.reduce((n, p) => n + Math.min(p.done, p.total), 0) / total) * 100);
}
