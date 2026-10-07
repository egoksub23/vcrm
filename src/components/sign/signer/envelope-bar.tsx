"use client";

// ============================================================
// Doc Sign, signing page, ENVELOPES (migration 171): what is shown around the documents of one person's sitting. The list of the
// documents with the person's state on each ("Document 2 of 3: Fee schedule"), the introduction before they agree, and the screen at the
// end. The documents themselves are the ordinary screens (the fields on the page, the form in parts, the review): this only frames them.
// ============================================================

import { CheckCircle2, Circle, Clock, Download, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { buttonVariants } from "@/components/ui/button";
import { signerFileUrl } from "@/lib/sign/client/api";
import { scopeOf, splitScope } from "@/lib/sign/client/scope";
import type { EnvelopeView, PageState } from "@/lib/sign/service/signing";
import { cn } from "@/lib/utils";

import { CheckAgain, SealingIcon, useSealingPhase } from "./end-screens";

const STATE_ICON: Record<PageState, typeof Circle> = {
  active: Circle,
  signed: CheckCircle2,
  sealing: Clock,
  completed: CheckCircle2,
  declined: XCircle,
  expired: XCircle,
  voided: XCircle,
  failed: XCircle,
  not_invited: Clock,
};

const STATE_TONE: Record<PageState, string> = {
  active: "text-amber-700 dark:text-amber-300",
  signed: "text-emerald-700 dark:text-emerald-300",
  sealing: "text-muted-foreground",
  completed: "text-emerald-700 dark:text-emerald-300",
  declined: "text-red-700 dark:text-red-300",
  expired: "text-red-700 dark:text-red-300",
  voided: "text-muted-foreground",
  failed: "text-red-700 dark:text-red-300",
  not_invited: "text-muted-foreground",
};

/** One document's line: its place, its title and the person's state on it, in words as well as an icon. */
function StateWord({ state }: { state: PageState }) {
  const t = useTranslations("Sign.signer");
  const Icon = STATE_ICON[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", STATE_TONE[state])}>
      <Icon className="size-3.5" aria-hidden />
      {t(`envelope.state.${state}`)}
    </span>
  );
}

interface BarProps {
  envelope: EnvelopeView;
  /** Open one of the documents still to do (the work on this one is saved first). */
  onGo: (documentId: string) => void;
}

/**
 * Above the document the person is working on: "Document 2 of 3: Fee schedule", the list of the documents with their states (the ones still
 * to do can be opened in any order), and one sentence saying nothing is final until the last is finished.
 */
export function EnvelopeBar({ envelope, onGo }: BarProps) {
  const t = useTranslations("Sign.signer");
  const index = Math.max(0, envelope.documents.findIndex((d) => d.id === envelope.current));
  const here = envelope.documents[index];
  return (
    <section className="mx-auto w-full max-w-6xl space-y-2 px-3 pt-3" aria-label={t("envelope.listLabel")}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("envelope.position", { number: index + 1, count: envelope.count })}
        {envelope.reference ? ` · ${envelope.reference}` : ""}
      </p>
      <p className="break-words text-sm font-semibold">{here ? here.title : envelope.title}</p>
      <ol className="flex flex-wrap gap-2">
        {envelope.documents.map((d, i) => {
          const current = d.id === envelope.current;
          const open = d.state === "active" && !current;
          const body = (
            <>
              <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
              <span className="min-w-0 truncate">{d.title}</span>
              <StateWord state={d.state} />
            </>
          );
          const base = "inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border px-3 text-sm";
          return (
            <li key={d.id} className="max-w-full">
              {open ? (
                <button type="button" className={cn(base, "bg-background outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50")} onClick={() => onGo(d.id)} aria-label={t("envelope.open", { title: d.title })}>
                  {body}
                </button>
              ) : (
                <span className={cn(base, current ? "border-primary bg-primary/5 font-medium" : "bg-muted/40")} aria-current={current ? "step" : undefined}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{t("envelope.notFinal")}</p>
    </section>
  );
}

/** In place of the document's own heading before the person agrees: the envelope, how many documents, and what happens next. */
export function EnvelopeIntro({ envelope, fill }: { envelope: EnvelopeView; fill?: boolean }) {
  const t = useTranslations("Sign.signer");
  return (
    <div className="space-y-2">
      <h1 className="break-words text-xl font-semibold leading-snug">{envelope.title}</h1>
      {envelope.reference ? <p className="text-sm text-muted-foreground">{envelope.reference}</p> : null}
      <p className="text-base font-medium">{t(fill ? "envelope.introTitleFill" : "envelope.introTitle", { count: envelope.count })}</p>
      <p className="text-sm text-muted-foreground">{t("envelope.introBody")}</p>
      {envelope.documents.length > 0 ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {envelope.documents.map((d) => (
            <li key={d.id} className="break-words">
              {d.title}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

interface EndProps {
  envelope: EnvelopeView;
  /** The page's scope (the link's token, with a document): the files are fetched with the link's own token. */
  scope: string;
  name: string;
  /** The person has the code's session (or no code is needed): the signed copies may be fetched. */
  canDownload: boolean;
}

/** The sitting is over for this person: they signed everything (waiting for the others), or every document is complete and can be downloaded. */
export function EnvelopeEnd({ envelope, scope, name, canDownload }: EndProps) {
  const t = useTranslations("Sign.signer");
  const token = splitScope(scope).token;
  const done = envelope.state === "completed";
  // every document of the person is being sealed or complete (nobody has anything left to sign): the wait is for the signed copies
  const sealing = envelope.state === "sealing";
  const phase = useSealingPhase();
  return (
    <div className="flex flex-col items-center gap-4 px-3 py-10 text-center" role="status">
      {sealing ? <SealingIcon phase={phase} /> : <CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />}
      <h1 className="text-2xl font-semibold leading-snug">{done ? t("envelope.end.completed.title", { count: envelope.count }) : sealing ? t("envelope.end.sealing.title", { count: envelope.count }) : t("envelope.end.signed.title", { count: envelope.count })}</h1>
      <p className="max-w-prose text-base">{done ? t("envelope.end.completed.body") : sealing ? t("envelope.end.sealing.body") : t("envelope.end.signed.body", { name })}</p>
      {done || sealing ? null : <p className="max-w-prose text-sm text-muted-foreground">{t("envelope.end.signed.waiting")}</p>}
      {sealing && phase === "slow" ? <p className="max-w-prose text-sm text-muted-foreground">{t("envelope.end.sealing.slow")}</p> : null}
      {sealing && phase === "stuck" ? (
        <>
          <p className="max-w-prose text-sm text-muted-foreground">{t("envelope.end.sealing.stuck")}</p>
          <CheckAgain />
        </>
      ) : null}
      <ol className="w-full max-w-md space-y-2 text-left">
        {envelope.documents.map((d, i) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
            <span className="min-w-0 break-words text-sm">
              <span className="tabular-nums text-muted-foreground">{i + 1}.</span> {d.title}
            </span>
            {d.state === "completed" && canDownload ? (
              <a href={signerFileUrl(scopeOf(token, d.id), true)} className={cn(buttonVariants({ variant: "outline" }), "h-11 px-3 text-sm")} aria-label={t("envelope.end.download", { title: d.title })}>
                <Download className="size-4" aria-hidden />
                {t("envelope.end.downloadShort")}
              </a>
            ) : (
              <StateWord state={d.state} />
            )}
          </li>
        ))}
      </ol>
      {done && !canDownload ? <p className="text-sm text-muted-foreground">{t("envelope.end.completed.byEmail")}</p> : null}
    </div>
  );
}
