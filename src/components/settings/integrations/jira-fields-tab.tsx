"use client";

// Settings > Integrations > Jira > Fields. Map a Vircle ticket custom field to
// a Jira field of a compatible SIMPLE type (text, number, date, choice,
// checkbox), per project: which way it flows and what happens when the value
// is missing. The Jira fields come from the project's create screen (cached,
// refreshable); types Vircle cannot handle are listed as "not supported".
// Presentational: the container loads the data and saves.

import { useMemo, useState } from "react";
import { ArrowLeftRight, ArrowRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { compatibleJiraKinds, mappingProblem, type JiraFieldInfo, type MappingDirection, type WhenMissing } from "@/lib/jira/field-mapping";

import { SettingsChip } from "../settings-chip";
import type { JiraFieldsData, JiraMappingInput } from "./jira-api";
import { JiraCard, LoadProblem, LoadingLine, selectClass } from "./jira-form-parts";

export interface JiraFieldsTabProps {
  /** The projects that can be chosen (the allowed ones, or every project the user can browse). */
  projects: string[];
  project: string;
  onProjectChange: (project: string) => void;
  /** null while loading. */
  data: JiraFieldsData | null;
  error: string | null;
  refreshing: boolean;
  /** The mapping being saved (a form key), or the id being removed. */
  busy: boolean;
  onIssueTypeChange: (issueTypeId: string) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onSave: (input: JiraMappingInput) => void;
  onRemove: (mappingId: string) => void;
  /** Whether "every project" mappings may be made (needs a default project). */
  allowEveryProject?: boolean;
  disabled?: boolean;
}

const DIRECTIONS: readonly MappingDirection[] = ["to_jira", "from_jira", "both"];
const MISSING: readonly WhenMissing[] = ["skip", "clear", "default"];

export function JiraFieldsTab({
  projects,
  project,
  onProjectChange,
  data,
  error,
  refreshing,
  busy,
  onIssueTypeChange,
  onRefresh,
  onRetry,
  onSave,
  onRemove,
  allowEveryProject,
  disabled,
}: JiraFieldsTabProps) {
  const t = useTranslations("Settings.jira.fields");
  const format = useFormatter();

  const supported = useMemo(() => (data?.fields ?? []).filter((f) => f.supported), [data]);
  const unsupported = useMemo(() => (data?.fields ?? []).filter((f) => !f.supported), [data]);
  const mappings = data?.mappings ?? [];
  const jiraById = useMemo(() => new Map((data?.fields ?? []).map((f) => [f.id, f])), [data]);
  const ticketById = useMemo(() => new Map((data?.ticketFields ?? []).map((f) => [f.id, f])), [data]);

  return (
    <div className="space-y-4">
      <JiraCard title={t("scope.title")} description={t("scope.description")}>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noProjects")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("project")}</span>
              <select className={`${selectClass} w-full`} value={project} disabled={disabled} onChange={(e) => onProjectChange(e.target.value)}>
                <option value="">{t("chooseProject")}</option>
                {projects.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("issueType")}</span>
              <select
                className={`${selectClass} w-full`}
                value={data?.issueType.id ?? ""}
                disabled={disabled || !data}
                onChange={(e) => onIssueTypeChange(e.target.value)}
              >
                {(data?.issueTypes ?? []).map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={!project || refreshing || disabled}>
              {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {t("refresh")}
            </Button>
          </div>
        )}
        {data ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {data.cached ? t("cachedAt", { when: format.relativeTime(new Date(data.cachedAt)) }) : t("liveNow")}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">{t("scope.note")}</p>
      </JiraCard>

      {error ? <LoadProblem message={error} onRetry={onRetry} /> : null}
      {!error && project && data === null ? <LoadingLine /> : null}

      {data ? (
        <>
          <JiraCard title={t("mappings.title")} description={t("mappings.description")}>
            {mappings.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{t("mappings.empty")}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {mappings.map((m) => {
                  const tf = ticketById.get(m.ticket_field_id);
                  const stillThere = jiraById.get(m.jira_field_id);
                  return (
                    <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                      <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium text-foreground">{tf?.label ?? t("mappings.archivedField")}</span>
                        {m.direction === "both" ? <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <ArrowRight className={`size-3.5 shrink-0 text-muted-foreground ${m.direction === "from_jira" ? "rotate-180" : ""}`} aria-hidden />}
                        <span className="text-foreground">{m.jira_field_name}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{m.jira_field_id}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SettingsChip variant="muted">{t(`directions.${m.direction}`)}</SettingsChip>
                        <SettingsChip variant="muted">{t(`missing.${m.when_missing}`)}</SettingsChip>
                        {m.project_key === "*" ? <SettingsChip variant="muted">{t("everyProject")}</SettingsChip> : null}
                        {!stillThere ? <SettingsChip variant="warn">{t("mappings.notOnScreen")}</SettingsChip> : null}
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => onRemove(m.id)} disabled={busy || disabled} aria-label={t("mappings.remove", { name: m.jira_field_name })}>
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </JiraCard>

          <AddMappingForm
            key={`${data.project}:${data.issueType.id}`}
            data={data}
            supported={supported}
            busy={busy}
            disabled={disabled}
            allowEveryProject={allowEveryProject}
            onSave={onSave}
          />

          <JiraCard title={t("jiraFields.title")} description={t("jiraFields.description")}>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("jiraFields.name")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("jiraFields.type")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("jiraFields.status")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...supported, ...unsupported].map((f) => (
                    <tr key={f.id} className="align-top">
                      <th scope="row" className="px-3 py-2 font-medium text-foreground">
                        {f.name}
                        <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">{f.id}</span>
                      </th>
                      <td className="px-3 py-2 text-muted-foreground">{f.supported ? t(`kinds.${f.kind}`) : (f.schemaType ?? "")}</td>
                      <td className="px-3 py-2">
                        {f.supported ? (
                          <SettingsChip variant="ok">{t("jiraFields.supported")}</SettingsChip>
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <SettingsChip variant="warn">{t("jiraFields.notSupported")}</SettingsChip>
                            <span className="text-xs text-muted-foreground">{t(`jiraFields.reasons.${f.reason ?? "type"}`)}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </JiraCard>

          <JiraCard title={t("notes.title")}>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>{t("notes.adf")}</li>
              <li>{t("notes.firstSync")}</li>
              <li>{t("notes.jiraWins")}</li>
              <li>{t("notes.checkbox")}</li>
            </ul>
          </JiraCard>
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// The add form
// ------------------------------------------------------------

function AddMappingForm({
  data,
  supported,
  busy,
  disabled,
  allowEveryProject,
  onSave,
}: {
  data: JiraFieldsData;
  supported: JiraFieldInfo[];
  busy: boolean;
  disabled?: boolean;
  allowEveryProject?: boolean;
  onSave: (input: JiraMappingInput) => void;
}) {
  const t = useTranslations("Settings.jira.fields.add");
  const tk = useTranslations("Settings.jira.fields");
  const [ticketFieldId, setTicketFieldId] = useState("");
  const [jiraFieldId, setJiraFieldId] = useState("");
  const [direction, setDirection] = useState<MappingDirection>("both");
  const [whenMissing, setWhenMissing] = useState<WhenMissing>("skip");
  const [defaultValue, setDefaultValue] = useState("");
  const [label, setLabel] = useState("");
  const [everyProject, setEveryProject] = useState(false);

  const mappedHere = new Set(data.mappings.filter((m) => m.project_key === data.project).map((m) => m.ticket_field_id));
  const free = data.ticketFields.filter((f) => !mappedHere.has(f.id));
  const ticketField = data.ticketFields.find((f) => f.id === ticketFieldId) ?? null;
  const compatible = ticketField ? supported.filter((j) => mappingProblem(ticketField, j) === null) : [];
  const jira = compatible.find((j) => j.id === jiraFieldId) ?? null;

  function submit() {
    if (!ticketField || !jira) return;
    onSave({
      projectKey: everyProject ? "*" : data.project,
      issueTypeId: data.issueType.id,
      ticketFieldId: ticketField.id,
      jiraFieldId: jira.id,
      direction,
      whenMissing,
      defaultValue: whenMissing === "default" ? defaultValue.trim() || null : null,
      label: jira.kind === "labels" ? label.trim() || null : null,
    });
    setTicketFieldId("");
    setJiraFieldId("");
    setDefaultValue("");
    setLabel("");
  }

  return (
    <JiraCard title={t("title")} description={t("description")}>
      {data.ticketFields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noTicketFields")}</p>
      ) : free.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("allMapped")}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("ticketField")}</span>
              <select
                className={`${selectClass} w-full`}
                value={ticketFieldId}
                disabled={disabled || busy}
                onChange={(e) => {
                  setTicketFieldId(e.target.value);
                  setJiraFieldId("");
                }}
              >
                <option value="">{t("pickTicketField")}</option>
                {free.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} ({tk(`ticketTypes.${f.field_type}`)})
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("jiraField")}</span>
              <select className={`${selectClass} w-full`} value={jiraFieldId} disabled={disabled || busy || !ticketField} onChange={(e) => setJiraFieldId(e.target.value)}>
                <option value="">{ticketField && compatible.length === 0 ? t("noCompatible") : t("pickJiraField")}</option>
                {compatible.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name} ({tk(`kinds.${j.kind}`)})
                  </option>
                ))}
              </select>
              {ticketField ? (
                <span className="block text-[11px] text-muted-foreground">
                  {t("compatibleWith", { kinds: compatibleJiraKinds(ticketField.field_type).map((k) => tk(`kinds.${k}`)).join(", ") })}
                </span>
              ) : null}
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("direction")}</span>
              <select className={`${selectClass} w-full`} value={direction} disabled={disabled || busy} onChange={(e) => setDirection(e.target.value as MappingDirection)}>
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {tk(`directions.${d}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("whenMissing")}</span>
              <select className={`${selectClass} w-full`} value={whenMissing} disabled={disabled || busy} onChange={(e) => setWhenMissing(e.target.value as WhenMissing)}>
                {MISSING.map((m) => (
                  <option key={m} value={m}>
                    {tk(`missing.${m}`)}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-muted-foreground">{t(`whenMissingHint.${whenMissing}`)}</span>
            </label>
            {whenMissing === "default" ? (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-foreground">{t("defaultValue")}</span>
                <Input value={defaultValue} maxLength={255} disabled={disabled || busy} onChange={(e) => setDefaultValue(e.target.value)} placeholder={t("defaultPlaceholder")} />
              </label>
            ) : null}
            {jira?.kind === "labels" ? (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-foreground">{t("label")}</span>
                <Input value={label} maxLength={50} disabled={disabled || busy} onChange={(e) => setLabel(e.target.value)} placeholder={ticketField ? ticketField.label : ""} />
                <span className="block text-[11px] text-muted-foreground">{t("labelHint")}</span>
              </label>
            ) : null}
          </div>
          {allowEveryProject ? (
            <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5" checked={everyProject} disabled={disabled || busy} onChange={(e) => setEveryProject(e.target.checked)} />
              <span>{t("everyProject", { project: data.project })}</span>
            </label>
          ) : null}
          <Button size="sm" onClick={submit} disabled={!ticketField || !jira || busy || disabled}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t("submit")}
          </Button>
        </div>
      )}
    </JiraCard>
  );
}
