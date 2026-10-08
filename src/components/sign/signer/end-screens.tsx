"use client";

// ============================================================
// Doc Sign, signing page: the screens where nothing more can be done. Full page, calm and plain, each
// saying what happened and what, if anything, comes next. None says anything about the workspace's other
// documents, and none shows another person's details beyond the names and states of the people on this
// one document.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Archive, Award, Ban, CalendarX, CheckCircle2, Clock, Download, ExternalLink, FileX, Loader2, RefreshCw, UserX } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { signerFileUrl } from "@/lib/sign/client/api";
import { describeOthers, othersStillToSign, waitingOnNames, type OtherKind } from "@/lib/sign/client/signer-flow";
import type { SigningView } from "@/lib/sign/service/signing";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { formatDay, useBrowserTimeZone } from "./dates";

type EndState = "signed" | "sealing" | "completed" | "declined" | "expired" | "voided" | "failed" | "not_invited";

interface EndScreenProps {
  state: EndState;
  view: SigningView;
  token: string;
  /** The person has the code's session (or no code is needed): the signed copy may be fetched. */
  canDownload: boolean;
}

/** "Ali, Siti and Lim" in the reader's language. */
function joinNames(names: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { type: "conjunction", style: "long" }).format(names);
  } catch {
    return names.join(", ");
  }
}

export function EndScreen({ state, view, token, canDownload }: EndScreenProps) {
  const t = useTranslations("Sign.signer");
  const tf = useTranslations("Sign.signerForm");
  const locale = useLocale();
  // a form without a signature (migration 169): nothing was signed, the details were submitted
  const formOnly = view.document.mode === "form";

  switch (state) {
    case "signed": {
      const others = view.content?.others ?? [];
      const waiting = othersStillToSign(others) > 0;
      // the names of the people it waits for, when they have been invited (several when they share a step)
      const waitingList = waitingOnNames(others);
      const waitingNames = joinNames(waitingList, locale);
      if (formOnly) {
        return (
          <Frame icon={<CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={tf("end.submitted.title")}>
            <p>{tf("end.submitted.thanks", { name: view.signer.name })}</p>
            <p>{waiting ? tf("end.submitted.waiting") : tf("end.submitted.next")}</p>
            {others.length > 0 ? <OthersList view={view} /> : null}
          </Frame>
        );
      }
      // a person who only fills in has not signed anything: they have sent their answers
      if (view.signer.kind === "filler") {
        return (
          <Frame icon={<CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={tf("end.filler.title")}>
            <p>{tf("end.filler.thanks", { name: view.signer.name })}</p>
            <p>{tf("end.filler.next")}</p>
            {others.length > 0 ? <OthersList view={view} /> : null}
          </Frame>
        );
      }
      return (
        <Frame icon={<CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={t("end.signed.title")}>
          <p>{t("end.signed.thanks", { name: view.signer.name })}</p>
          <p>{waiting ? (waitingNames ? t("end.signed.waitingFor", { count: waitingList.length, name: waitingNames }) : t("end.signed.waiting")) : t("end.signed.almost")}</p>
          {others.length > 0 ? <OthersList view={view} /> : null}
        </Frame>
      );
    }
    case "sealing":
      return <Sealing formOnly={formOnly} />;
    case "completed":
      return (
        <Frame icon={<CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={formOnly ? t("end.completedForm.title") : t("end.completed.title")}>
          <p>{formOnly ? t("end.completedForm.body") : t("end.completed.body")}</p>
          {/* migration 181: the document was cancelled after it was completed. Only the fact and the date, never why or by whom; the downloads below stay. */}
          {view.document.cancelledAt ? <CancelledNotice at={view.document.cancelledAt} formOnly={formOnly} /> : null}
          {view.delegate ? (
            // a person handed one part of the form does not get the whole document
            <p className="text-sm text-muted-foreground">{t("end.completed.delegate")}</p>
          ) : canDownload ? (
            <div className="flex w-full flex-col gap-2 pt-2 sm:flex-row sm:flex-wrap sm:justify-center">
              <a href={signerFileUrl(token, true)} className={cn(buttonVariants(), "h-12 px-5 text-base")}>
                <Download className="size-4" aria-hidden />
                {/* a certificate of its own (migration 178) makes this "the signed document" beside "Certificate"; an older document has one file with both in it */}
                {view.document.hasCertificate ? (formOnly ? t("end.completed.record") : t("end.completed.signedDocument")) : formOnly ? t("end.completedForm.download") : t("end.completed.download")}
              </a>
              {view.document.hasCertificate ? (
                <>
                  <a href={signerFileUrl(token, true, "certificate")} className={cn(buttonVariants({ variant: "outline" }), "h-12 px-5 text-base")}>
                    <Award className="size-4" aria-hidden />
                    {t("end.completed.certificate")}
                  </a>
                  <a href={signerFileUrl(token, true, "zip")} className={cn(buttonVariants({ variant: "outline" }), "h-12 px-5 text-base")}>
                    <Archive className="size-4" aria-hidden />
                    {t("end.completed.downloadAll")}
                  </a>
                </>
              ) : null}
              <a href={signerFileUrl(token)} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "outline" }), "h-12 px-5 text-base")}>
                <ExternalLink className="size-4" aria-hidden />
                {formOnly ? t("end.completedForm.view") : t("end.completed.view")}
              </a>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{formOnly ? t("end.completedForm.byEmail") : t("end.completed.byEmail")}</p>
          )}
        </Frame>
      );
    case "declined":
      if (formOnly) {
        return (
          <Frame icon={<UserX className="size-12 text-muted-foreground" aria-hidden />} title={t("end.declinedForm.title")}>
            <p>{view.signer.status === "declined" ? t("end.declinedForm.you") : t("end.declinedForm.other")}</p>
          </Frame>
        );
      }
      return (
        <Frame icon={<UserX className="size-12 text-muted-foreground" aria-hidden />} title={t("end.declined.title")}>
          <p>{view.signer.status === "declined" ? t("end.declined.you") : t("end.declined.other")}</p>
        </Frame>
      );
    case "expired":
      return (
        <Frame icon={<CalendarX className="size-12 text-muted-foreground" aria-hidden />} title={t("end.expired.title")}>
          <p>{t("end.expired.body", { workspace: view.workspace.name })}</p>
        </Frame>
      );
    case "voided":
      return (
        <Frame icon={<Ban className="size-12 text-muted-foreground" aria-hidden />} title={t("end.voided.title")}>
          <p>{t("end.voided.body")}</p>
        </Frame>
      );
    case "failed":
      return (
        <Frame icon={<AlertTriangle className="size-12 text-amber-600 dark:text-amber-400" aria-hidden />} title={t("end.failed.title")}>
          <p>{t("end.failed.body")}</p>
        </Frame>
      );
    case "not_invited":
      return (
        <Frame icon={<Clock className="size-12 text-muted-foreground" aria-hidden />} title={formOnly ? t("end.notInvitedForm.title") : t("end.notInvited.title")}>
          <p>{formOnly ? t("end.notInvitedForm.body") : t("end.notInvited.body")}</p>
        </Frame>
      );
  }
}

