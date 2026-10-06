"use client";

// ============================================================
// Doc Sign, signing page: the screens where nothing more can be done. Full page, calm and plain, each
// saying what happened and what, if anything, comes next. None says anything about the workspace's other
// documents, and none shows another person's details beyond the names and states of the people on this
// one document.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Ban, CalendarX, CheckCircle2, Clock, Download, ExternalLink, FileX, Loader2, UserX } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { signerFileUrl } from "@/lib/sign/client/api";
import { describeOthers, othersStillToSign, type OtherKind } from "@/lib/sign/client/signer-flow";
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

export function EndScreen({ state, view, token, canDownload }: EndScreenProps) {
  const t = useTranslations("Sign.signer");
  const tf = useTranslations("Sign.signerForm");

  switch (state) {
    case "signed": {
      const others = view.content?.others ?? [];
      const waiting = othersStillToSign(others) > 0;
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
          <p>{waiting ? t("end.signed.waiting") : t("end.signed.almost")}</p>
          {others.length > 0 ? <OthersList view={view} /> : null}
        </Frame>
      );
    }
    case "sealing":
      return <Sealing />;
    case "completed":
      return (
        <Frame icon={<CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />} title={t("end.completed.title")}>
          <p>{t("end.completed.body")}</p>
          {canDownload ? (
            <div className="flex w-full flex-col gap-2 pt-2 sm:flex-row sm:justify-center">
              <a href={signerFileUrl(token, true)} className={cn(buttonVariants(), "h-12 px-5 text-base")}>
                <Download className="size-4" aria-hidden />
                {t("end.completed.download")}
              </a>
              <a href={signerFileUrl(token)} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "outline" }), "h-12 px-5 text-base")}>
                <ExternalLink className="size-4" aria-hidden />
                {t("end.completed.view")}
              </a>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("end.completed.byEmail")}</p>
          )}
        </Frame>
      );
    case "declined":
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
        <Frame icon={<Clock className="size-12 text-muted-foreground" aria-hidden />} title={t("end.notInvited.title")}>
          <p>{t("end.notInvited.body")}</p>
        </Frame>
      );
  }
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

/** The document is being sealed: the page asks again by itself (use-signer) and says so; after two minutes it says it is slow. */
function Sealing() {
  const t = useTranslations("Sign.signer");
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 120_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Frame icon={<Loader2 className="size-12 text-primary motion-safe:animate-spin" aria-hidden />} title={t("end.sealing.title")}>
      <div aria-live="polite" className="space-y-3">
        <p>{t("end.sealing.body")}</p>
        {slow ? <p className="text-sm">{t("end.sealing.slow")}</p> : null}
      </div>
    </Frame>
  );
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
  const rows = describeOthers(view.content?.others ?? [], view.document.signInOrder);

  return (
    <div className="w-full rounded-xl border bg-card p-3 text-left text-foreground">
      <h2 className="px-1 pb-2 text-sm font-semibold">{t("others.title")}</h2>
      <ul className="divide-y">
        {rows.map((row, i) => {
          const day = row.kind === "signed" ? formatDay(row.signedAt, locale, zone) : "";
          const label = row.kind === "signed" && row.filler ? t("others.done") : t(`others.${row.kind}`);
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
