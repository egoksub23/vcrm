// Turning a coach's stored answers back into labelled lines for the incident page, using the form version the report was filed under (so a form edited
// later never changes how an old report reads).

import { labelOf } from "@/lib/incidents/platform/roles";
import { allVisibleFields, type Answers, type FormSchema, type InvolvedAnswer } from "./form-schema";

export interface AnswerLine {
  key: string;
  label: string;
  value: string;
}

/** One line per question that was shown and answered. The "who was involved" question is left out: the people are listed on their own. Photos are files, not answers. */
export function answerLines(schema: FormSchema, answers: Answers, lang = "en"): AnswerLine[] {
  const lines: AnswerLine[] = [];
  for (const f of allVisibleFields(schema, answers)) {
    if (f.type === "involved" || f.type === "photo") continue;
    const v = answers[f.key];
    let value: string | null = null;
    if (f.type === "choice") value = v == null || v === "" ? null : labelOf(f.options?.find((o) => o.value === v)?.label, lang) || String(v);
    else if (f.type === "yesno") value = typeof v === "boolean" ? (v ? "Yes" : "No") : null;
    else if (typeof v === "string" && v.trim()) value = v.trim();
    if (value !== null) lines.push({ key: f.key, label: labelOf(f.label, lang), value });
  }
  return lines;
}

export function involvedCount(answers: Answers): number {
  const a = answers.involved as InvolvedAnswer | undefined;
  return (a?.ids?.length ?? 0) + (a?.others?.length ?? 0);
}
