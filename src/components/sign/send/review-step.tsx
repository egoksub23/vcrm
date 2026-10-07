"use client";

import { AlertCircle, CheckCircle2, Loader2, Send } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { SignIssue } from "@/lib/sign/client/api";
import { defaultExpiryDate, fromDateInput, parseReminderDays, type DraftOptions } from "@/lib/sign/client/draft-options";
import { splitLayoutIssues } from "@/lib/sign/client/draft-problems";
import { copyNotices, copyPayload, type CopyRow } from "@/lib/sign/client/copy-form";
import { errorKey, problemKey, problemNamespace, problemStep, type DraftStep } from "@/lib/sign/client/errors";
import { reviewLines, type SignerRow } from "@/lib/sign/client/signers-form";
import { MAX_SIGNERS } from "@/lib/sign/rules";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignMode, SignRole } from "@/lib/sign/types";
import { FormReviewSummary } from "./form-review-summary";
import { FormProblemText } from "./form-problem-text";

interface Props {
  roles: readonly SignRole[];
  rows: readonly SignerRow[];
  options: DraftOptions;
  categoryName: string | null;
  contactName: string | null;
  defaultExpiryDays: number;
  now: number;
  problems: readonly SignIssue[];
  /** Saving what is on screen and reading the draft again before showing the verdict. */
  checking: boolean;
  canSend: boolean;
  sending: boolean;
  sendErrorCode: string | null;
  onSend: () => void;
  onGoToStep: (step: DraftStep) => void;
  /** Forms: the document's form, summarised below the people. */
  form?: FormDefinition | null;
  /** A form without a signature (migration 169): the words say "Send the form" and "submit". */
  mode?: SignMode;
  /** Migration 175: the people who receive the signed copy. They are listed apart from the people who sign. */
  copies?: readonly CopyRow[];
}

