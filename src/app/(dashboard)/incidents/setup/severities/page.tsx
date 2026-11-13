"use client";

import { useTranslations } from "next-intl";

import { SetupPage } from "@/components/incidents/setup/setup-page";
import { SeverityLevelsPanel } from "@/components/incidents/setup/severity-levels-panel";

export default function IncidentSeveritiesPage() {
  const t = useTranslations("IncidentPlatform.severities");
  return (
    <SetupPage title={t("title")} help={t("pageHelp")}>
      <SeverityLevelsPanel />
    </SetupPage>
  );
}
