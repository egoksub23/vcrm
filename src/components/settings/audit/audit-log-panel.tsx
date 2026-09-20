"use client";

// Settings > Audit log (audit.view). Two tabs: the activity log, and
// Recently removed with Restore. Migration 082 / src/lib/audit.

import { useTranslations } from "next-intl";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { SettingsPanelHead } from "../settings-panel-head";
import { AuditActivityTab } from "./audit-activity-tab";
import { AuditRemovedTab } from "./audit-removed-tab";

export function AuditLogPanel() {
  const t = useTranslations("Settings.audit");

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Tabs defaultValue="activity" className="gap-4">
        <TabsList>
          <TabsTrigger value="activity">{t("tabs.activity")}</TabsTrigger>
          <TabsTrigger value="removed">{t("tabs.removed")}</TabsTrigger>
        </TabsList>
        <TabsContent value="activity">
          <AuditActivityTab />
        </TabsContent>
        <TabsContent value="removed">
          <AuditRemovedTab />
        </TabsContent>
      </Tabs>
    </section>
  );
}
