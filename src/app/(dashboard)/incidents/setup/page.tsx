"use client";

import { useTranslations } from "next-intl";

import { SetupGuide } from "@/components/incidents/setup/setup-guide";
import { SetupPage } from "@/components/incidents/setup/setup-page";

export default function IncidentSetupGuidePage() {
  const t = useTranslations("IncidentPlatform.guide");
  return (
    <SetupPage title={t("title")} help={t("help")}>
      <SetupGuide />
    </SetupPage>
  );
}
