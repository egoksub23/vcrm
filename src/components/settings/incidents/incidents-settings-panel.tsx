"use client";

// Settings > Incidents (incidents.manage). Two tabs — Escalation timers
// (business-day-aware, migration 122) and Recipients (per-account
// overrides, migration 122) — plus the 24/7 incident contact used by
// generated Form A/D (migration 123).

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsPanelHead } from "../settings-panel-head";
import { EscalationTimersTab } from "./escalation-timers-tab";
import { EscalationRecipientsTab } from "./escalation-recipients-tab";
import { IncidentContactForm } from "./incident-contact-form";

type Tab = "timers" | "recipients";

export function IncidentsSettingsPanel() {
  const t = useTranslations("Settings.incidents");
  const [tab, setTab] = useState<Tab>("timers");

  return (
    <div className="space-y-5">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="timers">{t("tabs.timers")}</TabsTrigger>
          <TabsTrigger value="recipients">{t("tabs.recipients")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "timers" ? <EscalationTimersTab /> : <EscalationRecipientsTab />}

      <div className="border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-foreground">{t("contact.title")}</h3>
        <div className="mt-2">
          <IncidentContactForm />
        </div>
      </div>
    </div>
  );
}
