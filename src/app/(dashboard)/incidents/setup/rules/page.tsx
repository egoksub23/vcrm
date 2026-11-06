"use client";

import { useTranslations } from "next-intl";

import { RulesScreen } from "@/components/incidents/setup/rules-screen";
import { SetupPage } from "@/components/incidents/setup/setup-page";
import { WorkflowPanel } from "@/components/incidents/setup/workflow-panel";

export default function IncidentRulesPage() {
  const t = useTranslations("IncidentPlatform.rules");
  return (
    <SetupPage title={t("title")} help={t("help")}>
      <RulesScreen />
      <WorkflowPanel />
    </SetupPage>
  );
}
