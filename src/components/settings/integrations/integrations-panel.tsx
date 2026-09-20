"use client";

// Settings > Integrations (jira.connect). The Jira Cloud link: Connection,
// Projects, Mapping, Direction & privacy, People and Diagnostics. Migration
// 085 / src/lib/jira. The OAuth callback lands here with ?jira=connected,
// ?jira=error&reason=... or ?jira=pick&pending=<id> (a site to choose).

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { SettingsChip } from "../settings-chip";
import { SettingsPanelHead } from "../settings-panel-head";
import { jiraFetch, useJiraErrorText, type JiraSite } from "./jira-api";
import { JiraConnectionCard } from "./jira-connection-card";
import { JiraSitePicker } from "./jira-site-picker";
import { LoadProblem } from "./jira-form-parts";
import {
  DiagnosticsTabContainer,
  DirectionTabContainer,
  MappingTabContainer,
  PeopleTabContainer,
  ProjectsTabContainer,
} from "./jira-tab-containers";
import { useJiraQuery } from "./use-jira-query";
import { useJiraSettings } from "./use-jira-settings";

type JiraTab = "connection" | "projects" | "mapping" | "direction" | "people" | "diagnostics";

const TABS: readonly JiraTab[] = ["connection", "projects", "mapping", "direction", "people", "diagnostics"];

/** The reasons the OAuth callback can send back (?reason=). */
const CONNECT_REASONS = new Set([
  "denied",
  "atlassian",
  "invalid_state",
  "no_sites",
  "site_mismatch",
  "forbidden",
  "unknown",
]);

export function IntegrationsPanel() {
  const t = useTranslations("Settings.jira");
  const errorText = useJiraErrorText();
  const router = useRouter();
  const searchParams = useSearchParams();
  const jira = useJiraSettings();
  const { data, reload } = jira;

  const [tab, setTab] = useState<JiraTab>("connection");
  // ?jira=pick&pending=<id>: read once, when the panel opens.
  const [pending, setPending] = useState<string | null>(() =>
    searchParams.get("jira") === "pick" ? searchParams.get("pending") : null,
  );
  const [picking, setPicking] = useState(false);

  // The callback's answer: one toast, then clean the address bar (keep the section).
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const outcome = searchParams.get("jira");
    if (!outcome) return;
    handled.current = true;
    if (outcome === "connected") {
      toast.success(t("toasts.connected"));
    } else if (outcome === "error") {
      const reason = searchParams.get("reason") ?? "unknown";
      toast.error(t(`toasts.connectError.${CONNECT_REASONS.has(reason) ? reason : "unknown"}`));
    }
    const next = new URLSearchParams(searchParams.toString());
    next.delete("jira");
    next.delete("reason");
    next.delete("pending");
    next.set("tab", "integrations");
    router.replace(`/settings?${next.toString()}`, { scroll: false });
  }, [searchParams, router, t]);

  const sites = useJiraQuery<{ sites: JiraSite[] }>(pending ? `sites?pending=${encodeURIComponent(pending)}` : null);

  async function pickSite(cloudId: string) {
    if (!pending) return;
    setPicking(true);
    const res = await jiraFetch<{ ok: boolean }>("sites", { method: "POST", body: { pending, cloudId } });
    setPicking(false);
    if (!res.ok) {
      toast.error(errorText(res.error));
      // An expired sign-in cannot be finished; drop the picker and let them start again.
      if (res.error.code === "invalid_state") setPending(null);
      return;
    }
    toast.success(t("toasts.connected"));
    setPending(null);
    await reload();
  }

  const connection = data?.connection && data.connection.status !== "revoked" ? data.connection : null;
  const connected = connection !== null;
  // Only the Connection tab makes sense without a connection.
  const activeTab: JiraTab = connected ? tab : "connection";

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <div className="space-y-4 rounded-xl border border-border bg-background/40 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold tracking-tight text-foreground">{t("jira.name")}</h3>
          {data && data.configured ? (
            <SettingsChip variant={!connection ? "muted" : connection.status === "active" ? "ok" : "warn"}>
              {t(!connection ? "jira.notConnected" : connection.status === "active" ? "jira.connected" : "jira.needsReconnect")}
            </SettingsChip>
          ) : null}
          {jira.saving ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label={t("common.saving")} /> : null}
        </div>

        {pending ? (
          <JiraSitePicker
            sites={sites.data?.sites ?? null}
            error={sites.error ? errorText(sites.error) : null}
            busy={picking}
            onPick={(id) => void pickSite(id)}
            onCancel={() => setPending(null)}
          />
        ) : null}

        {jira.loading ? (
          <div className="flex items-center justify-center rounded-xl border border-border bg-card py-12" role="status">
            <Loader2 className="size-6 animate-spin text-primary" />
            <span className="sr-only">{t("common.loading")}</span>
          </div>
        ) : jira.loadError || !data ? (
          <LoadProblem
            message={jira.loadError ? errorText(jira.loadError) : t("common.loadFailed")}
            onRetry={() => void reload()}
          />
        ) : (
          <Tabs value={activeTab} onValueChange={(v) => setTab(v as JiraTab)} className="gap-4">
            <div className="-mx-1 overflow-x-auto px-1 pb-1">
              <TabsList>
                {TABS.map((id) => (
                  <TabsTrigger key={id} value={id} disabled={id !== "connection" && !connected} className="px-3">
                    {t(`tabs.${id}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value="connection">
              <JiraConnectionCard
                configured={data.configured}
                callbackUrl={data.callbackUrl}
                connection={data.connection}
                counts={data.counts}
                onConnect={() => {
                  // A full-page navigation: the route answers with a redirect to Atlassian.
                  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                  window.location.href = "/api/integrations/jira/connect";
                }}
                onDisconnect={jira.disconnect}
              />
            </TabsContent>
            <TabsContent value="projects">
              <ProjectsTabContainer jira={jira} />
            </TabsContent>
            <TabsContent value="mapping">
              <MappingTabContainer jira={jira} />
            </TabsContent>
            <TabsContent value="direction">
              <DirectionTabContainer jira={jira} />
            </TabsContent>
            <TabsContent value="people">
              <PeopleTabContainer />
            </TabsContent>
            <TabsContent value="diagnostics">
              <DiagnosticsTabContainer />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </section>
  );
}
