"use client";

import { useTranslations } from "next-intl";

import { PortalScreen } from "@/components/incidents/setup/portal-screen";
import { RetentionPanel } from "@/components/incidents/setup/retention-panel";
import { SetupPage } from "@/components/incidents/setup/setup-page";

export default function IncidentPortalPage() {
  const t = useTranslations("IncidentPlatform.portal");
  return (
    <SetupPage title={t("title")} help={t("help")}>
      <PortalScreen />
      <RetentionPanel />
    </SetupPage>
  );
}
