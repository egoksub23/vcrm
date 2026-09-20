"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  jiraApi,
  type JiraApiError,
  type JiraApiResult,
  type JiraCreateChoices,
  type JiraCreatePreview,
  type JiraNamed,
  type JiraProject,
  type JiraRequiredField,
  type JiraUserHit,
} from "@/hooks/use-ticket-jira";
import type { TicketJiraLinkRow } from "@/lib/jira/types";
import { fieldHasValue, safeHttpUrl, splitLabels } from "@/lib/tickets/jira-ui";
import { JIRA_INPUT_CLASS, JIRA_TEXTAREA_CLASS, JiraErrorNotice, JiraUserPicker } from "./jira-form-parts";

/** What the person picked in the top half of the dialog. */
export interface JiraCreateChoiceState {
  projectKey: string;
  issueTypeId: string;
  /** "" = the priority mapped from the ticket. */
  priorityName: string;
  /** Free text: labels separated by spaces or commas. */
  labelsText: string;
  assignee: JiraUserHit | null;
}

export const EMPTY_CREATE_CHOICES: JiraCreateChoiceState = {
  projectKey: "",
  issueTypeId: "",
  priorityName: "",
  labelsText: "",
  assignee: null,
};

export interface JiraCreateFormProps {
  /** The Jira site, for "Open in Jira instead". */
  siteUrl?: string | null;
  projects: JiraProject[];
  projectsLoading: boolean;
  /** Loading the projects failed (nothing to choose from). */
  projectsError?: JiraApiError | null;
  issueTypes: JiraNamed[];
  issueTypesLoading: boolean;
  priorities: JiraNamed[];
  choices: JiraCreateChoiceState;
  onChoicesChange: (next: JiraCreateChoiceState) => void;
  onSearchUsers: (query: string) => Promise<JiraUserHit[]>;
  /** What will be sent, once the choices are complete. */
  preview: JiraCreatePreview | null;
  previewLoading: boolean;
  previewError: JiraApiError | null;
  /** Values for the required fields the preview asks for, by field id. */
  fieldValues: Record<string, unknown>;
  onFieldValuesChange: (next: Record<string, unknown>) => void;
  creating: boolean;
  createError: JiraApiError | null;
  onCreate: () => void;
  onCancel: () => void;
}

function FormRow({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** One required field the project insists on, as the right control for its kind. */
function RequiredControl({
  field,
  value,
  onChange,
  onSearchUsers,
}: {
  field: JiraRequiredField;
  value: unknown;
  onChange: (next: unknown) => void;
  onSearchUsers: (query: string) => Promise<JiraUserHit[]>;
}) {
  const t = useTranslations("Jira.create");
  const id = useId();
  const [picked, setPicked] = useState<JiraUserHit | null>(null);
  const str = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

  let control: ReactNode;
  switch (field.kind) {
    case "textarea":
      control = <textarea id={id} rows={3} value={str} onChange={(e) => onChange(e.target.value)} className={JIRA_TEXTAREA_CLASS} />;
      break;
    case "number":
      control = <input id={id} type="number" value={str} onChange={(e) => onChange(e.target.value)} className={JIRA_INPUT_CLASS} />;
      break;
    case "date":
      control = <input id={id} type="date" value={str} onChange={(e) => onChange(e.target.value)} className={JIRA_INPUT_CLASS} />;
      break;
    case "select":
      control = (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value)} className={JIRA_INPUT_CLASS}>
          <option value="">{t("choose")}</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
      break;
    case "multiselect": {
      const picks = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div id={id} role="group" aria-label={field.name} className="space-y-1 rounded-lg border border-border bg-background p-2">
          {field.options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={picks.includes(o.id)}
                onChange={(e) => onChange(e.target.checked ? [...picks, o.id] : picks.filter((p) => p !== o.id))}
                className="size-3.5 accent-primary"
              />
              <span className="min-w-0 truncate">{o.name}</span>
            </label>
          ))}
        </div>
      );
      break;
    }
    case "user":
      control = (
        <JiraUserPicker
          inputId={id}
          value={picked}
          onSearch={onSearchUsers}
          onChange={(u) => {
            setPicked(u);
            onChange(u ? u.accountId : "");
          }}
        />
      );
      break;
    case "labels":
      control = (
        <input id={id} type="text" value={str} onChange={(e) => onChange(e.target.value)} placeholder={t("labelsPlaceholder")} className={JIRA_INPUT_CLASS} />
      );
      break;
    default:
      control = <input id={id} type="text" maxLength={255} value={str} onChange={(e) => onChange(e.target.value)} className={JIRA_INPUT_CLASS} />;
  }
  return (
    <FormRow label={`${field.name} *`} htmlFor={field.kind === "multiselect" ? undefined : id}>
      {control}
    </FormRow>
  );
}

