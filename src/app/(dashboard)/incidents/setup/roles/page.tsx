"use client";

import { useTranslations } from "next-intl";

import { RolesScreen } from "@/components/incidents/setup/roles-screen";
import { SetupPage } from "@/components/incidents/setup/setup-page";

export default function IncidentRolesPage() {
  const t = useTranslations("IncidentPlatform.roles");
  return (
    <SetupPage title={t("title")} help={t("help")}>
      <RolesScreen />
    </SetupPage>
  );
}
