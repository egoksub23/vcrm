"use client";

import { useTranslations } from "next-intl";

import { FormBuilder } from "@/components/incidents/setup/form-builder";
import { SetupPage } from "@/components/incidents/setup/setup-page";

export default function IncidentFormPage() {
  const t = useTranslations("IncidentPlatform.builder");
  return (
    <SetupPage title={t("title")} help={t("help")}>
      <FormBuilder />
    </SetupPage>
  );
}