/** The calm notice on a completed document that was cancelled afterwards: when, and that the signed copy remains a record. No reason, no name. */
export function CancelledNotice({ at, formOnly, collection }: { at: string; formOnly?: boolean; collection?: boolean }) {
  const t = useTranslations("Sign.signer");
  const locale = useLocale();
  const zone = useBrowserTimeZone();
  return (
    <div role="note" className="flex w-full items-start gap-2 rounded-xl border border-[color:light-dark(#fca5a5,#7f1d1d)] bg-[color:light-dark(#fef2f2,#450a0a66)] p-3 text-left text-sm text-foreground">
      <Ban className="mt-0.5 size-4 shrink-0 text-[light-dark(#b91c1c,#fca5a5)]" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium break-words">{t(collection ? "end.cancelled.titleCollection" : "end.cancelled.title", { date: formatDay(at, locale, zone) })}</p>
        <p className="mt-0.5 text-muted-foreground break-words">{t(formOnly ? "end.cancelled.noteForm" : "end.cancelled.note")}</p>
      </div>
    </div>
  );
}

/** The whole turn was handed to someone else: this page says so, and that the link no longer works. */
export function ForwardedScreen({ to, delivered }: { to: string; delivered: boolean }) {
  const t = useTranslations("Sign.signer");
  return (
    <Frame icon={<CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={t("forward.doneTitle")}>
      <p>{t("forward.doneBody", { name: to })}</p>
      {delivered ? null : <p className="text-sm">{t("forward.doneNotSent", { name: to })}</p>}
    </Frame>
  );
}

/** A link that is not valid says nothing about whether a document exists. `busy`: too many requests from this address, try again soon. */
export function InvalidLink({ busy }: { busy?: boolean }) {
  const t = useTranslations("Sign.signer");
  if (busy) {
    return (
      <Frame icon={<Clock className="size-12 text-muted-foreground" aria-hidden />} title={t("busy.title")}>
        <p>{t("busy.body")}</p>
        <button type="button" onClick={() => window.location.reload()} className={cn(buttonVariants({ variant: "outline" }), "h-11 px-5 text-base")}>
          {t("common.tryAgain")}
        </button>
      </Frame>
    );
  }
  return (
    <Frame icon={<FileX className="size-12 text-muted-foreground" aria-hidden />} title={t("invalid.title")}>
      <p>{t("invalid.body")}</p>
    </Frame>
  );
}

function Frame({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center" aria-labelledby="end-title">
      {icon}
      <h1 id="end-title" className="text-2xl font-semibold leading-snug">
        {title}
      </h1>
      <div className="space-y-3 text-base text-muted-foreground [&>p]:leading-relaxed">{children}</div>
    </section>
  );
}

/** How long a signed copy is waited for before the page says it is slow, and before it stops showing a spinner and says it will email instead. */
export const SEALING_SLOW_AFTER_MS = 120_000;
export const SEALING_STUCK_AFTER_MS = 600_000;

export type SealingPhase = "waiting" | "slow" | "stuck";

/** What the page says of the wait for the signed copy, by how long it has been: nothing yet, "longer than usual", then "longer than expected, we will email you". */
export function sealingPhase(elapsedMs: number): SealingPhase {
  return elapsedMs >= SEALING_STUCK_AFTER_MS ? "stuck" : elapsedMs >= SEALING_SLOW_AFTER_MS ? "slow" : "waiting";
}

/** The phase of the wait, moving on by itself from when the page began waiting. */
export function useSealingPhase(): SealingPhase {
  const [phase, setPhase] = useState<SealingPhase>("waiting");
  useEffect(() => {
    const slow = setTimeout(() => setPhase("slow"), SEALING_SLOW_AFTER_MS);
    const stuck = setTimeout(() => setPhase("stuck"), SEALING_STUCK_AFTER_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(stuck);
    };
  }, []);
  return phase;
}

/** The icon of the wait: a spinner while it is normal, a still clock once it is slow enough that a spinner would only look like a frozen page. */
export function SealingIcon({ phase }: { phase: SealingPhase }) {
  return phase === "stuck" ? <Clock className="size-12 text-muted-foreground" aria-hidden /> : <Loader2 className="size-12 text-primary motion-safe:animate-spin" aria-hidden />;
}

/** "Check again": the page asks the server now rather than at its next turn. */
export function CheckAgain() {
  const t = useTranslations("Sign.signer");
  return (
    <button type="button" onClick={() => window.location.reload()} className={cn(buttonVariants({ variant: "outline" }), "h-11 px-5 text-base")}>
      <RefreshCw className="size-4" aria-hidden />
      {t("end.sealing.check")}
    </button>
  );
}

/** The document is being sealed: the page asks again by itself (use-signer) and says so; after two minutes it says it is slow, after ten it says it will email. */
export function SealingNotice({ phase, formOnly }: { phase: SealingPhase; formOnly?: boolean }) {
  const t = useTranslations("Sign.signer");
  return (
    <Frame icon={<SealingIcon phase={phase} />} title={formOnly ? t("end.sealingForm.title") : t("end.sealing.title")}>
      <div aria-live="polite" className="space-y-3">
        <p>{formOnly ? t("end.sealingForm.body") : t("end.sealing.body")}</p>
        {phase === "slow" ? <p className="text-sm">{formOnly ? t("end.sealingForm.slow") : t("end.sealing.slow")}</p> : null}
        {phase === "stuck" ? <p className="text-sm">{formOnly ? t("end.sealingForm.stuck") : t("end.sealing.stuck")}</p> : null}
      </div>
      {phase === "stuck" ? <CheckAgain /> : null}
    </Frame>
  );
}

function Sealing({ formOnly }: { formOnly?: boolean }) {
  return <SealingNotice phase={useSealingPhase()} formOnly={formOnly} />;
}

const KIND_STYLE: Record<OtherKind, string> = {
  signed: "text-emerald-700 dark:text-emerald-400",
  declined: "text-red-700 dark:text-red-400",
  turn: "text-foreground font-medium",
  invited: "text-muted-foreground",
  waiting: "text-muted-foreground",
};

/** Who else is on this document and where they stand. */
function OthersList({ view }: { view: SigningView }) {
  const t = useTranslations("Sign.signer");
  const locale = useLocale();
  const zone = useBrowserTimeZone();
  const formOnly = view.document.mode === "form";
  const rows = describeOthers(view.content?.others ?? [], view.document.signInOrder);

  return (
    <div className="w-full rounded-xl border bg-card p-3 text-left text-foreground">
      <h2 className="px-1 pb-2 text-sm font-semibold">{formOnly ? t("others.titleForm") : t("others.title")}</h2>
      <ul className="divide-y">
        {rows.map((row, i) => {
          const day = row.kind === "signed" ? formatDay(row.signedAt, locale, zone) : "";
          const label = row.kind === "signed" && row.filler ? t("others.done") : formOnly && row.kind === "invited" ? t("others.invitedForm") : t(`others.${row.kind}`);
          return (
            <li key={`${row.name}-${i}`} className="flex min-h-11 items-center justify-between gap-3 px-1 py-2 text-sm">
              <span className="min-w-0 break-words">{row.name}</span>
              <span className={cn("shrink-0 text-right", KIND_STYLE[row.kind])}>
                {label}
                {day ? <span className="block text-xs font-normal text-muted-foreground">{day}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
