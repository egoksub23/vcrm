"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Download, Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { downloadFile } from "@/components/sign/detail/download";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { useBulkJob } from "@/hooks/use-sign-bulk";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { ROW_FILTERS, bulkErrorKey, isFinalJob, jobStatusClass, progressPercent, rowMatches, rowStateClass, type RowFilter } from "@/lib/sign/client/bulk";
import { cn } from "@/lib/utils";
import { useProblemWords } from "./problem-text";

/**
 * One batch: how far it is, what became of each person, and what can still be done (cancel it while it runs,
 * download the results). It asks the server again every few seconds while it is running; closing it loses nothing,
 * because the documents are sent by the server's own job.
 */
export function BulkJobScreen({ id }: { id: string }) {
  const t = useTranslations("Sign.bulk");
  const f = useFormatter();
  const words = useProblemWords();
  const canSend = useCapability("sign.send");
  const { job, rows, loading, errorCode, refresh } = useBulkJob(id);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "download" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !job) {
    return (
      <div className="mx-auto max-w-4xl space-y-3" role="status" aria-label={t("job.loading")}>
        <div className="h-8 w-64 animate-pulse rounded bg-muted/40" />
        <div className="h-24 animate-pulse rounded-xl border border-border bg-muted/40" />
      </div>
    );
  }
  if (!job) {
    return (
      <div className="mx-auto mt-10 max-w-md space-y-3 rounded-xl border border-border bg-card p-6 text-center text-sm" role="alert">
        <p className="text-muted-foreground">{t(bulkErrorKey(errorCode === "job_not_found" ? "job_not_found" : errorCode))}</p>
        <Link href="/sign" className="text-primary underline-offset-4 hover:underline">
          {t("backToDocuments")}
        </Link>
      </div>
    );
  }

  const final = isFinalJob(job.status);
  const percent = progressPercent(job);
  const answered = job.sent + job.failed + job.skipped;
  const counts: Record<RowFilter, number> = { all: job.total, sent: job.sent, failed: job.failed, skipped: job.skipped, pending: job.pending };
  const shown = rows.filter((r) => rowMatches(r.state, filter));

  const cancel = async () => {
    setBusy("cancel");
    setActionError(null);
    try {
      await signRequest(`/api/sign/bulk/${id}/cancel`, { method: "POST", json: {} });
      setConfirming(false);
      refresh();
    } catch (err) {
      setActionError(bulkErrorKey(err instanceof SignApiError ? err.code : "request_failed"));
      if (err instanceof SignApiError && err.code === "job_finished") refresh();
    } finally {
      setBusy(null);
    }
  };
  const download = async () => {
    setBusy("download");
    setActionError(null);
    try {
      await downloadFile(`/api/sign/bulk/${id}/results`, "bulk-send-results.csv");
    } catch (err) {
      setActionError(bulkErrorKey(err instanceof SignApiError ? err.code : "request_failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/sign/bulk" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          {t("job.backToBulk")}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">{t("job.title", { template: job.templateName })}</h1>
          <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", jobStatusClass(job.status))}>{t(`status.${job.status}`)}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("job.started", { date: f.dateTime(new Date(job.createdAt), { dateStyle: "medium", timeStyle: "short" }) })}
          {job.fileName ? ` · ${job.fileName}` : ""}
        </p>
      </div>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="bulk-progress">
        <h2 id="bulk-progress" className="sr-only">
          {t("job.progress")}
        </h2>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("job.progress")}>
          <div className={cn("h-full transition-[width]", job.status === "failed" ? "bg-destructive" : "bg-primary")} style={{ width: `${percent}%` }} />
        </div>
        <p className="text-sm text-foreground" role="status" aria-live="polite">
          {t("job.answered", { done: answered, total: job.total })}
        </p>
        <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          {(["sent", "failed", "skipped", "pending"] as const).map((k) => (
            <div key={k} className={cn("rounded-lg p-2", k === "sent" ? "bg-emerald-500/10" : k === "failed" && job.failed > 0 ? "bg-destructive/10" : "bg-muted/40")}>
              <dt className="text-xs text-muted-foreground">{t(`state.${k}`)}</dt>
              <dd className="text-lg font-semibold tabular-nums text-foreground">{counts[k]}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          {job.status === "queued"
            ? t("job.noteQueued")
            : job.status === "running"
              ? t("job.noteRunning")
              : job.status === "cancelled"
                ? t("job.noteCancelled")
                : job.status === "failed"
                  ? t("job.noteFailed", { reason: words.reason(job.errorCode, null) || t("reason.unknown") })
                  : job.failed + job.skipped > 0
                    ? t("job.noteDoneWithProblems")
                    : t("job.noteDone")}
          {job.finishedAt ? ` ${t("job.finished", { date: f.dateTime(new Date(job.finishedAt), { dateStyle: "medium", timeStyle: "short" }) })}` : ""}
        </p>
        {errorCode && !final ? (
          <p role="alert" className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />
            {t("job.refreshFailed")}
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void download()}>
          {busy === "download" ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
          {t("job.download")}
        </Button>
        {canSend && !final ? (
          confirming ? (
            <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-sm">
              <span className="text-destructive">{t("job.cancelConfirm")}</span>
              <Button type="button" variant="destructive" size="sm" disabled={busy !== null} onClick={() => void cancel()}>
                {busy === "cancel" ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t("job.cancelYes")}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirming(false)}>
                {t("job.cancelNo")}
              </Button>
            </span>
          ) : (
            <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>
              {t("job.cancel")}
            </Button>
          )
        ) : null}
        <Link href="/sign" className="ml-auto text-sm text-primary underline-offset-4 hover:underline">
          {t("job.openList")}
        </Link>
      </div>
      {actionError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t(actionError)}
        </p>
      ) : null}

      <section className="space-y-2" aria-labelledby="bulk-people">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="bulk-people" className="text-sm font-semibold text-foreground">
            {t("job.people")}
          </h2>
          <div role="group" aria-label={t("job.filter")} className="flex flex-wrap gap-1.5">
            {ROW_FILTERS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  filter === k ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t(k === "all" ? "job.filterAll" : `state.${k}`)}
                <span className="tabular-nums text-muted-foreground">{counts[k]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-auto rounded-xl border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t("job.people")}</caption>
            <thead className="bg-muted text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {t("review.colRow")}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t("review.colName")}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t("job.colResult")}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t("job.colDocument")}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.rowNo} className="border-t border-border align-top">
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.rowNo}</td>
                  <td className="max-w-[16rem] px-3 py-2">
                    <p className="truncate text-foreground">{r.name || t("review.empty")}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.email}</p>
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", rowStateClass(r.state))}>
                      {r.state === "pending" && r.inFlight ? t("state.sending") : t(`state.${r.state}`)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.documentId ? (
                      <Link href={`/sign/${r.documentId}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {r.reference ?? t("job.openDocument")}
                      </Link>
                    ) : null}
                    {r.state === "failed" || r.state === "skipped" ? <p className={cn("max-w-[24rem]", r.state === "failed" ? "text-destructive" : "text-muted-foreground", r.documentId && "mt-0.5")}>{words.reason(r.errorCode, r.errorMessage)}</p> : null}
                  </td>
                </tr>
              ))}
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t("job.noRows")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {final && job.failed + job.skipped > 0 ? <p className="text-xs text-muted-foreground">{t("job.retryHint")}</p> : null}
      </section>
    </div>
  );
}
