"use client";

// Settings > Doc Sign (sign.settings). The tab is only offered when the platform operator has Doc Sign switched
// on for the workspace: the operator's flag removes every sign.* capability, and the Settings rail and page
// both check this one. Five sections: General, Consent wording, Categories, Add-ons and the sealing certificate.

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { SettingsPanelHead } from "../settings-panel-head";
import { AddonsSection } from "./addons-section";
import { CategoriesSection } from "./categories-section";
import { CertificateSection } from "./certificate-section";
import { ConsentSection } from "./consent-section";
import { GeneralSection } from "./general-section";
import { Loading, useAdminErrorText } from "./shared";
import { useSignSettings } from "./use-sign-settings";

const TABS = ["general", "consent", "categories", "addons", "certificate"] as const;
type Tab = (typeof TABS)[number];

export function SignSettingsPanel() {
  const t = useTranslations("Sign.admin");
  const errorText = useAdminErrorText();
  const [tab, setTab] = useState<Tab>("general");
  const { state, reload, replaceSettings } = useSignSettings();

  return (
    <div className="space-y-5">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(`tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {state.status === "loading" ? <Loading label={t("loading")} /> : null}
      {state.status === "error" ? (
        <div role="alert" className="space-y-3 text-sm">
          <p className="text-destructive">{errorText(state.error)}</p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t("retry")}
          </Button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <>
          {tab === "general" ? <GeneralSection settings={state.data.settings} onSaved={replaceSettings} /> : null}
          {tab === "consent" ? <ConsentSection data={state.data} onSaved={reload} /> : null}
          {tab === "categories" ? <CategoriesSection /> : null}
          {tab === "addons" ? <AddonsSection /> : null}
          {tab === "certificate" ? <CertificateSection /> : null}
        </>
      ) : null}
    </div>
  );
}
