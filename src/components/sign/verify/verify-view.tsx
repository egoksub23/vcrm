"use client";

// ============================================================
// Doc Sign, verify page: what a person sees after scanning the code on a certificate. The facts about the
// signed document, then a check of the copy they hold: they pick the PDF, its fingerprint is worked out in
// their own browser (nothing is uploaded) and compared with the signed original's. Plain words, no jargon;
// a phone is the usual screen.
// ============================================================

import { useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, FileCheck2, FileX, Loader2, ShieldAlert, ShieldCheck, UploadCloud } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { buttonVariants } from "@/components/ui/button";
import { compareFingerprints, HashUnavailableError, sha256OfFile, type CopyCheck } from "@/lib/sign/client/file-hash";
import type { VerifyView } from "@/lib/sign/service/verify";
import { cn } from "@/lib/utils";

import { formatDay, useBrowserTimeZone } from "../signer/dates";

/** "6 Oct 2026, 4:30 pm" in the language and the browser's time zone. */
function formatInstant(iso: string | null, locale: string, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
  }
}

export function VerifyApp({ view }: { view: VerifyView }) {
  const t = useTranslations("Sign.verify");
  const locale = useLocale();
  const timeZone = useBrowserTimeZone();
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col items-center gap-3 text-center" aria-labelledby="verify-title">
        <CheckCircle2 className="size-12 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <h1 id="verify-title" className="text-2xl font-semibold leading-snug">
          {t("signedTitle")}
        </h1>
        <p className="text-lg font-medium break-words">{view.title}</p>
        <p className="text-sm text-muted-foreground">
          {t("completedOn", { date: formatDay(view.completedAt, locale, timeZone) })}
          {view.pageCount ? ` · ${t("pages", { count: view.pageCount })}` : ""}
          {view.reference ? ` · ${t("reference", { reference: view.reference })}` : ""}
        </p>
      </section>

      <Card title={t("signers.title")}>
        {view.signers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("signers.none")}</p>
        ) : (
          <ul className="divide-y">
            {view.signers.map((s, i) => (
              <li key={`${s.name}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0">
                <span className="font-medium break-words">{s.name}</span>
                <span className="text-sm text-muted-foreground">{formatInstant(s.signedAt, locale, timeZone)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Trail state={view.chain} events={view.events} />

      <CheckCopy sha256={view.sha256} />

      <p className="text-center text-xs text-muted-foreground">{t("readerHint")}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Trail({ state, events }: { state: VerifyView["chain"]; events: number | null }) {
  const t = useTranslations("Sign.verify.trail");
  if (state === "intact") {
    return (
      <div className="flex gap-3 rounded-xl border border-emerald-600/30 bg-emerald-600/5 p-4" role="status">
        <ShieldCheck className="mt-0.5 size-6 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <div>
          <p className="font-medium">{t("intactTitle")}</p>
          <p className="text-sm text-muted-foreground">{events === null ? t("intactBody") : t("intactBodyCount", { count: events })}</p>
        </div>
      </div>
    );
  }
  if (state === "broken") {
    return (
      <div className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4" role="alert">
        <ShieldAlert className="mt-0.5 size-6 shrink-0 text-destructive" aria-hidden />
        <div>
          <p className="font-medium">{t("brokenTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("brokenBody")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3 rounded-xl border bg-card p-4" role="status">
      <ShieldAlert className="mt-0.5 size-6 shrink-0 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{t("unknownTitle")}</p>
        <p className="text-sm text-muted-foreground">{t("unknownBody")}</p>
      </div>
    </div>
  );
}

type CopyState = { kind: "idle" } | { kind: "checking" } | { kind: "error"; why: "read" | "unsupported" } | { kind: "done"; result: CopyCheck; fileName: string };

function CheckCopy({ sha256 }: { sha256: string }) {
  const t = useTranslations("Sign.verify.check");
  const [state, setState] = useState<CopyState>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  async function onPick(file: File | undefined) {
    if (!file) return;
    setState({ kind: "checking" });
    try {
      const held = await sha256OfFile(file);
      setState({ kind: "done", result: compareFingerprints(held, sha256), fileName: file.name });
    } catch (err) {
      setState({ kind: "error", why: err instanceof HashUnavailableError ? "unsupported" : "read" });
    }
  }

  return (
    <Card title={t("title")}>
      <p id={hintId} className="mb-3 text-sm text-muted-foreground">
        {t("intro")}
      </p>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        aria-describedby={hintId}
        tabIndex={-1}
        onChange={(e) => {
          void onPick(e.target.files?.[0]);
          e.target.value = ""; // choosing the same file again checks it again
        }}
      />
      <button type="button" onClick={() => input.current?.click()} disabled={state.kind === "checking"} className={cn(buttonVariants({ variant: "outline" }), "h-12 w-full gap-2 px-5 text-base")}>
        {state.kind === "checking" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <UploadCloud className="size-5" aria-hidden />}
        {state.kind === "checking" ? t("checking") : t("choose")}
      </button>

      <div className="mt-3" aria-live="polite">
        {state.kind === "done" && state.result === "match" ? (
          <div className="flex gap-3 rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3">
            <FileCheck2 className="mt-0.5 size-6 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">{t("matchTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("matchBody")}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">{state.fileName}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "done" && state.result === "different" ? (
          <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3" role="alert">
            <FileX className="mt-0.5 size-6 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">{t("differentTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("differentBody")}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">{state.fileName}</p>
            </div>
          </div>
        ) : null}
        {state.kind === "error" ? (
          <p className="text-sm text-destructive" role="alert">
            {state.why === "unsupported" ? t("unsupported") : t("readError")}
          </p>
        ) : null}
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t("fingerprint")}</summary>
        <p className="mt-2 break-all font-mono text-xs">{sha256}</p>
      </details>
    </Card>
  );
}
