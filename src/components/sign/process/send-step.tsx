"use client";

// ============================================================
// Doc Sign, step 4 of the sending workflow: review and send. A plain summary (the documents, who signs what, who only receives a copy, when it
// expires), the options (language, message, expiry, reminders, the verification code, signing order), "Links (optional)" (the ticket, the deal and
// the contact), what is left (each with a button that goes to the right step or opens the right document), and Send. For a document on its own and
// for a collection.
// ============================================================

import { AlertCircle, CheckCircle2, Loader2, Send } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { SignCategory } from "@/hooks/use-sign-categories";
import type { SignIssue } from "@/lib/sign/client/api";
import { defaultExpiryDate, fromDateInput, parseReminderDays } from "@/lib/sign/client/draft-options";
import { errorKey } from "@/lib/sign/client/errors";
import { documentCover, problemTarget, type ProblemTarget, type ProcessHeadroom } from "@/lib/sign/client/process";
import { isCopy } from "@/lib/sign/envelopes";

import { FormReviewSummary } from "../send/form-review-summary";
import { OptionsStep } from "../send/options-step";
import { LinksSection } from "./links-section";
import { ProblemText, splitIssues } from "./problem-text";
import type { Process } from "./use-process";

interface Props {
  process: Process;
  categories: readonly SignCategory[];
  defaultExpiryDays: number;
  now: number;
  headroom: ProcessHeadroom | null;
  /** The sender may ask to see the document or collection (when it turns out it was sent already). */
  onOpen: () => void;
}

/** Where "Fix" goes: a step, and the document to open when it is in one. */
function useFixWords() {
  const t = useTranslations("Sign.process.send.fix");
  return (target: ProblemTarget): string => (target.step === "blocks" ? (target.documentId ? t("document") : t("blocks")) : target.step === "people" ? t("people") : target.step === "documents" ? t("documents") : t("options"));
}

