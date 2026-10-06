// ============================================================
// A form's answers as words, part by part: what a person reads when they review before they submit, and what the
// sealed submission record of a form without a signature prints (migration 169). Only the parts and fields that are
// SHOWN for these answers, in the form's order, each answer as `displayValue` reads it in the document's language.
//
// A sensitive answer is never given in full: it is its mask (`•••• 1234`, or `**** 1234` where a PDF font may lack
// the dot). Nothing here reads a database or a file; the caller decides whose answers to pass.
// Pure: no React, no I/O.
// ============================================================

import type { SignLocale } from "../types";
import { fieldsOfPart } from "./completion";
import { partVisible } from "./rules";
import { MASK_CHAR, isSensitive, maskValue } from "./sensitive";
import { displayValue, pick } from "./text";
import type { AnswerMap, DataFieldType, FormDefinition, FormValue, FormValueView } from "./types";

/** A file named in an answer: its name and fingerprint (the record lists them), never its path. */
export interface SummaryFile {
  name: string;
  size: number;
  sha256: string;
}

export interface SummaryRow {
  key: string;
  label: string;
  type: DataFieldType;
  /** The answer in words; "" when there is none or when it is a picture or a file (see `files` and `picture`). */
  text: string;
  answered: boolean;
  sensitive: boolean;
  /** The files of a file field. */
  files: SummaryFile[];
  /** A picture was given (an image field). */
  picture: boolean;
}

export interface SummaryPart {
  key: string;
  title: string;
  roleKey: string;
  rows: SummaryRow[];
}

/** Every answer a summary names is an `AnswerMap` of the stored values or of what a browser is given (files without paths). */
type Answers = Readonly<Record<string, FormValue | FormValueView | undefined>>;

export function submissionSummary(form: FormDefinition, answers: Answers, locale: SignLocale, opts: { maskChar?: string } = {}): SummaryPart[] {
  const char = opts.maskChar ?? MASK_CHAR;
  const map = answers as AnswerMap;
  const parts: SummaryPart[] = [];
  for (const part of form.parts) {
    if (!partVisible(part, map)) continue;
    const rows: SummaryRow[] = [];
    for (const field of fieldsOfPart(form, part.key, map)) {
      const raw = answers[field.key];
      const secret = isSensitive(field);
      const value = raw && secret ? (maskValue(raw, char) as FormValue) : (raw as FormValue | undefined);
      const files: SummaryFile[] = value && "files" in value ? value.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })) : [];
      const picture = !!value && "image" in value && !!value.image;
      rows.push({
        key: field.key,
        label: pick(field.label, locale) || field.key,
        type: field.type,
        text: files.length > 0 || picture ? "" : displayValue(field, value, locale, "\n"),
        answered: value !== undefined && (files.length > 0 || picture || displayValue(field, value, locale, "\n").trim() !== ""),
        sensitive: secret,
        files,
        picture,
      });
    }
    parts.push({ key: part.key, title: pick(part.title, locale) || part.key, roleKey: part.role, rows });
  }
  return parts;
}
