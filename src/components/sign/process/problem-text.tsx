"use client";

// ============================================================
// Doc Sign, what is wrong with a process, in plain words: one component for every problem the workflow can show (a document's own, the people's,
// the options'), for a document on its own and for a collection. The words are the ones the old screens used (`Sign.send.problems`, the
// collection's `Sign.send.envelope.problems`, a form's `Sign.progress.problems`).
// ============================================================

import { useTranslations } from "next-intl";

import type { SignIssue } from "@/lib/sign/client/api";
import { problemKey, problemNamespace } from "@/lib/sign/client/errors";
import type { ProcessDoc } from "@/lib/sign/client/process";
import { MAX_SIGNERS } from "@/lib/sign/rules";
import type { EnvelopePerson } from "@/lib/sign/envelopes";

import { FormProblemText } from "../send/form-problem-text";

/** The codes worded by the collection's own messages (the shared list of people, the size). */
const PEOPLE_CODES = new Set(["envelope_size", "envelope_too_many_pages", "duplicate_person", "person_without_document", "role_two_people", "person_without_work", "document_nobody", "too_many_copies", "too_many_roles"]);

/**
 * Split a document's problems into the ones with words of their own and the layout ones (a field off the page, a role with a bad name...): those are
 * many and small, and mean "open the editor", so they read as one line. Only a code with no words of its own is a layout problem.
 */
export function splitIssues(issues: readonly SignIssue[]): { lines: SignIssue[]; layoutCount: number } {
  const lines: SignIssue[] = [];
  let layoutCount = 0;
  for (const i of issues) {
    if (PEOPLE_CODES.has(i.code) || problemKey(i.code) !== "problems.layout" || problemNamespace(i.code) === "Sign.progress") lines.push(i);
    else layoutCount += 1;
  }
  return { lines, layoutCount };
}

interface Props {
  issue: SignIssue;
  docs: readonly ProcessDoc[];
  people: readonly EnvelopePerson[];
}

export function ProblemText({ issue, docs, people }: Props) {
  const t = useTranslations("Sign.send.envelope");
  const tErr = useTranslations("Sign.send");

  const at = issue.detail && /^\d+$/.test(issue.detail) ? Number(issue.detail) : -1;
  const doc = docs.find((d) => d.id === issue.document);
  const role = doc?.roles.find((r) => r.key === issue.role)?.label ?? issue.role ?? "";
  // a person by the place a problem names (the index in the list the server checked: the people who must sign, then the people who receive a copy)
  const name = (at >= 0 ? people[at]?.fullName.trim() : "") || t("people.personN", { n: at + 1 });

  if (PEOPLE_CODES.has(issue.code)) {
    return <>{t(`problems.${issue.code}`, { n: at >= 0 ? at + 1 : 0, name, role, document: doc?.title ?? "", range: issue.detail ?? "", max: MAX_SIGNERS })}</>;
  }
  if (problemNamespace(issue.code) === "Sign.progress") return <FormProblemText issue={issue} roleLabel={role} />;
  return <>{tErr(problemKey(issue.code), { n: at >= 0 ? at + 1 : 0, role, max: MAX_SIGNERS, count: 1 })}</>;
}
