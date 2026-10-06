// ============================================================
// Words that come from a form's own definition: pick a language's text, and how an answer reads in
// words (a choice by its label, a yes or no in the reader's language, a list as lines). Used to print
// answers on the PDF, to show them to the sender and to word write-back.
// ============================================================

import type { SignLocale } from "../types";
import type { DataField, FormValue, L10n } from "./types";

/** The text in `locale`, or English when that language was left empty. */
export function pick(text: L10n | undefined, locale: SignLocale): string {
  if (!text) return "";
  return (text[locale as keyof L10n] && String(text[locale as keyof L10n]).trim()) || text.en || "";
}

const YES: Record<SignLocale, string> = { en: "Yes", ms: "Ya", zh: "是", ko: "예" };
const NO: Record<SignLocale, string> = { en: "No", ms: "Tidak", zh: "否", ko: "아니요" };
export const yesNoWord = (checked: boolean, locale: SignLocale) => (checked ? YES[locale] : NO[locale]);

/** One option's label in `locale`. An unknown value reads as itself. */
export function optionLabel(field: DataField, value: string, locale: SignLocale): string {
  const o = field.options?.find((x) => x.value === value);
  return o ? pick(o.label, locale) || value : value;
}

/**
 * An answer as words. A list is joined with `listSeparator` ("\n" for a multi-line box, ", " otherwise).
 * Files and pictures read as their file names (the engine draws a picture; this is for lists and summaries).
 */
export function displayValue(field: DataField, value: FormValue | undefined, locale: SignLocale, listSeparator = ", "): string {
  if (!value) return "";
  if ("text" in value) {
    if (field.type === "choice") return optionLabel(field, value.text, locale);
    return value.text;
  }
  if ("checked" in value) return field.type === "acknowledge" ? (value.checked ? YES[locale] : "") : yesNoWord(value.checked, locale);
  if ("choices" in value) return value.choices.map((c) => optionLabel(field, c, locale)).join(listSeparator);
  if ("list" in value) return value.list.join(listSeparator);
  if ("files" in value) return value.files.map((f) => f.name).join(listSeparator);
  if ("image" in value) return "";
  return "";
}
