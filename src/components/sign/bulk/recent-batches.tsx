"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { useRecentBatches } from "@/hooks/use-sign-bulk";
import { jobStatusClass } from "@/lib/sign/client/bulk";
import { cn } from "@/lib/utils";

/** The workspace's last few batches, each a link to its progress and results. */
export function RecentBatches() {
  const t = useTranslations("Sign.bulk");
  const f = useFormatter();
  const { jobs, loading, error } = useRecentBatches();

  if (loading || (jobs.length === 0 && !error)) return null;
  return (
    <section aria-labelledby="bulk-recent" className="space-y-2 pt-2">
      <h2 id="bulk-recent" className="text-sm font-semibold text-foreground">
        {t("recent.heading")}
      </h2>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("recent.failed")}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/sign/bulk/${j.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 outline-none hover:bg-muted/40 focus-visible:bg-muted/40">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{j.templateName}</p>
                  <p className="text-xs text-muted-foreground">{f.dateTime(new Date(j.createdAt), { dateStyle: "medium", timeStyle: "short" })}</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">{t("recent.counts", { sent: j.sent, total: j.total })}</span>
                  <span className={cn("inline-flex h-5 items-center rounded-full px-2 font-medium", jobStatusClass(j.status))}>{t(`status.${j.status}`)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
