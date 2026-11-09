"use client";

import { useTranslations } from "next-intl";

import { BusinessHoursPanel } from "@/components/incidents/setup/business-hours-panel";
import { SetupPage } from "@/components/incidents/setup/setup-page";
import { TimingScreen } from "@/components/incidents/setup/timing-screen";

export default function IncidentTimingPage() {
  const t = useTranslations("IncidentPlatform.timing");
  return (
    <SetupPage title={t("title")} help={t("pageHelp")}>
      <TimingScreen />
      <BusinessHoursPanel />
    </SetupPage>
  );
}
