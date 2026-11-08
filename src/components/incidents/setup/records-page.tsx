"use client";

import { useTranslations } from "next-intl";

import { RetentionPanel } from "@/components/incidents/setup/retention-panel";
import { SetupPage } from "@/components/incidents/setup/setup-page";

/** Keeping records: how long incidents are kept, with an export and a delete tool. */
export function RecordsPage() {
  const t = useTranslations("IncidentPlatform.records");
  return (
    <SetupPage title={t("title")} help={t("help")}>
      <RetentionPanel />
    </SetupPage>
  );
}
