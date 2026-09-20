"use client";

// Settings > Integrations > Jira > Projects. Which Jira projects tickets may
// link to (empty = every project the connecting user can see), and the
// default project and issue type the Create issue dialog starts from.
// Presentational: every change is reported through onChange (the container
// saves at once).

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { isProjectKey } from "@/lib/jira/settings";
import type { JiraSettings } from "@/lib/jira/types";

import type { JiraNamed, JiraProject } from "./jira-api";
import { JiraCard, LoadProblem, LoadingLine, selectClass } from "./jira-form-parts";

export interface JiraProjectsTabProps {
  value: JiraSettings["projects"];
  /** null while loading. */
  projects: JiraProject[] | null;
  projectsError: string | null;
  /** The issue types of the default project; null while loading (or no default project). */
  issueTypes: JiraNamed[] | null;
  issueTypesError: string | null;
  onChange: (next: Partial<JiraSettings["projects"]>) => void;
  onRetryProjects: () => void;
  onRetryIssueTypes: () => void;
  disabled?: boolean;
}

/** Jira returns at most this many projects per lookup (the metadata route). */
const PROJECT_PAGE = 50;

export function JiraProjectsTab({
  value,
  projects,
  projectsError,
  issueTypes,
  issueTypesError,
  onChange,
  onRetryProjects,
  onRetryIssueTypes,
  disabled,
}: JiraProjectsTabProps) {
  const t = useTranslations("Settings.jira.projects");
  const [query, setQuery] = useState("");

  const allowed = value.allowed;
  const names = useMemo(() => new Map((projects ?? []).map((p) => [p.key.toUpperCase(), p.name])), [projects]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (projects ?? []).filter(
        (p) => !q || p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      ),
    [projects, q],
  );
  const typedKey = query.trim().toUpperCase();
  const canAddTyped =
    isProjectKey(typedKey) && !allowed.includes(typedKey) && !(projects ?? []).some((p) => p.key.toUpperCase() === typedKey);

  function toggle(key: string, on: boolean) {
    const k = key.toUpperCase();
    const next = on ? [...new Set([...allowed, k])] : allowed.filter((a) => a !== k);
    onChange({
      allowed: next,
      // A default outside the allowed list would be refused; clear it.
      ...(next.length > 0 && value.default_project && !next.includes(value.default_project.toUpperCase())
        ? { default_project: null, default_issue_type: null }
        : {}),
    });
  }

  // Default project: the allowed ones, or every loaded project when none is chosen.
  const projectOptions = useMemo(() => {
    const keys = allowed.length > 0 ? allowed : (projects ?? []).map((p) => p.key.toUpperCase());
    const all = new Set(keys);
    if (value.default_project) all.add(value.default_project.toUpperCase());
    return [...all].sort();
  }, [allowed, projects, value.default_project]);

  const typeOptions = useMemo(() => {
    const list = (issueTypes ?? []).map((i) => i.name);
    if (value.default_issue_type && !list.includes(value.default_issue_type)) list.push(value.default_issue_type);
    return list;
  }, [issueTypes, value.default_issue_type]);

  return (
    <div className="space-y-4">
      <JiraCard title={t("allowed.title")} description={t("allowed.description")}>
        <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
          {allowed.length === 0 ? (
            <span className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground">
              {t("allowed.all")}
            </span>
          ) : (
            allowed.map((key) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full border border-primary-soft-2 bg-primary-soft py-0.5 pr-1 pl-2.5 text-xs font-medium text-primary"
              >
                {key}
                {names.get(key) ? <span className="font-normal text-muted-foreground">{names.get(key)}</span> : null}
                <button
                  type="button"
                  onClick={() => toggle(key, false)}
                  disabled={disabled}
                  aria-label={t("allowed.remove", { key })}
                  className="rounded-full p-0.5 hover:bg-primary/10 disabled:opacity-50"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))
          )}
          {allowed.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => onChange({ allowed: [] })} disabled={disabled}>
              {t("allowed.clear")}
            </Button>
          ) : null}
        </div>

        <div className="mt-3 space-y-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("allowed.search")}
            aria-label={t("allowed.search")}
            maxLength={100}
          />
          {projectsError ? (
            <LoadProblem message={projectsError} onRetry={onRetryProjects} />
          ) : projects === null ? (
            <LoadingLine />
          ) : (
            <>
              {shown.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  {projects.length === 0 ? t("allowed.none") : t("allowed.noMatch")}
                </p>
              ) : (
                <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {shown.map((p) => {
                    const key = p.key.toUpperCase();
                    return (
                      <li key={p.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                          <Checkbox
                            checked={allowed.includes(key)}
                            disabled={disabled}
                            onCheckedChange={(c) => toggle(key, c === true)}
                          />
                          <span className="w-16 shrink-0 font-mono text-xs font-semibold text-foreground">{p.key}</span>
                          <span className="min-w-0 truncate text-sm text-foreground">{p.name}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {projects.length >= PROJECT_PAGE ? (
                <p className="text-xs text-muted-foreground">{t("allowed.truncated", { count: PROJECT_PAGE })}</p>
              ) : null}
              {canAddTyped ? (
                <Button variant="outline" size="sm" onClick={() => { toggle(typedKey, true); setQuery(""); }} disabled={disabled}>
                  <Plus className="size-4" />
                  {t("allowed.addKey", { key: typedKey })}
                </Button>
              ) : null}
            </>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("allowed.hint")}</p>
      </JiraCard>

      <JiraCard title={t("defaults.title")} description={t("defaults.description")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">{t("defaults.project")}</span>
            <select
              className={`${selectClass} w-full`}
              value={value.default_project?.toUpperCase() ?? ""}
              disabled={disabled}
              onChange={(e) => onChange({ default_project: e.target.value || null, default_issue_type: null })}
            >
              <option value="">{t("defaults.noProject")}</option>
              {projectOptions.map((key) => (
                <option key={key} value={key}>
                  {names.get(key) ? `${key} · ${names.get(key)}` : key}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">{t("defaults.issueType")}</span>
            <select
              className={`${selectClass} w-full`}
              value={value.default_issue_type ?? ""}
              disabled={disabled || !value.default_project}
              onChange={(e) => onChange({ default_issue_type: e.target.value || null })}
            >
              <option value="">{t("defaults.noIssueType")}</option>
              {typeOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-2 space-y-2">
          {!value.default_project ? (
            <p className="text-xs text-muted-foreground">{t("defaults.pickProjectFirst")}</p>
          ) : issueTypesError ? (
            <LoadProblem message={issueTypesError} onRetry={onRetryIssueTypes} />
          ) : issueTypes === null ? (
            <LoadingLine label={t("defaults.loadingTypes")} />
          ) : null}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("defaults.note")}</p>
      </JiraCard>
    </div>
  );
}
