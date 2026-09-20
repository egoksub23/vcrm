"use client";

// Settings > SLA & business hours (sla.configure). Migration 086 / src/lib/sla.
// Two tabs: Business hours (schedules with timezone, weekly slots, holidays, one
// default) and SLA policies (ordered, first match wins, targets in business
// hours). Reading needs no route (RLS); every write goes through
// /api/account/sla/* which checks sla.configure.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSlaConfig } from "@/hooks/use-sla-config";
import { SettingsPanelHead } from "../settings-panel-head";
import { BusinessHoursTab } from "./business-hours-tab";
import { PoliciesTab } from "./policies-tab";

type Tab = "hours" | "policies";

export function SlaPanel() {
  const t = useTranslations("Settings.sla");
  const { schedules, policies, loading, error, reload } = useSlaConfig();
  const [tab, setTab] = useState<Tab>("hours");

  const policyCountBySchedule = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of policies) if (p.schedule_id) m.set(p.schedule_id, (m.get(p.schedule_id) ?? 0) + 1);
    return m;
  }, [policies]);

  return (
    <div className="space-y-5">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="hours">{t("tabs.hours")}</TabsTrigger>
          <TabsTrigger value="policies">
            {t("tabs.policies")}
            {policies.length > 0 ? (
              <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                {policies.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("loadFailed")}
        </p>
      ) : loading && schedules.length === 0 && policies.length === 0 ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : tab === "hours" ? (
        <BusinessHoursTab
          schedules={schedules}
          policyCountBySchedule={policyCountBySchedule}
          loading={loading}
          reload={reload}
        />
      ) : (
        <PoliciesTab policies={policies} schedules={schedules} loading={loading} reload={reload} />
      )}
    </div>
  );
}
