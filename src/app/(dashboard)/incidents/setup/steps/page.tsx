"use client";

import { useTranslations } from "next-intl";

import { PackScreen } from "@/components/incidents/setup/pack-screen";
import { SetupPage } from "@/components/incidents/setup/setup-page";

export default function IncidentOwnStepsPage() {
  const t = useTranslations("IncidentPlatform.pack");
  return (
    <SetupPage title={t("title")} help={t("pageHelp")}>
      <PackScreen />
    </SetupPage>
  );
}
