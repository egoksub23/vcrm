// ============================================================
// Doc Sign form builder: text in each language. Every label, help text, option and acknowledge text is an
// L10n: English is required, the other languages are optional and fall back to English. These helpers set
// one language's text without ever producing an L10n the server would refuse, and count how much of a form is
// translated so the sender can see what is left for a language.
// Pure: no React, no I/O.
// ============================================================

import type { FormDefinition, L10n } from "../forms/types";
import type { SignLocale } from "../types";

export const AUTHOR_LOCALES: readonly SignLocale[] = ["en", "ms", "zh", "ko"];

/** The text in one language as typed (not the English fallback). */
export const textIn = (value: L10n | undefined, lang: SignLocale): string => (value ? ((value as Record<string, string | undefined>)[lang] ?? "") : "");

/**
 * `value` with `lang` set to `text`. A language other than English left empty is removed (so it falls back to English).
 * With `required`, English is always present (empty while being typed); without it, a text with nothing in any language is undefined.
 */
export function setText(value: L10n | undefined, lang: SignLocale, text: string, required: boolean): L10n | undefined {
  const next: Record<string, string> = { ...(value ?? { en: "" }) };
  if (lang === "en") next.en = text;
  else if (text === "") delete next[lang];
  else next[lang] = text;
  if (typeof next.en !== "string") next.en = "";
  if (!required && Object.values(next).every((v) => v.trim() === "")) return undefined;
  return next as unknown as L10n;
}

export interface Coverage {
  /** Strings that have text in this language. */
  done: number;
  /** Strings the form has (each is English-required, so each could be translated). */
  total: number;
}

/** Every piece of text in the form a signer reads, as L10n values: part titles and descriptions, field labels, help, placeholders, option labels, acknowledge text. */
export function formTexts(form: FormDefinition): L10n[] {
  const out: L10n[] = [];
  for (const p of form.parts) {
    out.push(p.title);
    if (p.description) out.push(p.description);
  }
  for (const f of form.fields) {
    out.push(f.label);
    if (f.help) out.push(f.help);
    if (f.placeholder) out.push(f.placeholder);
    if (f.text) out.push(f.text);
    // the options of a shared list are worded in Settings > Doc Sign > Lists, not here
    if (f.optionList === undefined) for (const o of f.options ?? []) out.push(o.label);
  }
  return out;
}

/** How much of the form has its own text in `lang` (English counts everything that has English). */
export function coverage(form: FormDefinition, lang: SignLocale): Coverage {
  const texts = formTexts(form);
  return { done: texts.filter((t) => textIn(t, lang).trim() !== "").length, total: texts.length };
}
