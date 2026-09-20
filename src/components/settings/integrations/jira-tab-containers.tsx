"use client";

// The fetching half of each Jira settings tab: load what the tab needs,
// turn its callbacks into API calls and toasts. The tabs themselves stay
// presentational (and render in tests without a network).

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth, useCapability } from "@/hooks/use-auth";
import type { JiraSettings, ProjectOverride, TicketPriorityValue } from "@/lib/jira/types";

import {
  jiraFetch,
  useJiraErrorText,
  type JiraFieldsData,
  type JiraMappingInput,
  type JiraNamed,
  type JiraPeopleData,
  type JiraProject,
  type JiraStatusOption,
  type JiraTestResult,
  type JiraUserHit,
  type JiraDiagnostics,
} from "./jira-api";
import { JiraChecklistCard } from "./jira-checklist";
import { JiraDiagnosticsTab } from "./jira-diagnostics-tab";
import { JiraDirectionTab } from "./jira-direction-tab";
import { JiraFieldsTab } from "./jira-fields-tab";
import { JiraMappingTab } from "./jira-mapping-tab";
import { JiraOverridesCard } from "./jira-overrides";
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
    <div className="space-y-4">
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
      <OverridesContainer jira={jira} />
    </div>
  );
}

// ------------------------------------------------------------
// Per-project overrides (under Projects)
// ------------------------------------------------------------

function OverridesContainer({ jira }: ContainerProps) {
  const { settings, patch } = jira;
  const priorities = useJiraQuery<{ priorities: JiraNamed[] }>("metadata?kind=priorities");
  // Issue types load when a project row is opened, one project at a time.
  const [types, setTypes] = useState<Record<string, JiraNamed[]>>({});

  const openProject = useCallback((project: string) => {
    void jiraFetch<{ issueTypes: JiraNamed[] }>(`metadata?kind=issue_types&project=${encodeURIComponent(project)}`).then((r) => {
      // A failure leaves an empty list: the select still offers "inherit" and the saved value.
      setTypes((c) => ({ ...c, [project]: r.ok ? r.data.issueTypes : [] }));
    });
  }, []);

  return (
    <JiraOverridesCard
      projects={settings.projects.allowed}
      overrides={settings.project_overrides}
      workspace={settings}
      priorities={priorities.data?.priorities ?? (priorities.error ? [] : null)}
      issueTypesFor={(p) => types[p] ?? null}
      onOpenProject={openProject}
      onChange={(project, next: ProjectOverride | null) => void patch({ project_overrides: { [project]: next } }, { toastOnSuccess: true })}
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
      requireSigned={settings.webhook.require_signed}
      webhookStats={jira.data?.connection?.webhook_stats ?? null}
      onRequireSignedChange={(on) => void patch({ webhook: { require_signed: on } })}
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
  const [action, setAction] = useState<"webhooks" | "catchup" | "report" | null>(null);
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

  // The personal-data report, now: the answer says whether Atlassian took it.
  const td = useTranslations("Settings.jira.depth.report");
  async function sendReport() {
    setAction("report");
    const res = await jiraFetch<{ report: { ok: boolean; error?: string } | null }>("diagnostics", { method: "POST", body: { action: "send_report" } });
    setAction(null);
    if (!res.ok) {
      toast.error(errorText(res.error));
      return;
    }
    if (res.data.report?.ok) toast.success(td("sent"));
    else toast.error(`${td("notSent")} ${res.data.report?.error ?? ""}`.trim());
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
      onSendReport={() => void sendReport()}
      onResync={(id) => void resync(id)}
      resyncing={resyncing}
    />
  );
}

// ------------------------------------------------------------
// Fields
// ------------------------------------------------------------

export function FieldsTabContainer({ jira }: ContainerProps) {
  const t = useTranslations("Settings.jira.fields");
  const errorText = useJiraErrorText();
  const { settings } = jira;
  const allowed = settings.projects.allowed;
  const [project, setProject] = useState<string>(settings.projects.default_project ?? allowed[0] ?? "");
  const [issueTypeId, setIssueTypeId] = useState("");
  const [busy, setBusy] = useState(false);

  // Every project when none is chosen: the same list the other tabs offer.
  const projects = useJiraQuery<{ projects: JiraProject[] }>(allowed.length === 0 ? PROJECTS_PATH : null);
  const choices = allowed.length > 0 ? allowed : (projects.data?.projects ?? []).map((p) => p.key.toUpperCase());

  const path = project
    ? `fields?project=${encodeURIComponent(project)}${issueTypeId ? `&issueType=${encodeURIComponent(issueTypeId)}` : ""}`
    : null;
  const fields = useJiraQuery<JiraFieldsData>(path);
  const reloadFields = fields.reload;

  async function refresh() {
    if (!path) return;
    const res = await jiraFetch<JiraFieldsData>(`${path}&refresh=1`);
    if (!res.ok) {
      toast.error(errorText(res.error));
      return;
    }
    toast.success(t("refreshed"));
    await reloadFields();
  }

  async function save(input: JiraMappingInput) {
    setBusy(true);
    const res = await jiraFetch<{ mapping: unknown }>("field-mappings", { method: "PUT", body: input });
    setBusy(false);
    if (!res.ok) {
      toast.error(`${t("saveFailed")} ${errorText(res.error)}`);
      return;
    }
    toast.success(t("saved"));
    await reloadFields();
  }

  async function remove(id: string) {
    setBusy(true);
    const res = await jiraFetch<{ ok: boolean }>(`field-mappings?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      toast.error(`${t("removeFailed")} ${errorText(res.error)}`);
      return;
    }
    toast.success(t("removed"));
    await reloadFields();
  }

  return (
    <JiraFieldsTab
      projects={choices}
      project={project}
      onProjectChange={(p) => {
        setProject(p);
        setIssueTypeId("");
      }}
      data={fields.data}
      error={fields.error ? errorText(fields.error) : null}
      refreshing={fields.refreshing}
      busy={busy}
      allowEveryProject={!!settings.projects.default_project}
      onIssueTypeChange={setIssueTypeId}
      onRefresh={() => void refresh()}
      onRetry={() => void reloadFields()}
      onSave={(input) => void save(input)}
      onRemove={(id) => void remove(id)}
    />
  );
}

// ------------------------------------------------------------
// The first-run checklist and "Test connection" (Connection tab)
// ------------------------------------------------------------

export function ChecklistContainer({ jira }: ContainerProps) {
  const errorText = useJiraErrorText();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<JiraTestResult | null>(null);
  const connection = jira.data?.connection;
  const live = !!connection && connection.status === "active";

  async function test() {
    setTesting(true);
    const res = await jiraFetch<{ test: JiraTestResult }>("diagnostics", { method: "POST", body: { action: "test_connection" } });
    setTesting(false);
    if (!res.ok) {
      setResult({ ok: false, code: res.error.code, message: res.error.message });
      return;
    }
    setResult(res.data.test);
    // A passing test may be what turns a step of the checklist green.
    await jira.reload();
  }

  return (
    <JiraChecklistCard
      steps={jira.data?.checklist ?? null}
      canTest={live}
      testing={testing}
      result={result}
      failureText={(code) => errorText({ code })}
      onTest={() => void test()}
    />
  );
}
