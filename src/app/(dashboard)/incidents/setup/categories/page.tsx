"use client";

import { useTranslations } from "next-intl";

import { SetupPage } from "@/components/incidents/setup/setup-page";
import { CategoriesScreen } from "@/components/incidents/setup/categories-screen";

export default function IncidentCategoriesPage() {
  const t = useTranslations("IncidentPlatform.categories");
  return (
    <SetupPage title={t("title")} help={t("pageHelp")}>
      <CategoriesScreen />
    </SetupPage>
  );
}
