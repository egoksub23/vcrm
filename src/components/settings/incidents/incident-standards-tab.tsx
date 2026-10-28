"use client";

import { useTranslations } from "next-intl";
import { Building2, CheckCircle2, Globe } from "lucide-react";
import { useIncidentStandard } from "@/hooks/use-incident-standard";

export function IncidentStandardsTab() {
  const t = useTranslations("Settings.incidents.standards");
  const { types, severities, standardName, standardSlug, loading } = useIncidentStandard();

  return (
    <div className="space-y-6">
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CheckCircle2 className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{standardName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("active")}</p>
              </div>
              <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                {t("activeLabel")}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border bg-background/60 px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("incidentTypes")}</p>
                <p className="mt-0.5 text-2xl font-bold text-foreground">{types.length}</p>
              </div>
              <div className="rounded-lg border border-border bg-background/60 px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("severityLevels")}</p>
                <p className="mt-0.5 text-2xl font-bold text-foreground">{severities.length}</p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("typesList")}</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {types.map((ty) => (
                <li key={ty.code} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="w-7 shrink-0 text-center text-[11px] font-bold text-muted-foreground">{ty.code}</span>
                  <span className="flex-1 truncate text-sm text-foreground">{ty.name}</span>
                  {ty.notifiable ? (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                      {t("notifiable")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          {standardSlug === "bnm_rmit" ? (
            <div className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px] text-muted-foreground">
              <Building2 className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("bnmNote")}</span>
            </div>
          ) : null}

          <div className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px] text-muted-foreground">
            <Globe className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("moreStandardsNote")}</span>
          </div>
        </>
      )}
    </div>
  );
}
