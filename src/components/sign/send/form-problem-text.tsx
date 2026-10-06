"use client";

import { useTranslations } from "next-intl";

import type { SignIssue } from "@/lib/sign/client/api";
import { problemKey } from "@/lib/sign/client/errors";

/** The sentence for a problem of a document with a form (its words are in `Sign.progress.problems`). */
export function FormProblemText({ issue, roleLabel }: { issue: SignIssue; roleLabel: string }) {
  const t = useTranslations("Sign.progress");
  return <>{t(problemKey(issue.code), { role: roleLabel })}</>;
}
