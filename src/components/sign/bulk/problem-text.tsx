"use client";

import { useTranslations } from "next-intl";

import { fileProblemKey, planProblemKey, rowReasonKey } from "@/lib/sign/client/bulk";
import { decodeProblem } from "@/lib/sign/bulk/results";
import { ROW_PROBLEM_CODES, type BulkProblem } from "@/lib/sign/bulk/types";

/** The words for a problem the server found in a row (`problem.<code>`, with the column or row it is about). */
export function useProblemWords() {
  const t = useTranslations("Sign.bulk");
  return {
    row: (p: BulkProblem): string => t(`problem.${p.code}`, { detail: p.detail ?? "" }),
    file: (p: BulkProblem): string => t(fileProblemKey(p.code), { detail: p.detail ?? "" }),
    plan: (p: BulkProblem): string => t(planProblemKey(p.code), { detail: p.detail ?? "" }),
    /** What became of a row: a failed send's code, or a skipped row's problem (`code` or `code:detail`). */
    reason: (code: string | null, message: string | null): string => {
      const d = decodeProblem(code);
      if (!d) return "";
      // a row skipped for its own problem is worded like the problem; any other code has its own sentence
      if ((ROW_PROBLEM_CODES as readonly string[]).includes(d.code)) return t(`problem.${d.code}`, { detail: d.detail ?? "" });
      const key = rowReasonKey(d.code);
      return key === "reason.unknown" && message ? t("reason.withMessage", { message }) : t(key);
    },
  };
}

/** A list of problems, each as a sentence. */
export function ProblemList({ problems, word }: { problems: readonly BulkProblem[]; word: (p: BulkProblem) => string }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {problems.map((p, i) => (
        <li key={`${p.code}-${p.detail ?? ""}-${i}`}>{word(p)}</li>
      ))}
    </ul>
  );
}