/**
 * The body of the "Create issue" dialog. Presentational: the container feeds it
 * the lookups, the preview and the values, and receives every change.
 * Step 1 choose (project, type, priority, assignee, labels); step 2 review
 * exactly what will be sent and fill the fields the project requires; then Create.
 */
export function JiraCreateForm(props: JiraCreateFormProps) {
  const {
    siteUrl,
    projects,
    projectsLoading,
    projectsError,
    issueTypes,
    issueTypesLoading,
    priorities,
    choices,
    onChoicesChange,
    onSearchUsers,
    preview,
    previewLoading,
    previewError,
    fieldValues,
    onFieldValuesChange,
    creating,
    createError,
    onCreate,
    onCancel,
  } = props;
  const t = useTranslations("Jira.create");
  const ids = { project: useId(), type: useId(), priority: useId(), labels: useId(), assignee: useId() };

  const set = (patch: Partial<JiraCreateChoiceState>) => onChoicesChange({ ...choices, ...patch });
  const ready = !!choices.projectKey && !!choices.issueTypeId;
  const unsupported = preview?.required.unsupported ?? [];
  const ask = preview?.required.ask ?? [];
  const missing = ask.filter((f) => !fieldHasValue(f.kind, fieldValues[f.id]));
  const site = safeHttpUrl(siteUrl);
  const canCreate = !!preview && unsupported.length === 0 && missing.length === 0 && !creating && !previewLoading;
  const p = preview?.preview;

  return (
    <div className="space-y-4">
      <section aria-label={t("chooseHeading")} className="grid gap-3 sm:grid-cols-2">
        <FormRow label={t("project")} htmlFor={ids.project}>
          {projectsError ? (
            <JiraErrorNotice error={projectsError} />
          ) : (
            <select
              id={ids.project}
              value={choices.projectKey}
              disabled={projectsLoading || creating}
              onChange={(e) => set({ projectKey: e.target.value, issueTypeId: "" })}
              className={JIRA_INPUT_CLASS}
            >
              <option value="">{projectsLoading ? t("loading") : t("chooseProject")}</option>
              {projects.map((pr) => (
                <option key={pr.id} value={pr.key}>
                  {pr.name} ({pr.key})
                </option>
              ))}
            </select>
          )}
        </FormRow>
        <FormRow label={t("issueType")} htmlFor={ids.type}>
          <select
            id={ids.type}
            value={choices.issueTypeId}
            disabled={!choices.projectKey || issueTypesLoading || creating}
            onChange={(e) => set({ issueTypeId: e.target.value })}
            className={JIRA_INPUT_CLASS}
          >
            <option value="">{issueTypesLoading ? t("loading") : t("chooseType")}</option>
            {issueTypes.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label={t("priority")} htmlFor={ids.priority} hint={t("priorityHint")}>
          <select
            id={ids.priority}
            value={choices.priorityName}
            disabled={creating}
            onChange={(e) => set({ priorityName: e.target.value })}
            className={JIRA_INPUT_CLASS}
          >
            <option value="">{t("priorityDefault")}</option>
            {priorities.map((pr) => (
              <option key={pr.id} value={pr.name}>
                {pr.name}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label={t("assignee")} htmlFor={ids.assignee}>
          <JiraUserPicker
            inputId={ids.assignee}
            value={choices.assignee}
            onSearch={onSearchUsers}
            onChange={(u) => set({ assignee: u })}
            placeholder={t("assigneePlaceholder")}
            disabled={creating || !choices.projectKey}
          />
        </FormRow>
        <div className="sm:col-span-2">
          <FormRow label={t("labels")} htmlFor={ids.labels} hint={t("labelsHint")}>
            <input
              id={ids.labels}
              type="text"
              value={choices.labelsText}
              disabled={creating}
              onChange={(e) => set({ labelsText: e.target.value })}
              placeholder={t("labelsPlaceholder")}
              className={JIRA_INPUT_CLASS}
            />
          </FormRow>
        </div>
      </section>

      {ready ? (
        <section aria-label={t("previewHeading")} className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <h4 className="text-[13px] font-semibold text-foreground">{t("previewHeading")}</h4>
          {previewLoading && !p ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("previewLoading")}
            </p>
          ) : previewError ? (
            <JiraErrorNotice error={previewError} />
          ) : p ? (
            <>
              <p className="text-xs text-muted-foreground">{preview?.previewRequired ? t("previewRequired") : t("previewInfo")}</p>
              <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
                <dt className="text-xs text-muted-foreground">{t("project")}</dt>
                <dd className="min-w-0 break-words">{p.project}</dd>
                <dt className="text-xs text-muted-foreground">{t("issueType")}</dt>
                <dd className="min-w-0 break-words">{p.issueType ?? "—"}</dd>
                <dt className="text-xs text-muted-foreground">{t("summary")}</dt>
                <dd className="min-w-0 font-medium break-words">{p.summary}</dd>
                <dt className="text-xs text-muted-foreground">{t("description")}</dt>
                <dd className="min-w-0">
                  <pre className="max-h-40 overflow-y-auto rounded-md border border-border bg-background p-2 font-sans text-xs leading-relaxed break-words whitespace-pre-wrap">
                    {p.descriptionText}
                  </pre>
                  {p.descriptionTruncated ? <span className="text-[11px] text-muted-foreground">{t("descriptionTruncated")}</span> : null}
                </dd>
                <dt className="text-xs text-muted-foreground">{t("priority")}</dt>
                <dd className="min-w-0 break-words">{p.priority ?? t("priorityNone")}</dd>
                <dt className="text-xs text-muted-foreground">{t("labels")}</dt>
                <dd className="min-w-0 break-words">{p.labels.length > 0 ? p.labels.join(", ") : "—"}</dd>
                <dt className="text-xs text-muted-foreground">{t("assignee")}</dt>
                <dd className="min-w-0 break-words">
                  {p.assigneeAccountId ? (choices.assignee?.displayName ?? p.assigneeAccountId) : t("unassigned")}
                </dd>
              </dl>
              {choices.assignee && !p.assigneeAccountId ? <p className="text-[11px] text-muted-foreground">{t("assigneeIgnored")}</p> : null}
              <p
                data-includes-customer={p.includesCustomer ? "yes" : "no"}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground"
              >
                {p.includesCustomer ? t("customerIncluded") : t("customerExcluded")}
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      {p && ask.length > 0 ? (
        <section aria-label={t("requiredHeading")} className="space-y-3">
          <h4 className="text-[13px] font-semibold text-foreground">{t("requiredHeading")}</h4>
          <p className="text-xs text-muted-foreground">{t("requiredHint")}</p>
          {ask.map((f) => (
            <RequiredControl
              key={f.id}
              field={f}
              value={fieldValues[f.id]}
              onChange={(v) => onFieldValuesChange({ ...fieldValues, [f.id]: v })}
              onSearchUsers={onSearchUsers}
            />
          ))}
        </section>
      ) : null}

      {unsupported.length > 0 ? (
        <section
          role="alert"
          data-unsupported="yes"
          className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200"
        >
          <p className="text-[13px] font-semibold">{t("unsupportedTitle")}</p>
          <p>{t("unsupportedBody")}</p>
          <ul className="list-disc pl-4">
            {unsupported.map((n) => (
              <li key={n} className="break-words">
                {n}
              </li>
            ))}
          </ul>
          {site ? (
            <a
              href={site}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              {t("openInJira")}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </section>
      ) : null}

      {createError ? <JiraErrorNotice error={createError} /> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={creating}>
          {t("cancel")}
        </Button>
        <Button onClick={onCreate} disabled={!canCreate}>
          {creating ? <Loader2 className="size-4 animate-spin" /> : null}
          {creating ? t("creating") : t("create")}
        </Button>
      </div>
    </div>
  );
}

const asChoices = (c: JiraCreateChoiceState, issueTypes: JiraNamed[]): JiraCreateChoices => ({
  projectKey: c.projectKey,
  issueTypeId: c.issueTypeId,
  issueTypeName: issueTypes.find((i) => i.id === c.issueTypeId)?.name,
  priorityName: c.priorityName || undefined,
  extraLabels: splitLabels(c.labelsText),
  assigneeAccountId: c.assignee?.accountId,
});

type Loaded<T> = { key: string; result: JiraApiResult<T> };

/** The loading half: talks to the API, holds the state, and feeds JiraCreateForm. Mounted only while open. */
function JiraCreateContainer({
  ticketId,
  siteUrl,
  defaultProject,
  defaultIssueType,
  onCreated,
  onCancel,
}: {
  ticketId: string;
  siteUrl?: string | null;
  defaultProject?: string | null;
  defaultIssueType?: string | null;
  onCreated: (link: TicketJiraLinkRow) => void;
  onCancel: () => void;
}) {
  const [projects, setProjects] = useState<JiraApiResult<{ projects: JiraProject[] }> | null>(null);
  const [priorities, setPriorities] = useState<JiraNamed[]>([]);
  const [types, setTypes] = useState<Loaded<{ issueTypes: JiraNamed[] }> | null>(null);
  const [choices, setChoices] = useState<JiraCreateChoiceState>(EMPTY_CREATE_CHOICES);
  const [previewed, setPreviewed] = useState<Loaded<JiraCreatePreview> | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<JiraApiError | null>(null);

  // Projects and priorities, once. A single choice (or the admin's default) is preselected.
  useEffect(() => {
    let cancelled = false;
    void jiraApi.projects().then((r) => {
      if (cancelled) return;
      setProjects(r);
      if (!r.ok) return;
      const list = r.data.projects;
      const wanted = defaultProject ? list.find((p) => p.key.toUpperCase() === defaultProject.toUpperCase()) : undefined;
      const only = list.length === 1 ? list[0] : undefined;
      const pick = wanted ?? only;
      if (pick) setChoices((c) => (c.projectKey ? c : { ...c, projectKey: pick.key }));
    });
    void jiraApi.priorities().then((r) => {
      if (!cancelled && r.ok) setPriorities(r.data.priorities);
    });
    return () => {
      cancelled = true;
    };
  }, [defaultProject]);

  // Issue types of the chosen project.
  const projectKey = choices.projectKey;
  useEffect(() => {
    if (!projectKey) return;
    let cancelled = false;
    void jiraApi.issueTypes(projectKey).then((r) => {
      if (cancelled) return;
      setTypes({ key: projectKey, result: r });
      if (!r.ok) return;
      const list = r.data.issueTypes;
      const wanted = defaultIssueType
        ? list.find((i) => i.id === defaultIssueType || i.name.toLowerCase() === defaultIssueType.toLowerCase())
        : undefined;
      const pick = wanted ?? (list.length === 1 ? list[0] : undefined);
      if (pick) setChoices((c) => (c.projectKey === projectKey && !c.issueTypeId ? { ...c, issueTypeId: pick.id } : c));
    });
    return () => {
      cancelled = true;
    };
  }, [projectKey, defaultIssueType]);

  const issueTypes = useMemo(() => (types && types.key === projectKey && types.result.ok ? types.result.data.issueTypes : []), [types, projectKey]);
  const issueTypesLoading = !!projectKey && !(types && types.key === projectKey);

  // The preview: what would be sent, and which required fields to ask for. It follows every choice.
  const previewKey = choices.projectKey && choices.issueTypeId ? JSON.stringify([choices.projectKey, choices.issueTypeId, choices.priorityName, splitLabels(choices.labelsText), choices.assignee?.accountId ?? null]) : "";
  useEffect(() => {
    if (!previewKey) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void jiraApi.previewCreate(ticketId, asChoices(choices, issueTypes)).then((r) => {
        if (!cancelled) setPreviewed({ key: previewKey, result: r });
      });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // `choices` and `issueTypes` are read through previewKey (and the type list only names the type).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, ticketId]);

  const current = previewKey && previewed && previewed.key === previewKey ? previewed.result : null;
  const preview = current && current.ok ? current.data : null;
  const previewError = current && !current.ok ? current : null;

  const searchUsers = useCallback(
    (q: string) => jiraApi.searchUsers(q, projectKey || undefined).then((r) => (r.ok ? r.data.users : [])),
    [projectKey],
  );

  const create = async () => {
    if (!preview || creating) return;
    setCreating(true);
    setCreateError(null);
    const values: Record<string, unknown> = {};
    for (const f of preview.required.ask) {
      if (fieldHasValue(f.kind, fieldValues[f.id])) values[f.id] = fieldValues[f.id];
    }
    const r = await jiraApi.createIssue(ticketId, asChoices(choices, issueTypes), values);
    setCreating(false);
    if (r.ok) onCreated(r.data.link);
    else setCreateError(r);
  };

  return (
    <JiraCreateForm
      siteUrl={siteUrl}
      projects={projects && projects.ok ? projects.data.projects : []}
      projectsLoading={projects === null}
      projectsError={projects && !projects.ok ? projects : null}
      issueTypes={issueTypes}
      issueTypesLoading={issueTypesLoading}
      priorities={priorities}
      choices={choices}
      onChoicesChange={(next) => {
        // A new project or type means different required fields.
        if (next.projectKey !== choices.projectKey || next.issueTypeId !== choices.issueTypeId) setFieldValues({});
        setCreateError(null);
        setChoices(next);
      }}
      onSearchUsers={searchUsers}
      preview={preview}
      previewLoading={!!previewKey && !current}
      previewError={previewError}
      fieldValues={fieldValues}
      onFieldValuesChange={setFieldValues}
      creating={creating}
      createError={createError}
      onCreate={() => void create()}
      onCancel={onCancel}
    />
  );
}

/** "Create issue" on a ticket: choose, review exactly what is sent, confirm. */
export function JiraCreateDialog({
  open,
  onOpenChange,
  ticketId,
  siteUrl,
  defaultProject,
  defaultIssueType,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  siteUrl?: string | null;
  defaultProject?: string | null;
  defaultIssueType?: string | null;
  onCreated: (link: TicketJiraLinkRow) => void;
}) {
  const t = useTranslations("Jira.create");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-popover text-popover-foreground sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <JiraCreateContainer
          ticketId={ticketId}
          siteUrl={siteUrl}
          defaultProject={defaultProject}
          defaultIssueType={defaultIssueType}
          onCreated={onCreated}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
