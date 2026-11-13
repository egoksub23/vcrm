"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { RegistersScreen } from "@/components/incidents/registers-screen";
import { ReportsScreen } from "@/components/incidents/reports-screen";

export type ReportsTab = "trends" | "registers";

export function parseTab(value: string | null): ReportsTab {
  return value === "registers" ? "registers" : "trends";
}

/** Reports: the trends (where and when) and the registers (the records an auditor asks for, with a CSV), as two tabs on one page. */
export function ReportsHub() {
  const t = useTranslations("IncidentPlatform.reportsHub");
  const tab = parseTab(useSearchParams().get("tab"));
  const choose = (next: ReportsTab) => window.history.replaceState(null, "", next === "trends" ? "/incidents/reports" : `/incidents/reports?tab=${next}`);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <div className="flex w-fit rounded-lg border border-border bg-muted/40 p-0.5" role="tablist" aria-label={t("title")}>
        {(["trends", "registers"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => choose(k)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              tab === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(k)}
          </button>
        ))}
      </div>
      {tab === "registers" ? <RegistersScreen embedded /> : <ReportsScreen embedded />}
    </div>
  );
}
