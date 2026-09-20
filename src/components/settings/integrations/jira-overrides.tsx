"use client";

// Settings > Integrations > Jira > Projects: per-project overrides. For each
// allowed project a row can override the default issue type, the priority map,
// the category -> label / component choice and each direction switch; anything
// left on "inherit" follows the workspace settings. The backend uses the most
// specific setting (src/lib/jira/settings.ts: effectiveSettings).
// Presentational: the container loads issue types / priorities lazily.

import { useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { normalizeProjectOverride } from "@/lib/jira/settings";
import { DIRECTION_KEYS, TICKET_PRIORITIES, type DirectionSettings, type JiraSettings, type ProjectOverride } from "@/lib/jira/types";

import { SettingsChip } from "../settings-chip";
import type { JiraNamed } from "./jira-api";
import { JiraCard, LoadingLine, selectClass } from "./jira-form-parts";

export interface JiraOverridesCardProps {
  /** The upper-case keys of the allowed projects (none = nothing to override yet). */
  projects: string[];
  overrides: JiraSettings["project_overrides"];
  /** The workspace-level values a row shows as "inherit (...)" hints. */
  workspace: Pick<JiraSettings, "projects" | "mapping" | "direction">;
  priorities: JiraNamed[] | null;
  /** Issue types of a project; the container loads them when its row opens. */
  issueTypesFor: (project: string) => JiraNamed[] | null;
  onOpenProject: (project: string) => void;
  /** null removes the override. */
  onChange: (project: string, next: ProjectOverride | null) => void;
  /** Rows that start open (the settings screen starts closed; tests open them). */
  initiallyOpen?: string[];
  disabled?: boolean;
}

type Tri = "inherit" | "on" | "off";
const triOf = (v: boolean | undefined): Tri => (v === undefined ? "inherit" : v ? "on" : "off");
const boolOf = (v: string): boolean | undefined => (v === "on" ? true : v === "off" ? false : undefined);

/** How many settings a project overrides (the badge on its row). */
export function overrideCount(o: ProjectOverride | undefined): number {
  if (!o) return 0;
  return (
    (o.issue_type ? 1 : 0) +
    Object.keys(o.priority ?? {}).length +
    (o.category_label !== undefined ? 1 : 0) +
    (o.category_component !== undefined ? 1 : 0) +
    Object.keys(o.direction ?? {}).length
  );
}

export function JiraOverridesCard({ projects, overrides, workspace, priorities, issueTypesFor, onOpenProject, onChange, initiallyOpen, disabled }: JiraOverridesCardProps) {
  const t = useTranslations("Settings.jira.overrides");
  return (
    <JiraCard title={t("title")} description={t("description")}>
      {projects.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{t("noProjects")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {projects.map((key) => (
            <OverrideRow
              key={key}
              projectKey={key}
              value={overrides[key]}
              workspace={workspace}
              priorities={priorities}
              issueTypes={issueTypesFor(key)}
              onOpen={() => onOpenProject(key)}
              onChange={(next) => onChange(key, next)}
              initiallyOpen={initiallyOpen?.includes(key)}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t("note")}</p>
    </JiraCard>
  );
}

function OverrideRow({
  projectKey,
  value,
  workspace,
  priorities,
  issueTypes,
  onOpen,
  onChange,
  initiallyOpen,
  disabled,
}: {
  projectKey: string;
  value: ProjectOverride | undefined;
  workspace: JiraOverridesCardProps["workspace"];
  priorities: JiraNamed[] | null;
  issueTypes: JiraNamed[] | null;
  onOpen: () => void;
  onChange: (next: ProjectOverride | null) => void;
  initiallyOpen?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("Settings.jira.overrides");
  const tDir = useTranslations("Settings.jira.direction.flow");
  const tDepth = useTranslations("Settings.jira.depth.flow");
  const [open, setOpen] = useState(!!initiallyOpen);
  const o = value ?? {};
  const count = overrideCount(value);

  function patch(next: Partial<ProjectOverride>) {
    const merged: ProjectOverride = { ...o, ...next };
    for (const k of Object.keys(merged) as (keyof ProjectOverride)[]) if (merged[k] === undefined) delete merged[k];
    onChange(normalizeProjectOverride(merged));
  }
  function setDirection(key: keyof DirectionSettings, v: boolean | undefined) {
    const dir = { ...(o.direction ?? {}) };
    if (v === undefined) delete dir[key];
    else dir[key] = v;
    patch({ direction: Object.keys(dir).length > 0 ? dir : undefined });
  }
  function setPriority(p: (typeof TICKET_PRIORITIES)[number], name: string) {
    const map = { ...(o.priority ?? {}) };
    if (name) map[p] = name;
    else delete map[p];
    patch({ priority: Object.keys(map).length > 0 ? map : undefined });
  }

  const dirLabel = (k: keyof DirectionSettings) => (k === "attachments" || k === "attachments_auto" ? tDepth(`${k}.label`) : tDir(`${k}.label`));

  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
      >
        <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        <span className="font-mono text-xs font-semibold text-foreground">{projectKey}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{count === 0 ? t("noneSet") : t("summary", { count })}</span>
        {count > 0 ? <SettingsChip variant="muted">{t("overridden", { count })}</SettingsChip> : null}
      </button>

      {open ? (
        <div className="space-y-4 border-t border-border bg-muted/20 px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("issueType")}</span>
              {issueTypes === null ? (
                <LoadingLine label={t("loadingTypes")} />
              ) : (
                <select className={`${selectClass} w-full`} value={o.issue_type ?? ""} disabled={disabled} onChange={(e) => patch({ issue_type: e.target.value || undefined })}>
                  <option value="">{t("inheritValue", { value: workspace.projects.default_issue_type ?? t("none") })}</option>
                  {[...new Set([...(o.issue_type ? [o.issue_type] : []), ...issueTypes.map((i) => i.name)])].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <div className="grid grid-cols-2 gap-3">
              {(["category_label", "category_component"] as const).map((k) => (
                <label key={k} className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">{t(`category.${k}`)}</span>
                  <select className={`${selectClass} w-full`} value={triOf(o[k])} disabled={disabled} onChange={(e) => patch({ [k]: boolOf(e.target.value) })}>
                    <option value="inherit">{t("inherit", { value: t(workspace.mapping[k] ? "on" : "off") })}</option>
                    <option value="on">{t("on")}</option>
                    <option value="off">{t("off")}</option>
                  </select>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-foreground">{t("priority")}</p>
            <p className="mb-2 text-[11px] text-muted-foreground">{t("priorityHint")}</p>
            <div className="grid gap-3 sm:grid-cols-4">
              {TICKET_PRIORITIES.map((p) => (
                <label key={p} className="block space-y-1">
                  <span className="text-xs text-muted-foreground">{t(`priorities.${p}`)}</span>
                  <select className={`${selectClass} w-full`} value={o.priority?.[p] ?? ""} disabled={disabled || priorities === null} onChange={(e) => setPriority(p, e.target.value)}>
                    <option value="">{t("inheritValue", { value: workspace.mapping.priority[p] ?? t("none") })}</option>
                    {[...new Set([...(o.priority?.[p] ? [o.priority[p] as string] : []), ...(priorities ?? []).map((x) => x.name)])].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-foreground">{t("direction")}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {DIRECTION_KEYS.map((k) => (
                <label key={k} className="block space-y-1">
                  <span className="text-xs text-muted-foreground">{dirLabel(k)}</span>
                  <select className={`${selectClass} w-full`} value={triOf(o.direction?.[k])} disabled={disabled} onChange={(e) => setDirection(k, boolOf(e.target.value))}>
                    <option value="inherit">{t("inherit", { value: t(workspace.direction[k] ? "on" : "off") })}</option>
                    <option value="on">{t("on")}</option>
                    <option value="off">{t("off")}</option>
                  </select>
                </label>
              ))}
            </div>
          </div>

          {count > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)} disabled={disabled}>
              <RotateCcw className="size-4" />
              {t("reset", { project: projectKey })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
