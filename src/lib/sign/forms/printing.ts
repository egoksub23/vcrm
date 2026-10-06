// ============================================================
// Printing answers: which text or tick or picture each bound placement on the PDF gets, from the
// answers to the form. A placement is "bound" when its `data` names a data field; it draws that field's
// answer (a list one entry to a line in a multi-line box, a choice by its label in the document's
// language, a yes or no as a tick when the placement is a tick box). Hidden fields print nothing.
//
// Also: which bound placements cannot fit their answer, so the signer is told which answer to shorten
// before they sign.
// ============================================================

import { decodeImageDataUrl } from "../rules";
import { stampFields } from "../pdf/stamp";
import type { FieldValue, FieldValues, PlacedField } from "../pdf/types";
import type { SignLocale } from "../types";
import { fieldVisible, factOf } from "./rules";
import { displayValue } from "./text";
import type { AnswerMap, DataField, FormDefinition } from "./types";

/** The placements that print a data field. */
export const boundPlacements = (fields: readonly PlacedField[]): PlacedField[] => fields.filter((f) => !!f.data);

/** The value one bound placement draws, or null when it draws nothing. */
export function valueForPlacement(placement: PlacedField, field: DataField, answers: AnswerMap, form: FormDefinition, locale: SignLocale): FieldValue | null {
  if (!fieldVisible(form, field, answers)) return null;
  const answer = answers[field.key];
  if (!answer) return null;

  if (placement.type === "checkbox") {
    const fact = factOf(answer);
    if (placement.dataValue !== undefined) {
      return Array.isArray(fact) ? (fact.includes(placement.dataValue) ? { checked: true } : null) : fact === placement.dataValue ? { checked: true } : null;
    }
    if ("checked" in answer) return answer.checked ? { checked: true } : null;
    return fact !== undefined ? { checked: true } : null;
  }

  if (placement.type === "upload" || placement.type === "signature" || placement.type === "initials") {
    if (!("image" in answer)) return null;
    const img = decodeImageDataUrl(answer.image);
    return img ? { image: { bytes: img.bytes, mime: img.mime } } : null;
  }

  if (placement.type === "date" && "text" in answer) return { text: answer.text };
  if (placement.type === "number" && "text" in answer) return { text: answer.text };

  const separator = placement.multiline ? "\n" : ", ";
  const text = displayValue(field, answer, locale, separator);
  return text ? { text } : null;
}

/**
 * The values of every bound placement, keyed by placement key. `fields` are the document's placements.
 */
export function boundValues(fields: readonly PlacedField[], form: FormDefinition, answers: AnswerMap, locale: SignLocale): FieldValues {
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  const out: Record<string, FieldValue> = {};
  for (const p of boundPlacements(fields)) {
    const field = byKey.get(p.data as string);
    if (!field) continue;
    const v = valueForPlacement(p, field, answers, form, locale);
    if (v) out[p.key] = v;
  }
  return out;
}

export interface FitProblem {
  /** The data field whose answer is too long for the place it prints. */
  field: string;
  placement: string;
}

/**
 * Which bound placements cannot show their answer even at the smallest size. Text only; the PDF's own fonts
 * are measured exactly as the engine will draw them.
 */
export async function fitProblems(pdf: Uint8Array, fields: readonly PlacedField[], form: FormDefinition, answers: AnswerMap, locale: SignLocale): Promise<FitProblem[]> {
  const bound = boundPlacements(fields).filter((p) => p.type !== "checkbox" && p.type !== "upload" && p.type !== "signature" && p.type !== "initials");
  if (bound.length === 0) return [];
  const values = boundValues(bound, form, answers, locale);
  const placements = bound.filter((p) => values[p.key]?.text);
  if (placements.length === 0) return [];
  // draw them onto the file as the seal will and read the engine's own verdict
  const stamped = await stampFields(pdf, placements, values, { locale });
  const truncated = new Set(stamped.warnings.filter((w) => w.code === "text_truncated").map((w) => w.field));
  return placements.filter((p) => truncated.has(p.key)).map((p) => ({ field: p.data as string, placement: p.key }));
}

/** Fixed text (static fields) that cannot fit its box: found when a template is saved. */
export async function staticFitProblems(pdf: Uint8Array, fields: readonly PlacedField[]): Promise<string[]> {
  const fixed = fields.filter((f) => f.type === "static_text" && f.text && !f.merge);
  if (fixed.length === 0) return [];
  const values: Record<string, FieldValue> = {};
  for (const f of fixed) values[f.key] = { text: f.text as string };
  const stamped = await stampFields(pdf, fixed, values, {});
  return [...new Set(stamped.warnings.filter((w) => w.code === "text_truncated").map((w) => w.field))];
}
