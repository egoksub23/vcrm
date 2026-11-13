"use client";

import { useTranslations } from "next-intl";

import { ChannelsScreen } from "@/components/incidents/setup/channels-screen";
import { SetupPage } from "@/components/incidents/setup/setup-page";

export default function IncidentChannelsPage() {
  const t = useTranslations("IncidentPlatform.channels");
  return (
    <SetupPage title={t("title")} help={t("pageHelp")}>
      <ChannelsScreen />
    </SetupPage>
  );
}
