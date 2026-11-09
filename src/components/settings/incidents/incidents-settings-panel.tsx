"use client";

// Settings > Incidents (incidents.manage). Escalation timers (business-day-aware,
// migration 122) and the templates and packs, plus the 24/7 incident contact used
// by generated Form A/D (migration 123). Who is told on an escalation is set under
// Incidents, Setup, Rules (migration 225 retired the separate list of names).

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsPanelHead } from "../settings-panel-head";
import { EscalationTimersTab } from "./escalation-timers-tab";
import { IncidentContactForm } from "./incident-contact-form";
import { IncidentStandardsTab } from "./incident-standards-tab";

type Tab = "timers" | "standards";

export function IncidentsSettingsPanel() {
  const t = useTranslations("Settings.incidents");
  const [tab, setTab] = useState<Tab>("timers");

  return (
    <div className="space-y-5">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="timers">{t("tabs.timers")}</TabsTrigger>
          <TabsTrigger value="standards">{t("tabs.standards")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "timers" ? <EscalationTimersTab /> : null}
      {tab === "standards" ? <IncidentStandardsTab /> : null}

      {tab !== "standards" ? (
        <div className="border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-foreground">{t("contact.title")}</h3>
          <div className="mt-2">
            <IncidentContactForm />
          </div>
        </div>
      ) : null}
    </div>
  );
}
