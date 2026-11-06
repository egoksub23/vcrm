"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Loader2 } from "lucide-react";

import { NoAccess } from "@/components/auth/no-access";
import { useAuth, useCapability } from "@/hooks/use-auth";
import type { Trends } from "@/lib/incidents/platform/registers";
import { api } from "@/components/incidents/setup/api";

interface Data {
  trends: Trends;
  categories: Record<string, string>;
  severities: Record<string, string>;
}

function Bars({ rows, label }: { rows: { key: string; label: string; count: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="flex flex-col gap-1.5" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3 text-sm">
          <span className="w-44 shrink-0 truncate">{r.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary/70" style={{ width: `${r.count === 0 ? 0 : Math.max(4, (r.count / max) * 100)}%` }} />
          </span>
          <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** Reports: how many incidents, where, how serious, and which places keep seeing the same thing. The last 12 months; test reports are left out. */
export function ReportsScreen() {
  const t = useTranslations("IncidentPlatform.reports");
  const { capabilitiesLoading } = useAuth();
  const allowed = useCapability("incidents.manage");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void api<Data>("/api/incidents/insights").then((res) => {
      if (!live) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [allowed]);

  if (capabilitiesLoading) return null;
  if (!allowed) return <NoAccess />;
  const tr = data?.trends;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
      </header>
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {!data && !error ? <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} /> : null}
      {data && tr ? (
        <>
          <p className="text-sm font-medium">{t("total", { count: tr.total })}</p>

          {tr.repeatHazards.length > 0 ? (
            <section aria-label={t("repeat")} className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle className="size-4 text-amber-500" />{t("repeat")}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t("repeatHelp")}</p>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {tr.repeatHazards.map((h) => <li key={h.place}>{t("repeatRow", { place: h.place, count: h.count, latest: h.latest })}</li>)}
              </ul>
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("byMonth")}</h2>
            <Bars label={t("byMonth")} rows={tr.byMonth.map((m) => ({ key: m.month, label: m.month, count: m.count }))} />
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("byCategory")}</h2>
            <Bars label={t("byCategory")} rows={tr.byCategory.map((c) => ({ key: c.code, label: data.categories[c.code] ?? c.code, count: c.count }))} />
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("bySeverity")}</h2>
            <Bars label={t("bySeverity")} rows={tr.bySeverity.map((s) => ({ key: s.slug, label: data.severities[s.slug] ?? s.slug, count: s.count }))} />
          </section>
          {tr.byActivity.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("byActivity")}</h2>
              <Bars label={t("byActivity")} rows={tr.byActivity.map((a) => ({ key: a.name, label: a.name, count: a.count }))} />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
