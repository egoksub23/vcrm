// ============================================================
// Doc Sign form builder: "Preview as signer", without a network. From the form and a role, build exactly the
// view a signer's page is given (SignerFormView) using the same functions the server uses (progress, ready,
// which parts and fields are shown), and keep test answers locally. A typed answer goes through the real
// answer check, so a preview rejects what a signer would be refused.
// Pure: no React, no I/O.
// ============================================================

import { checkDataAnswer } from "../forms/check";
import { overallPercent, roleProgress, signReady, partsForRole } from "../forms/completion";
import { fieldVisible, factOf } from "../forms/rules";
import { displayValue } from "../forms/text";
import type { AnswerMap, DataAnswerInput, DataField, FileSummary, FormDefinition, FormValue, FormValueView, SignerFormView } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import type { SignLocale } from "../types";

/** Test answers by data field key. Files keep a StoredFile shape (the path is never shown). */
export type TestAnswers = Readonly<Record<string, FormValue | undefined>>;

export type ApplyResult = { answers: TestAnswers; error?: { code: string; detail?: string } };

/** Put one typed answer in, as a signer's save would: refused answers leave the answers as they were. An empty one removes it. */
export function applyInput(form: FormDefinition, answers: TestAnswers, key: string, input: DataAnswerInput): ApplyResult {
  const field = form.fields.find((f) => f.key === key);
  if (!field) return { answers };
  const result = checkDataAnswer(field, input);
  if (!result.ok) return { answers, error: { code: result.code, detail: result.detail } };
  const next = { ...answers };
  if (result.value === null) delete next[key];
  else next[key] = result.value;
  return { answers: next };
}

/** A fake upload: a file answer with the name and size, nothing stored. Respects the field's file count. */
export function addTestFile(answers: TestAnswers, field: DataField, file: { name: string; size: number; type: string }, id: string): ApplyResult {
  const existing = answers[field.key];
  const files = existing && "files" in existing ? existing.files : [];
  if (files.length >= (field.maxFiles ?? 1)) return { answers, error: { code: "too_many_files", detail: String(field.maxFiles ?? 1) } };
  const stored = { id, name: file.name, mime: file.type || "application/octet-stream", size: file.size, sha256: "preview", path: "" };
  return { answers: { ...answers, [field.key]: { files: [...files, stored] } } };
}

export function removeTestFile(answers: TestAnswers, key: string, id: string): TestAnswers {
  const existing = answers[key];
  if (!existing || !("files" in existing)) return answers;
  const files = existing.files.filter((f) => f.id !== id);
  const next = { ...answers };
  if (files.length === 0) delete next[key];
  else next[key] = { files };
  return next;
}

const toView = (v: FormValue): FormValueView => {
  if ("files" in v) return { files: v.files.map(({ id, name, mime, size, sha256 }): FileSummary => ({ id, name, mime, size, sha256 })) };
  return v;
};

/** The view of the form a signer in `roleKey` would be given with these answers. */
export function previewView(form: FormDefinition, roleKey: string, answers: TestAnswers): SignerFormView {
  const map: AnswerMap = answers;
  const progress = roleProgress(form, roleKey, map);
  const views: Record<string, FormValueView> = {};
  for (const [k, v] of Object.entries(answers)) if (v) views[k] = toView(v);
  return {
    definition: form,
    partKeys: partsForRole(form, roleKey, map).map((p) => p.key),
    answers: views,
    unconfirmed: [],
    progress,
    ready: signReady(form, roleKey, map),
  };
}

export const previewPercent = (form: FormDefinition, roleKey: string, answers: TestAnswers): number => overallPercent(roleProgress(form, roleKey, answers));

export interface PrintedRow {
  placement: string;
  page: number;
  field: string;
  /** What is drawn: text, or a tick. */
  text?: string;
  checked?: boolean;
}

/**
 * What the bound placements would print for these answers (text and ticks; pictures are not drawn). Mirrors the engine's printing.ts
 * for the cases a preview shows, without loading the PDF engine into the browser.
 */
export function printedRows(form: FormDefinition, placements: readonly PlacedField[], answers: TestAnswers, locale: SignLocale): PrintedRow[] {
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  const rows: PrintedRow[] = [];
  for (const p of placements) {
    if (!p.data) continue;
    const field = byKey.get(p.data);
    const answer = field ? answers[field.key] : undefined;
    if (!field || !answer || !fieldVisible(form, field, answers)) continue;
    const base = { placement: p.key, page: p.page + 1, field: field.key };
    if (p.type === "checkbox") {
      const fact = factOf(answer);
      const ticked = p.dataValue !== undefined ? (Array.isArray(fact) ? fact.includes(p.dataValue) : fact === p.dataValue) : "checked" in answer ? answer.checked : fact !== undefined;
      if (ticked) rows.push({ ...base, checked: true });
      continue;
    }
    if (p.type === "upload" || "image" in answer) {
      if ("image" in answer) rows.push({ ...base, text: "" });
      continue;
    }
    const text = p.type === "date" || p.type === "number" ? ("text" in answer ? answer.text : "") : displayValue(field, answer, locale, p.multiline ? "\n" : ", ");
    if (text) rows.push({ ...base, text });
  }
  return rows;
}
