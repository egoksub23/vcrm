"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { NoAccess } from "@/components/auth/no-access";
import { useAuth, useCapability } from "@/hooks/use-auth";
import type { Attention, Insights, Share } from "@/lib/incidents/platform/insights";
import { api } from "@/components/incidents/setup/api";

/** Bars sized by their share of the whole, so one incident out of five reads as a fifth, not as a full bar. */
function ShareBars({ rows, label }: { rows: Share[]; label: string }) {
  const t = useTranslations("IncidentPlatform.reports");
  return (
    <ul className="flex flex-col gap-1.5" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3 text-sm">
          <span className="w-44 shrink-0 truncate" title={r.label}>{r.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(3, Math.round(r.share * 100))}%` }} />
          </span>
          <span className="w-20 text-right text-xs text-muted-foreground tabular-nums">{t("countShare", { count: r.count, percent: Math.round(r.share * 100) })}</span>
        </li>
      ))}
    </ul>
  );
}

function MonthBars({ rows, label }: { rows: { month: string; count: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="flex flex-col gap-1.5" aria-label={label}>
      {rows.map((r) => (
        <li key={r.month} className="flex items-center gap-3 text-sm">
          <span className="w-44 shrink-0 text-muted-foreground tabular-nums">{r.month}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary/70" style={{ width: `${r.count === 0 ? 0 : Math.max(4, (r.count / max) * 100)}%` }} />
          </span>
          <span className="w-20 text-right text-xs text-muted-foreground tabular-nums">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/** The report itself, from the numbers the server worked out. Separate from the screen so it can be rendered with sample numbers. */
export function ReportsView({ data }: { data: Insights }) {
  const t = useTranslations("IncidentPlatform.reports");
  const line = (a: Attention): string => {
    switch (a.kind) {
      case "overdue":
        return t("item.overdue", { count: a.count });
      case "unacknowledged":
        return t("item.unacknowledged", { count: a.count });
      case "seriousOpen":
        return t("item.seriousOpen", { count: a.count });
      case "stale":
        return t("item.stale", { count: a.count, days: a.days });
      case "repeatStudent":
        return t("item.repeatStudent", { name: a.name, count: a.count });
      case "repeatPlace":
        return t("item.repeatPlace", { place: a.place, count: a.count, latest: a.latest });
      case "rising":
        return t("item.rising", { recent: a.recent, previous: a.previous });
    }
  };

  return (
    <>
      {data.total === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}
      {data.total > 0 ? (
        <>
          <section aria-label={t("attentionTitle")} className={data.attention.length > 0 ? "rounded-xl border border-amber-500/40 bg-amber-500/10 p-4" : "rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4"}>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              {data.attention.length > 0 ? <AlertTriangle className="size-4 text-amber-500" /> : <CheckCircle2 className="size-4 text-emerald-600" />}
              {t("attentionTitle")}
            </h2>
            {data.attention.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">{t("attentionNone")}</p> : null}
            <ul className="mt-2 flex flex-col gap-1.5">
              {data.attention.map((a, n) => (
                <li key={n} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span>{line(a)}</span>
                  <Link href={a.href} className="text-xs font-medium text-primary hover:underline">{t("item.look")}</Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t("numbers")}>
            <Stat label={t("stat.raised")} value={String(data.raisedRecent)} sub={t("stat.raisedSub", { count: data.raisedBefore })} />
            <Stat label={t("stat.open")} value={String(data.open)} />
            <Stat label={t("stat.closed")} value={String(data.closed)} />
            <Stat
              label={t("stat.median")}
              value={data.medianDaysToClose === null ? "–" : t("stat.medianValue", { days: data.medianDaysToClose })}
              sub={data.medianDaysToClose === null ? t("stat.medianNone") : t("stat.medianSub")}
            />
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("byCategory")}</h2>
              <ShareBars label={t("byCategory")} rows={data.byCategory} />
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("bySeverity")}</h2>
              <ShareBars label={t("bySeverity")} rows={data.bySeverity} />
            </section>
            {data.byPlace.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("byPlace")}</h2>
                <ShareBars label={t("byPlace")} rows={data.byPlace} />
              </section>
            ) : null}
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("byMonth")}</h2>
              <MonthBars label={t("byMonth")} rows={data.byMonth} />
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}

/** Reports: what needs attention (each with a link to the incidents behind it), a few numbers that mean something, and where and when incidents happen. */
export function ReportsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useTranslations("IncidentPlatform.reports");
  const { capabilitiesLoading } = useAuth();
  const allowed = useCapability("incidents.manage");
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void api<{ insights: Insights }>("/api/incidents/insights").then((res) => {
      if (!live) return;
      if (res.ok) setData(res.data.insights);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [allowed]);

  if (capabilitiesLoading) return null;
  if (!allowed) return <NoAccess />;

  return (
    <div className={embedded ? "flex flex-col gap-6" : "mx-auto flex max-w-[1100px] flex-col gap-6"}>
      {embedded ? (
        <p className="max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
      ) : (
        <header>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
        </header>
      )}
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {!data && !error ? <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} /> : null}
      {data ? <ReportsView data={data} /> : null}
    </div>
  );
}
