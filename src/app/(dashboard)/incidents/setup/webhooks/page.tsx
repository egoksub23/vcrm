"use client";

import { useTranslations } from "next-intl";

import { WebhooksScreen } from "@/components/incidents/setup/webhooks-screen";
import { SetupPage } from "@/components/incidents/setup/setup-page";

export default function IncidentWebhooksPage() {
  const t = useTranslations("IncidentPlatform.webhooks");
  return (
    <SetupPage title={t("title")} help={t("pageHelp")}>
      <WebhooksScreen />
    </SetupPage>
  );
}
