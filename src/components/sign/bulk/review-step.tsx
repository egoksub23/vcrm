"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { BulkPreview } from "@/lib/sign/bulk/types";
import { copyLeftOut } from "@/lib/sign/client/bulk";
import type { CopyPayload } from "@/lib/sign/client/copy-form";
import { cn } from "@/lib/utils";
import { ProblemList, useProblemWords } from "./problem-text";

interface Props {
  preview: BulkPreview | null;
  loading: boolean;
  /** A message key under `Sign.bulk` for a failed check. */
  errorKey: string | null;
  skipInvalid: boolean;
  onSkipInvalid: (v: boolean) => void;
  onRecheck: () => void;
  /** The people who receive the signed copy of every document (what `buildRequest` sends), for the sender to see before sending. */
  copyTo?: readonly CopyPayload[];
  /** The addresses of the fixed people: they sign every document, so they are left out of its copies. */
  fixedEmails?: readonly string[];
}

/** The most rows drawn at once; the rest are one click away. */
const SHOWN = 200;

/** Step 4: what would happen. The problems, the month's room, and every person. Nothing is sent from here. */
export function ReviewStep({ preview, loading, errorKey, skipInvalid, onSkipInvalid, onRecheck, copyTo = [], fixedEmails = [] }: Props) {
  const t = useTranslations("Sign.bulk");
  const words = useProblemWords();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [all, setAll] = useState(false);

  if (loading && !preview) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("review.checking")}
      </div>
    );
  }
  if (!preview) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t(errorKey ?? "errors.generic")}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRecheck}>
          {t("review.recheck")}
        </Button>
      </div>
    );
  }

  const { counts, headroom, file, plan, rows, template } = preview;
  const blocked = file.problems.length > 0 || plan.problems.length > 0;
  const visible = (onlyProblems ? rows.filter((r) => r.problems.length > 0) : rows).slice(0, all ? undefined : SHOWN);
  const hidden = (onlyProblems ? counts.withProblems : rows.length) - visible.length;
  // who of the copy list also signs a document, and so is left out of that document's copies
  const leftOut = copyTo.length > 0 ? copyLeftOut(copyTo, rows.filter((r) => r.problems.length === 0).map((r) => r.email), fixedEmails) : [];

  return (
    <div className="space-y-4" aria-busy={loading}>
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("review.summaryHeading")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("review.summary", { template: template.name, total: counts.total })}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onRecheck} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {t("review.recheck")}
          </Button>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-emerald-500/10 p-2">
            <dt className="text-xs text-muted-foreground">{t("review.ready")}</dt>
            <dd className="text-lg font-semibold tabular-nums text-foreground">{counts.ok}</dd>
          </div>
          <div className={cn("rounded-lg p-2", counts.withProblems > 0 ? "bg-destructive/10" : "bg-muted/40")}>
            <dt className="text-xs text-muted-foreground">{t("review.withProblems")}</dt>
            <dd className="text-lg font-semibold tabular-nums text-foreground">{counts.withProblems}</dd>
          </div>
          <div className="rounded-lg bg-muted/40 p-2">
            <dt className="text-xs text-muted-foreground">{t("review.total")}</dt>
            <dd className="text-lg font-semibold tabular-nums text-foreground">{counts.total}</dd>
          </div>
        </dl>
      </section>

      {copyTo.length > 0 ? (
        <section aria-labelledby="bulk-review-copies" data-bulk-review-copies className="space-y-2 rounded-xl border border-border bg-card p-4 sm:p-5">
          <h2 id="bulk-review-copies" className="text-sm font-semibold text-foreground">
            {t("review.copiesHeading")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("review.copiesBody", { count: counts.ok })}</p>
          <ul className="divide-y divide-border text-sm">
            {copyTo.map((c) => (
              <li key={c.email.toLowerCase()} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="break-words font-medium text-foreground">{c.fullName}</span>
                <span className="break-all text-xs text-muted-foreground">{c.email}</span>
              </li>
            ))}
          </ul>
          {leftOut.map((p) => (
            <p key={p.email.toLowerCase()} className="text-xs text-muted-foreground">
              {t("review.copiesLeftOut", { name: p.fullName, email: p.email, count: p.documents })}
            </p>
          ))}
        </section>
      ) : null}

      {file.problems.length > 0 ? (
        <div role="alert" className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p className="font-medium">{t("review.fileProblems")}</p>
          <ProblemList problems={file.problems} word={words.file} />
        </div>
      ) : null}
      {plan.problems.length > 0 ? (
        <div role="alert" className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <p className="font-medium">{t("review.planProblems")}</p>
          <ProblemList problems={plan.problems} word={words.plan} />
        </div>
      ) : null}
      {file.ignoredColumns.length > 0 ? (
        <p className="rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">{t("review.ignoredColumns", { columns: file.ignoredColumns.join(", ") })}</p>
      ) : null}

      {headroom.limit !== null ? (
        <div
          role={headroom.fits ? "status" : "alert"}
          className={cn("flex items-start gap-2 rounded-xl border p-3 text-sm", headroom.fits ? "border-border bg-muted/40 text-muted-foreground" : "border-destructive/30 bg-destructive/5 text-destructive")}
        >
          {headroom.fits ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <p>
            {headroom.fits
              ? t("review.headroomFits", { used: headroom.used, limit: headroom.limit, remaining: headroom.remaining ?? 0, needed: headroom.needed })
              : t("review.headroomShort", { used: headroom.used, limit: headroom.limit, remaining: headroom.remaining ?? 0, needed: headroom.needed })}
          </p>
        </div>
      ) : null}

      {counts.withProblems > 0 && counts.ok > 0 && !blocked ? (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card p-3">
          <Checkbox className="mt-0.5" checked={skipInvalid} onCheckedChange={(c) => onSkipInvalid(!!c)} />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("review.skipInvalid", { count: counts.withProblems })}</span>
            <span className="block text-xs text-muted-foreground">{t("review.skipInvalidHint")}</span>
          </span>
        </label>
      ) : null}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t("review.peopleHeading")}</h2>
          {counts.withProblems > 0 ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={onlyProblems} onCheckedChange={(c) => setOnlyProblems(!!c)} />
              {t("review.onlyProblems")}
            </label>
          ) : null}
        </div>
        <div className="max-h-[28rem] overflow-auto rounded-xl border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t("review.peopleHeading")}</caption>
            <thead className="sticky top-0 bg-muted text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {t("review.colRow")}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t("review.colName")}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t("review.colEmail")}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t("review.colProblems")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.rowNo} className={cn("border-t border-border align-top", r.problems.length > 0 && "bg-destructive/5")}>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.rowNo}</td>
                  <td className="max-w-[14rem] truncate px-3 py-2 text-foreground">{r.name || t("review.empty")}</td>
                  <td className="max-w-[16rem] truncate px-3 py-2 text-foreground">{r.email || t("review.empty")}</td>
                  <td className="px-3 py-2">
                    {r.problems.length === 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-3.5" aria-hidden />
                        {t("review.rowOk")}
                      </span>
                    ) : (
                      <ul className="space-y-0.5 text-xs text-destructive">
                        {r.problems.map((p, i) => (
                          <li key={`${p.code}-${i}`}>{words.row(p)}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t("review.noRows")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {hidden > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAll(true)}>
            {t("review.showAll", { count: hidden })}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
