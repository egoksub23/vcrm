"use client";

// The fetching half of each Jira settings tab: load what the tab needs,
// turn its callbacks into API calls and toasts. The tabs themselves stay
// presentational (and render in tests without a network).

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth, useCapability } from "@/hooks/use-auth";
import type { JiraSettings, TicketPriorityValue } from "@/lib/jira/types";

import {
  jiraFetch,
  useJiraErrorText,
  type JiraNamed,
  type JiraPeopleData,
  type JiraProject,
  type JiraStatusOption,
  type JiraUserHit,
  type JiraDiagnostics,
} from "./jira-api";
import { JiraDiagnosticsTab } from "./jira-diagnostics-tab";
import { JiraDirectionTab } from "./jira-direction-tab";
import { JiraMappingTab } from "./jira-mapping-tab";
import { JiraPeopleTab } from "./jira-people-tab";
import { JiraProjectsTab } from "./jira-projects-tab";
import type { UseJiraSettings } from "./use-jira-settings";
import { useJiraQuery } from "./use-jira-query";

interface ContainerProps {
  jira: UseJiraSettings;
}

const PROJECTS_PATH = "metadata?kind=projects&all=1";

// ------------------------------------------------------------
// Projects
// ------------------------------------------------------------

export function ProjectsTabContainer({ jira }: ContainerProps) {
  const errorText = useJiraErrorText();
  const { settings, patch } = jira;
  const defaultProject = settings.projects.default_project;

  const projects = useJiraQuery<{ projects: JiraProject[] }>(PROJECTS_PATH);
  const types = useJiraQuery<{ issueTypes: JiraNamed[] }>(
    defaultProject ? `metadata?kind=issue_types&project=${encodeURIComponent(defaultProject)}` : null,
  );

  return (
    <JiraProjectsTab
      value={settings.projects}
      projects={projects.data?.projects ?? null}
      projectsError={projects.error ? errorText(projects.error) : null}
      issueTypes={defaultProject ? (types.data?.issueTypes ?? null) : null}
      issueTypesError={types.error ? errorText(types.error) : null}
      onChange={(next) => void patch({ projects: next })}
      onRetryProjects={() => void projects.reload()}
      onRetryIssueTypes={() => void types.reload()}
    />
  );
}

// ------------------------------------------------------------
// Mapping
// ------------------------------------------------------------

export function MappingTabContainer({ jira }: ContainerProps) {
  const errorText = useJiraErrorText();
  const { settings, patch, saving } = jira;
  const [statusProject, setStatusProject] = useState(settings.projects.default_project ?? "");

  const priorities = useJiraQuery<{ priorities: JiraNamed[] }>("metadata?kind=priorities");
  const projects = useJiraQuery<{ projects: JiraProject[] }>(PROJECTS_PATH);
  const statuses = useJiraQuery<{ statuses: JiraStatusOption[] }>(
    statusProject ? `metadata?kind=statuses&project=${encodeURIComponent(statusProject)}` : null,
  );

  function changePriority(priority: TicketPriorityValue, name: string | null) {
    const next = { ...settings.mapping.priority };
    if (name) next[priority] = name;
    else delete next[priority];
    void patch({ mapping: { priority: next } });
  }

  return (
    <JiraMappingTab
      mapping={settings.mapping}
      doneBehaviour={settings.done_behaviour}
      priorities={priorities.data?.priorities ?? null}
      prioritiesError={priorities.error ? errorText(priorities.error) : null}
      projects={projects.data?.projects ?? null}
      statusProject={statusProject}
      statuses={statusProject ? (statuses.data?.statuses ?? null) : null}
      statusesError={statuses.error ? errorText(statuses.error) : null}
      saving={saving}
      onPriorityChange={changePriority}
      onCategoryLabelChange={(on) => void patch({ mapping: { category_label: on } })}
      onDoneBehaviourChange={(v) => void patch({ done_behaviour: v })}
      onStatusProjectChange={setStatusProject}
      onSaveStatuses={(maps) =>
        void patch({ mapping: { status_from_jira: maps.from, status_to_jira: maps.to } }, { toastOnSuccess: true })
      }
      onRetryPriorities={() => void priorities.reload()}
      onRetryStatuses={() => void statuses.reload()}
    />
  );
}

// ------------------------------------------------------------
// Direction & privacy
// ------------------------------------------------------------