export function SendStep({ process, categories, defaultExpiryDays, now, headroom, onOpen }: Props) {
  const t = useTranslations("Sign.process.send");
  const tr = useTranslations("Sign.send.review");
  const tc = useTranslations("Sign.send.copies");
  const tcount = useTranslations("Sign.process.summary");
  const tErr = useTranslations("Sign.send");
  const f = useFormatter();
  const fixWords = useFixWords();

  const { options, docs, people, problems } = process;
  const single = process.kind === "single";
  const form = process.formOnly;
  const covers = docs.map((d) => documentCover(d, people));
  const copies = people.filter(isCopy).filter((p) => p.fullName.trim() && p.email.trim());
  const nowDate = new Date(now);
  const expiryIso = options.expiryDate ? fromDateInput(options.expiryDate) : null;
  const expiry = expiryIso ? tr("expiresOn", { date: f.dateTime(new Date(expiryIso), { dateStyle: "long" }) }) : tr("expiresDefault", { days: defaultExpiryDays, date: f.dateTime(new Date(`${defaultExpiryDate(nowDate, defaultExpiryDays)}T12:00:00`), { dateStyle: "long" }) });
  const reminders = parseReminderDays(options.reminderText);
  const noRoom = headroom !== null && !headroom.fits;
  const blocked = problems.length > 0 || noRoom;
  const fixOptions = problems.some((p) => problemTarget(p).step === "send");

  const go = (issue: SignIssue) => {
    const target = problemTarget(issue);
    if (target.step === "send") {
      document.getElementById("process-options")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    void process.goStep(target.step, target.documentId);
  };

  // the problems by document, a document's layout problems as one line
  const groups: { documentId: string | null; issues: SignIssue[] }[] = [];
  for (const issue of problems) {
    const id = issue.document ?? null;
    const g = groups.find((x) => x.documentId === id);
    if (g) g.issues.push(issue);
    else groups.push({ documentId: id, issues: [issue] });
  }

  return (
    <div className="space-y-5" data-step-body="send">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("heading")}</h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      <section aria-labelledby="send-what" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div>
          <h3 id="send-what" className="text-base font-semibold text-foreground">
            {process.title || tr("untitled")}
          </h3>
          <p className="text-xs text-muted-foreground">{single ? t("countsSingle", { people: process.summary.counts.signers, copies: copies.length }) : t("countsCollection", { documents: docs.length, people: process.summary.counts.signers, copies: copies.length })}</p>
        </div>
        <p className="text-sm text-foreground">{options.signInOrder ? tr(form ? "orderedIntroForm" : "orderedIntro") : tr(form ? "allAtOnceForm" : "allAtOnce")}</p>

        <ul className="space-y-3" aria-label={t("whoSignsLabel")}>
          {covers.map((c) => (
            <li key={c.doc.id} className="space-y-1" data-summary-doc={c.doc.id}>
              <p className="text-sm font-medium text-foreground">{c.doc.title}</p>
              {c.people.filter((p) => p.covered).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("nobodyHere")}</p>
              ) : (
                <ul className="space-y-0.5 text-sm text-muted-foreground">
                  {c.people
                    .filter((p) => p.covered)
                    .map((p) => (
                      <li key={p.key}>
                        <span className="text-foreground">{p.name}</span> · {c.formOnly ? t("fillsIn") : tcount("blocks", { count: p.blocks })}
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ul>

        {copies.length > 0 ? (
          <p data-copy-review className="text-sm text-foreground">
            {tc("reviewLine", { people: copies.map((c) => `${c.fullName.trim()} (${c.email.trim()})`).join(", "), count: copies.length })}
          </p>
        ) : null}

        <dl className="grid gap-x-4 gap-y-1.5 border-t border-border pt-3 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted-foreground">{tr("expiryLabel")}</dt>
          <dd className="text-foreground">{expiry}</dd>
          <dt className="text-muted-foreground">{tr("remindersLabel")}</dt>
          <dd className="text-foreground">{reminders.length ? tr("remindersOn", { days: reminders.join(", "), count: reminders.length }) : tr("remindersOff")}</dd>
          <dt className="text-muted-foreground">{tr("codeLabel")}</dt>
          <dd className="text-foreground">{options.codeRequired ? tr(form ? "codeOnForm" : "codeOn") : tr("codeOff")}</dd>
          {single ? (
            <>
              <dt className="text-muted-foreground">{tr("forwardingLabel")}</dt>
              <dd className="text-foreground">{options.allowForwarding ? tr("forwardingOn") : tr("forwardingOff")}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{tr("languageLabel")}</dt>
          <dd className="text-foreground">{tErr(`options.lang.${options.locale}`)}</dd>
          {options.message.trim() ? (
            <>
              <dt className="text-muted-foreground">{tr("messageLabel")}</dt>
              <dd className="whitespace-pre-wrap text-foreground">{options.message.trim()}</dd>
            </>
          ) : null}
        </dl>
      </section>

      {process.form ? <FormReviewSummary form={process.form} roles={docs[0]?.roles ?? []} rows={process.formRows} contactId={options.contactId} /> : null}

      <section id="process-options" aria-labelledby="send-options" className="scroll-mt-4 space-y-3">
        <h3 id="send-options" className="text-sm font-semibold text-foreground">
          {t("optionsHeading")}
        </h3>
        <OptionsStep envelope={!single} hideLinks options={options} categories={categories} defaultExpiryDays={defaultExpiryDays} now={now} showInvalid readOnly={!process.canSend} onChange={process.changeOptions} />
      </section>

      <LinksSection options={options} readOnly={!process.canSend} onChange={process.changeOptions} />

      {noRoom && headroom ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-[light-dark(#92400e,#fcd34d)]" aria-hidden />
          <p>{t("limit", { needed: headroom.needed, remaining: headroom.remaining ?? 0 })}</p>
        </div>
      ) : null}

      {problems.length > 0 ? (
        <section aria-labelledby="send-problems" className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4" data-problems>
          <h3 id="send-problems" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <AlertCircle className="size-4 text-[light-dark(#92400e,#fcd34d)]" aria-hidden />
            {tr("problemsTitle", { count: problems.length })}
          </h3>
          {groups.map((g) => {
            const { lines, layoutCount } = splitIssues(g.issues);
            const doc = docs.find((d) => d.id === g.documentId);
            return (
              <div key={g.documentId ?? "process"} className="space-y-1">
                {doc && !single ? <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{doc.title}</p> : null}
                <ul className="space-y-1.5">
                  {lines.map((issue, i) => {
                    const target = problemTarget(issue);
                    return (
                      <li key={`${issue.code}-${issue.detail ?? ""}-${issue.role ?? ""}-${i}`} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-problem={issue.code}>
                        <span className="text-foreground">
                          <ProblemText issue={issue} docs={docs} people={people} />
                        </span>
                        <Button type="button" variant="outline" size="xs" disabled={process.moving} onClick={() => go(issue)}>
                          {fixWords(target)}
                        </Button>
                      </li>
                    );
                  })}
                  {layoutCount > 0 && g.documentId ? (
                    <li className="flex flex-wrap items-center justify-between gap-2 text-sm" data-problem="layout">
                      <span className="text-foreground">{tr("layoutProblems", { count: layoutCount })}</span>
                      <Button type="button" variant="outline" size="xs" disabled={process.moving} onClick={() => void process.goStep("blocks", g.documentId)}>
                        {fixWords({ step: "blocks", documentId: g.documentId })}
                      </Button>
                    </li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </section>
      ) : (
        <p className="flex items-center gap-2 text-sm text-[light-dark(#047857,#6ee7b7)]" role="status">
          <CheckCircle2 className="size-4" aria-hidden />
          {single ? tr("ready") : t("readyCollection")}
        </p>
      )}

      {process.sendErrorCode ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{tErr(errorKey(process.sendErrorCode))}</p>
        </div>
      ) : null}
      {process.sendErrorCode === "document_not_draft" || process.sendErrorCode === "envelope_not_draft" ? (
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onOpen}>
            {single ? t("openDocument") : t("openCollection")}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col items-end gap-1.5">
        <Button type="button" size="lg" disabled={!process.canSend || blocked || process.sending || process.moving} aria-describedby="send-why" data-send onClick={() => void process.send()}>
          {process.sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          {single ? tr(form ? "sendForm" : "send") : t("sendCollection", { count: docs.length })}
        </Button>
        <p id="send-why" className="text-xs text-muted-foreground">
          {!process.canSend ? tr("noPermission") : blocked ? t(fixOptions && problems.length === 1 ? "blockedOptions" : "blocked") : single ? tr(form ? "sendNoteForm" : "sendNote") : t("sendNoteCollection")}
        </p>
      </div>
    </div>
  );
}
