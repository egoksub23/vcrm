"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertTriangle, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NeedsAction, Overview } from "@/lib/incidents/platform/overview";
import { api } from "@/components/incidents/setup/api";
import { RaiseIncidentDialog } from "@/components/incidents/raise-incident-dialog";

interface OverviewResponse {
  overview: Overview;
  categories: Record<string, string>;
  severities: Record<string, string>;
  canManage: boolean;
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className={cn("text-2xl font-semibold tabular-nums", tone === "warn" && value > 0 && "text-red-600 dark:text-red-400")}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function duration(minutes: number): string {
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.max(minutes, 1)} min`;
}

/** Overview: what needs action now, and the four numbers a head of school asks for first. */
export function OverviewScreen() {
  const t = useTranslations("IncidentPlatform.overview");
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let live = true;
    void api<OverviewResponse>("/api/incidents/overview").then((res) => {
      if (!live) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, []);

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;
  const o = data.overview;

  const describe = (n: NeedsAction): { title: string; note: string } => {
    if (n.kind === "unacknowledged") return { title: n.title, note: t("needs.unacknowledged", { time: duration(n.waitingMinutes) }) };
    if (n.kind === "overdue_step") return { title: n.title, note: t("needs.overdue", { time: duration(n.overdueMinutes) }) };
    return { title: n.title, note: t("needs.serious", { severity: data.severities[n.severity] ?? n.severity }) };
  };

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">{t("title")}</h1>
        <Button size="sm" onClick={() => setRaiseOpen(true)}><Plus />{t("raise")}</Button>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={o.open} label={t("stats.open")} />
        <Stat value={o.overdueSteps} label={t("stats.overdue")} tone="warn" />
        <Stat value={o.unacknowledged} label={t("stats.unacknowledged")} tone="warn" />
        <Stat value={o.nearMissesThisMonth} label={t("stats.nearMisses")} />
      </div>

      <section aria-label={t("needsTitle")} className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("needsTitle")}</h2>
        {o.needsAction.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{t("nothing")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
            {o.needsAction.map((n, i) => {
              const d = describe(n);
              return (
                <li key={i}>
                  <Link href={`/incidents/${n.incidentId}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50">
                    <AlertTriangle className={cn("size-4 shrink-0", n.kind === "serious_open" ? "text-amber-500" : "text-red-500")} />
                    <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{d.note}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {o.byCategory.length > 0 ? (
        <section aria-label={t("byCategory")} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("byCategory")}</h2>
          <ul className="flex flex-col gap-1.5">
            {o.byCategory.map((c) => {
              const max = o.byCategory[0].count;
              return (
                <li key={c.code} className="flex items-center gap-3 text-sm">
                  <span className="w-48 shrink-0 truncate">{data.categories[c.code] ?? c.code}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(4, (c.count / max) * 100)}%` }} />
                  </span>
                  <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">{c.count}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <RaiseIncidentDialog open={raiseOpen} onOpenChange={setRaiseOpen} onOpenCreated={(id) => router.push(`/incidents/${id}`)} />
    </div>
  );
}