export function DirectionTabContainer({ jira }: ContainerProps) {
  const { settings, patch } = jira;
  const canManageRoles = useCapability("roles.manage");
  return (
    <JiraDirectionTab
      direction={settings.direction}
      privacy={settings.privacy}
      personalDataReport={settings.personal_data_report}
      canManageRoles={canManageRoles}
      onDirectionChange={(key, on) => void patch({ direction: { [key]: on } as Partial<JiraSettings["direction"]> })}
      onPrivacyChange={(key, on) => void patch({ privacy: { [key]: on } as Partial<JiraSettings["privacy"]> })}
      onPersonalDataReportChange={(on) => void patch({ personal_data_report: on })}
    />
  );
}

// ------------------------------------------------------------
// People
// ------------------------------------------------------------

export function PeopleTabContainer() {
  const t = useTranslations("Settings.jira.people");
  const errorText = useJiraErrorText();
  const { user } = useAuth();
  const people = useJiraQuery<JiraPeopleData>("users");
  const [autoMatching, setAutoMatching] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const reloadPeople = people.reload;

  const search = useCallback(async (query: string): Promise<JiraUserHit[] | null> => {
    const res = await jiraFetch<{ users: JiraUserHit[] }>(`users/search?q=${encodeURIComponent(query)}`);
    return res.ok ? res.data.users : null;
  }, []);

  async function autoMatch() {
    setAutoMatching(true);
    const res = await jiraFetch<{ matched: number; tried: number }>("users", {
      method: "POST",
      body: { action: "auto_match" },
    });
    setAutoMatching(false);
    if (!res.ok) {
      toast.error(errorText(res.error));
      return;
    }
    toast.success(t("autoMatchResult", { matched: res.data.matched, tried: res.data.tried }));
    await reloadPeople();
  }

  async function save(userId: string, hit: JiraUserHit | null) {
    setBusyUserId(userId);
    const res = await jiraFetch<{ ok: boolean }>("users", {
      method: "PUT",
      body: hit
        ? { userId, jiraAccountId: hit.accountId, displayName: hit.displayName }
        : { userId, jiraAccountId: null },
    });
    setBusyUserId(null);
    if (!res.ok) {
      toast.error(`${t("saveFailed")} ${errorText(res.error)}`);
      return;
    }
    toast.success(t(hit ? "saved" : "cleared"));
    await reloadPeople();
  }

  return (
    <JiraPeopleTab
      data={people.data}
      error={people.error ? errorText(people.error) : null}
      currentUserId={user?.id ?? null}
      autoMatching={autoMatching}
      busyUserId={busyUserId}
      onAutoMatch={() => void autoMatch()}
      onPick={(userId, hit) => void save(userId, hit)}
      onClear={(userId) => void save(userId, null)}
      onSearch={search}
      onRetry={() => void reloadPeople()}
    />
  );
}

// ------------------------------------------------------------
// Diagnostics
// ------------------------------------------------------------

export function DiagnosticsTabContainer() {
  const t = useTranslations("Settings.jira.diagnostics");
  const errorText = useJiraErrorText();
  const diagnostics = useJiraQuery<JiraDiagnostics>("diagnostics");
  const [action, setAction] = useState<"webhooks" | "catchup" | null>(null);
  const [resyncing, setResyncing] = useState<string | null>(null);
  const reloadDiagnostics = diagnostics.reload;

  // Per-ticket resync: the same route as "Sync now" on the ticket card (once per 30 s per link).
  async function resync(linkId: string) {
    setResyncing(linkId);
    const res = await jiraFetch<Record<string, unknown>>(`links/${linkId}/sync`, { method: "POST" });
    setResyncing(null);
    if (!res.ok) {
      toast.error(errorText(res.error));
      return;
    }
    toast.success(t("failures.resyncDone"));
    await reloadDiagnostics();
  }

  async function run(kind: "webhooks" | "catchup") {
    setAction(kind);
    const res = await jiraFetch<Record<string, unknown>>("diagnostics", {
      method: "POST",
      body: { action: kind === "webhooks" ? "register_webhooks" : "catchup_now" },
    });
    setAction(null);
    if (!res.ok) {
      toast.error(errorText(res.error));
      return;
    }
    toast.success(t(kind === "webhooks" ? "webhooks.reregistered" : "catchupDone"));
    await reloadDiagnostics();
  }

  return (
    <JiraDiagnosticsTab
      data={diagnostics.data}
      error={diagnostics.error ? errorText(diagnostics.error) : null}
      refreshing={diagnostics.refreshing}
      action={action}
      onRefresh={() => void reloadDiagnostics()}
      onRegisterWebhooks={() => void run("webhooks")}
      onCatchup={() => void run("catchup")}
      onResync={(id) => void resync(id)}
      resyncing={resyncing}
    />
  );
}
