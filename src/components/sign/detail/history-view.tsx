"use client";

// ============================================================
// Doc Sign, the detail screen: the history of a document. Every line is a plain sentence in the reader's language,
// newest first by default, with who and when. The network address and device of what a signer did sit behind
// "Details". A message that did not arrive is flagged with a word. A badge shows the live check of the hash chain.
// ============================================================

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowDownUp, CircleAlert, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

import { useAccountMembers } from "@/hooks/use-account-members";
import { cn } from "@/lib/utils";
import { asLocale } from "@/lib/sign/client/progress-logic";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignSignerRow } from "@/lib/sign/types";

import { describeEvent, orderEvents, visibleDetails, type ChainState, type EventLine, type SignEventRow } from "./events";
import { formatDay, formatWhen } from "./format";

interface Props {
  events: SignEventRow[] | null;
  chain: ChainState | null;
  loading: boolean;
  failed: boolean;
  signers: readonly Pick<SignSignerRow, "id" | "full_name" | "order_no">[];
  signInOrder: boolean;
  /** May see technical notes (sign.settings). */
  technical: boolean;
  /** Forms: the document's form, so a line can name the part or the answer it is about. */
  form?: FormDefinition | null;
  /** The document's contact: a write-back line links to it. */
  contactId?: string | null;
}

export function HistoryView({ events, chain, loading, failed, signers, signInOrder, technical, form, contactId }: Props) {
  const t = useTranslations("Sign.detail");
  const locale = useLocale();
  const { nameOf } = useAccountMembers();
  const [newestFirst, setNewestFirst] = useState(true);
  const [showMinor, setShowMinor] = useState(false);

  const lines = useMemo<EventLine[]>(() => {
    if (!events) return [];
    const ctx = {
      signers,
      signInOrder,
      userName: (id: string | null) => (id ? nameOf(id) || null : null),
      someone: t("history.someone"),
      teammate: t("history.teammate"),
      partTitle: (key: string) => {
        const part = form?.parts.find((p) => p.key === key);
        return part ? pick(part.title, asLocale(locale)) || null : null;
      },
      fieldLabel: (key: string) => {
        const field = form?.fields.find((f) => f.key === key);
        return field ? pick(field.label, asLocale(locale)) || null : null;
      },
      formatDay: (iso: string) => formatDay(iso, locale) || iso.slice(0, 10),
      contactId,
    };
    return orderEvents(events, newestFirst).map((e) => describeEvent(e, ctx));
  }, [events, signers, signInOrder, nameOf, newestFirst, t, form, locale, contactId]);

  const shown = lines.filter((l) => showMinor || !l.minor);
  const hasMinor = lines.some((l) => l.minor);

  return (
    <section aria-labelledby="sign-history-title" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="sign-history-title" className="text-sm font-semibold text-foreground">
            {t("history.title")}
          </h2>
          <ChainBadge chain={chain} loading={loading} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {hasMinor && (
            <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" checked={showMinor} onChange={(e) => setShowMinor(e.target.checked)} className="size-3.5 accent-[var(--primary)]" />
              {t("history.showMinor")}
            </label>
          )}
          <button type="button" onClick={() => setNewestFirst((v) => !v)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <ArrowDownUp className="size-3.5" aria-hidden />
            {t(newestFirst ? "history.newestFirst" : "history.oldestFirst")}
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("history.loading")}
        </div>
      )}
      {failed && !loading && (
        <p className="py-6 text-sm text-destructive" role="alert">
          {t("history.failed")}
        </p>
      )}
      {!loading && !failed && shown.length === 0 && <p className="py-6 text-sm text-muted-foreground">{t("history.empty")}</p>}

      {shown.length > 0 && (
        <ol className="rounded-xl border border-border bg-card">
          {shown.map((line) => (
            <HistoryItem key={line.id} line={line} locale={locale} technical={technical} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ChainBadge({ chain, loading }: { chain: ChainState | null; loading: boolean }) {
  const t = useTranslations("Sign.detail");
  if (loading || chain === null) {
    return (
      <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {t("history.chain.checking")}
      </span>
    );
  }
  if (chain.state === "intact") {
    return (
      <span title={t("history.chain.intactHint")} className="inline-flex h-5 items-center gap-1 rounded-full bg-emerald-500/15 px-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <ShieldCheck className="size-3" aria-hidden />
        {t("history.chain.intact")}
      </span>
    );
  }
  if (chain.state === "broken") {
    return (
      <span role="alert" title={t("history.chain.brokenHint")} className="inline-flex h-5 items-center gap-1 rounded-full bg-red-500/15 px-2 text-xs font-medium text-red-700 dark:text-red-300">
        <ShieldAlert className="size-3" aria-hidden />
        {chain.at !== null ? t("history.chain.brokenAt", { number: chain.at }) : t("history.chain.broken")}
      </span>
    );
  }
  return (
    <span title={t("history.chain.unknownHint")} className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground">
      <ShieldQuestion className="size-3" aria-hidden />
      {t("history.chain.unknown")}
    </span>
  );
}

/** The sentence of an event of a form (its words are in `Sign.progress`). Only what changed is said, never an old or new value. */
function FormEventText({ line }: { line: EventLine }) {
  const t = useTranslations("Sign.progress");
  const values = { ...line.values };
  if (line.contactFields.length > 0) {
    // "name" and "email" read in the reader's language; a custom field reads as its own name
    const word = (f: string) => (f === "name" || f === "email" || f === "company" ? t(`contactFields.${f}`) : f.startsWith("custom:") ? f.slice(7) : f);
    values.fields = line.contactFields.map(word).join(", ");
  }
  return (
    <>
      {t(line.key, values)}
      {line.link && (
        <>
          {" "}
          <Link href={`/contacts?contact=${line.link.id}`} className="text-primary hover:underline">
            {t("openContact")}
          </Link>
        </>
      )}
    </>
  );
}

function HistoryItem({ line, locale, technical }: { line: EventLine; locale: string; technical: boolean }) {
  const t = useTranslations("Sign.detail");
  const details = visibleDetails(line, technical);
  return (
    <li className="grid gap-1 border-b border-border px-4 py-3 last:border-b-0">
      <p className={cn("flex items-start gap-2 text-sm text-foreground", line.minor && "text-muted-foreground")}>
        {line.failed && <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
        <span className="min-w-0 break-words">
          {line.ns === "progress" ? <FormEventText line={line} /> : t(line.key, line.values)}
          {line.failed && <span className="ml-2 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">{t("history.problem")}</span>}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        {formatWhen(line.at, locale)}
        {line.actorName ? ` · ${line.actorName}` : ""}
        {line.actorType === "system" ? ` · ${t("history.bySystem")}` : ""}
      </p>
      {line.reason && <p className="text-xs text-foreground break-words">{t("history.reason", { reason: line.reason })}</p>}
      {details.length > 0 && (
        <details className="group text-xs">
          <summary className="inline-flex cursor-pointer list-none items-center rounded-md px-1 py-0.5 text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">{t("history.details")}</summary>
          <dl className="mt-1 grid gap-1 rounded-lg bg-muted/50 p-2">
            {details.map((d, i) => (
              <div key={`${d.kind}-${i}`} className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">{t(`history.detail.${d.kind}`)}</dt>
                <dd className="min-w-0 break-all text-foreground">{d.kind === "channel" ? t(`channel.${d.value === "whatsapp" ? "whatsapp" : "email"}`) : d.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </li>
  );
}
