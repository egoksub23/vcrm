"use client";

// ============================================================
// Doc Sign forms, the sender's view of a document in progress: how far each person has got, the answers so far
// (read only), problems the server found, and two actions: Remind about unfinished parts and Extend expiry.
// Driven by props so it can be tested; `ProgressTab` feeds it from the route and polls.
// ============================================================

import { useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { CalendarClock, Loader2, TriangleAlert, UserCheck } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { SignApiError } from "@/lib/sign/client/api";
import { asLocale, canExtendExpiry, groupAnswers, issueViews, lastDeviceOf, overallStats, roleViews } from "@/lib/sign/client/progress-logic";
import type { StaffProgress } from "@/lib/sign/forms/api-types";
import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";

import { detailErrorKey, signerActions, type DetailCaps } from "../logic";
import { latestWriteback, type SignEventRow } from "../events";
import { formatWhen } from "../format";
import { SignerActionDialogs, useSignerActions } from "../signer-actions";
import { AnswersView } from "./answers-view";
import { ExtendExpiryDialog } from "./extend-expiry-dialog";
import { Bar, RoleProgressCard } from "./role-progress-card";

interface Props {
  document: SignDocumentRow;
  signers: SignSignerRow[];
  events: SignEventRow[] | null;
  caps: DetailCaps;
  progress: StaffProgress | null;
  loading: boolean;
  error: SignApiError | null;
  /** The time the screen treats as now (ms). */
  now: number;
  /** Read the document and the progress again after an action. */
  onChanged: () => Promise<void>;
  onRetry: () => void;
}

export function ProgressPanel({ document: doc, signers, events, caps, progress, loading, error, now, onChanged, onRetry }: Props) {
  const t = useTranslations("Sign.progress");
  const td = useTranslations("Sign.detail");
  const f = useFormatter();
  const locale = useLocale();
  const lang = asLocale(locale);
  const actions = useSignerActions(doc.id, onChanged);
  const [extending, setExtending] = useState(false);

  if (!progress) {
    if (loading) {
      return (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("loading")}
        </div>
      );
    }
    return (
      <div className="grid justify-items-start gap-3 py-6" role="alert">
        <p className="text-sm text-destructive">{error ? td(detailErrorKey(error.code)) : t("failed")}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {td("retry")}
        </Button>
      </div>
    );
  }

  const views = roleViews(progress, lang);
  const stats = overallStats(progress.roles);
  const groups = groupAnswers(progress, lang);
  const issues = issueViews(progress.issues, progress.form, lang);
  const nowDate = new Date(now);
  const writeback = latestWriteback(events);

  const holder = views.filter((v) => v.lastActivityAt).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))[0] ?? null;
  const rowOf = (signerId: string | undefined) => (signerId ? signers.find((s) => s.id === signerId) : undefined);
  const holderDevice = holder ? lastDeviceOf(holder.signer?.id ?? null, events, rowOf(holder.signer?.id)?.device) : null;
  const activityWhen = progress.lastActivityAt ? f.relativeTime(new Date(progress.lastActivityAt), now) : null;

  const partsFor = (signerId: string): string[] => views.find((v) => v.signer?.id === signerId)?.unfinished.map((p) => p.title) ?? [];
  const canExtend = canExtendExpiry(doc.status, caps.send);

  return (
    <div className="grid gap-5">
      <section aria-labelledby="sign-progress-title" className="grid gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="sign-progress-title" className="text-sm font-semibold text-foreground">
              {t("title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("partsOf", { done: stats.partsDone, total: stats.partsTotal })}
              {" · "}
              {activityWhen ? (holderDevice ? t("lastActivityFrom", { when: activityWhen, device: t(`device.${holderDevice}`) }) : t("lastActivity", { when: activityWhen })) : t("noActivity")}
            </p>
          </div>
          {canExtend && (
            <Button size="sm" variant="outline" onClick={() => setExtending(true)}>
              <CalendarClock aria-hidden />
              {t("expiry.button")}
            </Button>
          )}
        </div>
        <Bar percent={stats.percent} label={t("overallLabel")} />
        <p className="text-xs text-muted-foreground">
          {t("percent", { percent: stats.percent })}
          {doc.expires_at ? ` · ${t("expiry.expires", { date: formatWhen(doc.expires_at, locale) })}` : ""}
        </p>
      </section>

      {writeback && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground" role="status">
          <UserCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>{t("writeback.note", { when: formatWhen(writeback.at, locale), count: writeback.count })}</span>
          {doc.contact_id && (
            <Link href={`/contacts?contact=${doc.contact_id}`} className="text-primary hover:underline">
              {t("openContact")}
            </Link>
          )}
        </p>
      )}

      {issues.length > 0 && (
        <section aria-labelledby="sign-progress-issues" className="grid gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <h3 id="sign-progress-issues" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <TriangleAlert className="size-4 text-amber-700 dark:text-amber-300" aria-hidden />
            {t("issues.title", { count: issues.length })}
          </h3>
          <ul className="grid gap-1 text-sm text-foreground">
            {issues.map((i, n) => (
              <li key={`${i.code}-${i.field}-${n}`}>{t(`issues.${i.key}`, { field: i.field, code: i.code })}</li>
            ))}
          </ul>
        </section>
      )}

      <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label={t("rolesList")}>
        {views.map((v) => {
          const row = rowOf(v.signer?.id);
          const sa = row ? signerActions(doc.status, row, caps, nowDate) : null;
          const canRemind = !!sa && sa.remind && v.unfinished.length > 0;
          const heldUntil = sa?.remindAfter && v.unfinished.length > 0 ? sa.remindAfter.toISOString() : null;
          return (
            <RoleProgressCard
              key={v.roleKey}
              view={v}
              role={doc.roles_snapshot.find((r) => r.key === v.roleKey)}
              device={lastDeviceOf(v.signer?.id ?? null, events, row?.device)}
              now={now}
              canRemind={canRemind}
              remindHeldUntil={heldUntil}
              onRemind={() => row && actions.open("remind", row)}
            />
          );
        })}
      </ul>

      <AnswersView documentId={doc.id} groups={groups} canReveal={caps.reveal} />

      <SignerActionDialogs actions={actions} partsFor={partsFor} />
      {extending && <ExtendExpiryDialog documentId={doc.id} currentExpiry={doc.expires_at} now={nowDate} onClose={() => setExtending(false)} onExtended={onChanged} />}
    </div>
  );
}