/** Step 4: what will happen, in plain words, what still stops it, and the Send button. */
export function ReviewStep({ roles, rows, options, categoryName, contactName, defaultExpiryDays, now, problems, checking, canSend, sending, sendErrorCode, onSend, onGoToStep, form, mode, copies = [] }: Props) {
  const t = useTranslations("Sign.send.review");
  const tc = useTranslations("Sign.send.copies");
  const tProblems = useTranslations("Sign.send");
  const f = useFormatter();
  const people = reviewLines(rows, roles, options.signInOrder);
  // who gets the signed copy (what is saved), and what was left out of it: an address listed twice, or one that signs (a notice, not a block:
  // the person signs, or is listed once, so nobody is missed)
  const signerEmails = rows.map((r) => r.email);
  const copyPeople = copyPayload(copies, signerEmails);
  const copyLeftOut = copyNotices(copies, signerEmails).filter((n) => n.kind === "signer" || n.positions[0] !== n.index + 1);
  const { single, layoutCount } = splitLayoutIssues(problems);
  const blocked = problems.length > 0;

  const expiryIso = options.expiryDate ? fromDateInput(options.expiryDate) : null;
  const expiry = expiryIso
    ? t("expiresOn", { date: f.dateTime(new Date(expiryIso), { dateStyle: "long" }) })
    : t("expiresDefault", { days: defaultExpiryDays, date: f.dateTime(new Date(`${defaultExpiryDate(new Date(now), defaultExpiryDays)}T12:00:00`), { dateStyle: "long" }) });
  const reminders = parseReminderDays(options.reminderText);

  const problemText = (issue: SignIssue): string => {
    const n = issue.detail && /^\d+$/.test(issue.detail) ? Number(issue.detail) + 1 : 0;
    const role = roles.find((r) => r.key === issue.role)?.label ?? issue.role ?? "";
    return tProblems(problemKey(issue.code), { n, role, max: MAX_SIGNERS, count: 1 });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <section aria-labelledby="review-what" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div>
          <h2 id="review-what" className="text-base font-semibold text-foreground">
            {options.title.trim() || t("untitled")}
          </h2>
          <p className="text-xs text-muted-foreground">{[categoryName, contactName].filter(Boolean).join(" · ")}</p>
        </div>

        <p className="text-sm text-foreground">{options.signInOrder ? t(mode === "form" ? "orderedIntroForm" : "orderedIntro") : t(mode === "form" ? "allAtOnceForm" : "allAtOnce")}</p>
        {people.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nobody")}</p>
        ) : (
          <ol className="space-y-2">
            {people.map((p) => {
              const together = options.signInOrder ? people.filter((x) => x.step === p.step).length : 1;
              return (
                <li key={p.position} className="flex gap-3 text-sm">
                  {options.signInOrder ? <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{p.step}</span> : <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden />}
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">{p.name || t("noName")}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[p.roleLabel, p.kind === "signer" ? t("signs") : t("fillsIn"), p.channel === "whatsapp" ? t("byWhatsapp", { phone: p.phone }) : t("byEmail", { email: p.email })].join(" · ")}
                    </span>
                    {together > 1 ? <span className="block text-xs text-muted-foreground">{t("sameStep", { step: p.step, count: together })}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {copyPeople.length > 0 ? (
          <p data-copy-review className="text-sm text-foreground">
            {tc("reviewLine", { people: copyPeople.map((c) => `${c.fullName} (${c.email})`).join(", "), count: copyPeople.length })}
          </p>
        ) : null}
        {copyLeftOut.map((n) => (
          <p key={`${n.kind}-${n.index}`} className="text-xs text-amber-700 dark:text-amber-300">
            {n.kind === "signer" ? tc("isSigner", { email: n.email }) : tc("sameEmail", { email: n.email, a: n.positions[0], b: n.index + 1 })}
          </p>
        ))}

        <dl className="grid gap-x-4 gap-y-1.5 border-t border-border pt-3 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted-foreground">{t("expiryLabel")}</dt>
          <dd className="text-foreground">{expiry}</dd>
          <dt className="text-muted-foreground">{t("remindersLabel")}</dt>
          <dd className="text-foreground">{reminders.length ? t("remindersOn", { days: reminders.join(", "), count: reminders.length }) : t("remindersOff")}</dd>
          <dt className="text-muted-foreground">{t("codeLabel")}</dt>
          <dd className="text-foreground">{options.codeRequired ? t(mode === "form" ? "codeOnForm" : "codeOn") : t("codeOff")}</dd>
          <dt className="text-muted-foreground">{t("forwardingLabel")}</dt>
          <dd className="text-foreground">{options.allowForwarding ? t("forwardingOn") : t("forwardingOff")}</dd>
          <dt className="text-muted-foreground">{t("languageLabel")}</dt>
          <dd className="text-foreground">{tProblems(`options.lang.${options.locale}`)}</dd>
          {options.message.trim() ? (
            <>
              <dt className="text-muted-foreground">{t("messageLabel")}</dt>
              <dd className="whitespace-pre-wrap text-foreground">{options.message.trim()}</dd>
            </>
          ) : null}
        </dl>
      </section>

      {form && form.parts.length > 0 ? <FormReviewSummary form={form} roles={roles} rows={rows} contactId={options.contactId} /> : null}

      {checking ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("checking")}
        </p>
      ) : blocked ? (
        <section aria-labelledby="review-problems" className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <h3 id="review-problems" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <AlertCircle className="size-4 text-amber-700 dark:text-amber-300" aria-hidden />
            {t("problemsTitle", { count: single.length + (layoutCount > 0 ? 1 : 0) })}
          </h3>
          <ul className="space-y-1.5">
            {single.map((issue, i) => (
              <li key={`${issue.code}-${issue.detail ?? ""}-${issue.role ?? ""}-${i}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-foreground">{problemNamespace(issue.code) === "Sign.progress" ? <FormProblemText issue={issue} roleLabel={roles.find((r) => r.key === issue.role)?.label ?? issue.role ?? ""} /> : problemText(issue)}</span>
                <Button type="button" variant="outline" size="xs" onClick={() => onGoToStep(problemStep(issue.code))}>
                  {t(`fix.${problemStep(issue.code)}`)}
                </Button>
              </li>
            ))}
            {layoutCount > 0 ? (
              <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-foreground">{t("layoutProblems", { count: layoutCount })}</span>
                <Button type="button" variant="outline" size="xs" onClick={() => onGoToStep("fields")}>
                  {t("fix.fields")}
                </Button>
              </li>
            ) : null}
          </ul>
        </section>
      ) : (
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300" role="status">
          <CheckCircle2 className="size-4" aria-hidden />
          {t("ready")}
        </p>
      )}

      {sendErrorCode ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{tProblems(errorKey(sendErrorCode))}</p>
        </div>
      ) : null}

      <div className="flex flex-col items-end gap-1.5">
        <Button type="button" size="lg" disabled={!canSend || blocked || checking || sending} onClick={onSend}>
          {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          {t(mode === "form" ? "sendForm" : "send")}
        </Button>
        {!canSend ? <p className="text-xs text-muted-foreground">{t("noPermission")}</p> : blocked && !checking ? <p className="text-xs text-muted-foreground">{t("sendBlocked")}</p> : <p className="text-xs text-muted-foreground">{t(mode === "form" ? "sendNoteForm" : "sendNote")}</p>}
      </div>
    </div>
  );
}
