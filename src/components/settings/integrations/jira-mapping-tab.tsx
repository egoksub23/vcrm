"use client";

// Settings > Integrations > Jira > Mapping. Priorities, statuses (both
// directions, with per-name overrides), the category label and what happens
// when a linked issue reaches Done. Presentational: switches and selects
// report each change at once; the status overrides are a draft with an
// explicit Save.

import { useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  JiraSettings,
  TicketPriorityValue,
  TicketStatusValue,
} from "@/lib/jira/types";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/jira/types";

import type { JiraNamed, JiraProject, JiraStatusOption } from "./jira-api";
import { JiraCard, LoadProblem, LoadingLine, SwitchRow, selectClass } from "./jira-form-parts";

export interface StatusMaps {
  from: Record<string, TicketStatusValue>;
  to: Partial<Record<TicketStatusValue, string>>;
}

export interface JiraMappingTabProps {
  mapping: JiraSettings["mapping"];
  doneBehaviour: JiraSettings["done_behaviour"];
  /** null while loading. */
  priorities: JiraNamed[] | null;
  prioritiesError: string | null;
  projects: JiraProject[] | null;
  /** The project whose statuses are loaded ("" = none chosen). */
  statusProject: string;
  /** null while loading (only when a project is chosen). */
  statuses: JiraStatusOption[] | null;
  statusesError: string | null;
  saving?: boolean;
  disabled?: boolean;
  onPriorityChange: (priority: TicketPriorityValue, name: string | null) => void;
  onCategoryLabelChange: (on: boolean) => void;
  onDoneBehaviourChange: (value: JiraSettings["done_behaviour"]) => void;
  onStatusProjectChange: (key: string) => void;
  onSaveStatuses: (maps: StatusMaps) => void;
  onRetryPriorities: () => void;
  onRetryStatuses: () => void;
}

const MAX_OVERRIDES = 60;

export function JiraMappingTab(props: JiraMappingTabProps) {
  const {
    mapping,
    doneBehaviour,
    priorities,
    prioritiesError,
    disabled,
    onPriorityChange,
    onCategoryLabelChange,
    onDoneBehaviourChange,
    onRetryPriorities,
  } = props;
  const t = useTranslations("Settings.jira.mapping");

  return (
    <div className="space-y-4">
      <JiraCard title={t("priority.title")} description={t("priority.description")}>
        {prioritiesError ? <LoadProblem message={prioritiesError} onRetry={onRetryPriorities} /> : null}
        {priorities === null && !prioritiesError ? <LoadingLine /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {TICKET_PRIORITIES.map((p) => {
            const current = mapping.priority[p] ?? "";
            const options = (priorities ?? []).map((x) => x.name);
            if (current && !options.includes(current)) options.push(current);
            return (
              <label key={p} className="block space-y-1">
                <span className="text-xs font-medium text-foreground">{t(`priority.vircle.${p}`)}</span>
                <select
                  className={`${selectClass} w-full`}
                  value={current}
                  disabled={disabled || (priorities === null && !current)}
                  onChange={(e) => onPriorityChange(p, e.target.value || null)}
                >
                  <option value="">{t("priority.jiraDefault")}</option>
                  {options.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </JiraCard>

      <StatusMapCard {...props} />

      <JiraCard title={t("done.title")} description={t("done.description")}>
        <div role="radiogroup" aria-label={t("done.title")} className="grid gap-2 sm:grid-cols-2">
          {(["note", "resolve"] as const).map((v) => (
            <label
              key={v}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft/40"
            >
              <input
                type="radio"
                name="jira-done-behaviour"
                value={v}
                checked={doneBehaviour === v}
                disabled={disabled}
                onChange={() => onDoneBehaviourChange(v)}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{t(`done.${v}.label`)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t(`done.${v}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </JiraCard>

      <JiraCard>
        <SwitchRow
          label={t("categoryLabel.label")}
          hint={t("categoryLabel.hint")}
          checked={mapping.category_label}
          disabled={disabled}
          defaultOn
          onChange={onCategoryLabelChange}
        />
      </JiraCard>
    </div>
  );
}

// ------------------------------------------------------------
// Statuses
// ------------------------------------------------------------

interface FromRow {
  name: string;
  status: TicketStatusValue;
}

function fromRows(m: JiraSettings["mapping"]): FromRow[] {
  return Object.entries(m.status_from_jira)
    .map(([name, status]) => ({ name, status }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toDraftOf(m: JiraSettings["mapping"]): Record<TicketStatusValue, string> {
  return Object.fromEntries(TICKET_STATUSES.map((s) => [s, m.status_to_jira[s] ?? ""])) as Record<TicketStatusValue, string>;
}

function canonical(rows: FromRow[], to: Record<TicketStatusValue, string>): string {
  return JSON.stringify([
    [...rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => [r.name, r.status]),
    TICKET_STATUSES.map((s) => to[s].trim()),
  ]);
}

function StatusMapCard({
  mapping,
  projects,
  statusProject,
  statuses,
  statusesError,
  saving,
  disabled,
  onStatusProjectChange,
  onSaveStatuses,
  onRetryStatuses,
}: JiraMappingTabProps) {
  const t = useTranslations("Settings.jira.mapping.status");
  const listId = useId();

  const [rows, setRows] = useState<FromRow[]>(() => fromRows(mapping));
  const [to, setTo] = useState<Record<TicketStatusValue, string>>(() => toDraftOf(mapping));
  const [newName, setNewName] = useState("");
  const [newStatus, setNewStatus] = useState<TicketStatusValue>("in_progress");

  // Start over from the saved maps whenever they change underneath (a save, a reload).
  const saved = canonical(fromRows(mapping), toDraftOf(mapping));
  const [seen, setSeen] = useState(saved);
  if (saved !== seen) {
    setSeen(saved);
    setRows(fromRows(mapping));
    setTo(toDraftOf(mapping));
  }
  const dirty = canonical(rows, to) !== saved;

  function addRow() {
    const name = newName.trim().toLowerCase();
    if (!name || name.length > 80) return;
    if (!rows.some((r) => r.name === name) && rows.length >= MAX_OVERRIDES) return;
    setRows((prev) => [...prev.filter((r) => r.name !== name), { name, status: newStatus }]);
    setNewName("");
  }

  function save() {
    const from: Record<string, TicketStatusValue> = {};
    for (const r of rows) from[r.name] = r.status;
    const out: Partial<Record<TicketStatusValue, string>> = {};
    for (const s of TICKET_STATUSES) {
      const n = to[s].trim();
      if (n) out[s] = n;
    }
    onSaveStatuses({ from, to: out });
  }

  function reset() {
    setRows(fromRows(mapping));
    setTo(toDraftOf(mapping));
    setNewName("");
  }

  return (
    <JiraCard title={t("title")} description={t("description")}>
      <div className="grid gap-3 lg:grid-cols-2">
        <DefaultsTable
          title={t("defaults.fromTitle")}
          rows={[
            [t("category.new"), t("ticket.open")],
            [t("category.indeterminate"), t("ticket.in_progress")],
            [t("category.done"), t("ticket.resolved")],
          ]}
        />
        <DefaultsTable
          title={t("defaults.toTitle")}
          rows={[
            [t("ticket.open"), t("category.new")],
            [t("ticket.in_progress"), t("category.indeterminate")],
            [t("ticket.resolved"), t("category.done")],
          ]}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("defaults.noTwin")}</p>

      <div className="mt-4 space-y-2 rounded-lg border border-border p-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">{t("project.label")}</span>
          <select
            className={`${selectClass} w-full sm:w-72`}
            value={statusProject}
            disabled={disabled || projects === null}
            onChange={(e) => onStatusProjectChange(e.target.value)}
          >
            <option value="">{t("project.none")}</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.key}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">{t("project.hint")}</p>
        {statusProject && statusesError ? <LoadProblem message={statusesError} onRetry={onRetryStatuses} /> : null}
        {statusProject && statuses === null && !statusesError ? <LoadingLine /> : null}
        {statuses && statuses.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" aria-label={t("project.available")}>
            {statuses.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.category ?? undefined}
                onClick={() => setNewName(s.name)}
                className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-foreground hover:bg-accent"
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
        <datalist id={listId}>
          {(statuses ?? []).map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
      </div>

      <div className="mt-4 space-y-2">
        <h4 className="text-xs font-semibold text-foreground">{t("from.title")}</h4>
        <p className="text-xs text-muted-foreground">{t("from.description")}</p>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
            {t("from.empty")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{r.name}</span>
                <span aria-hidden className="text-muted-foreground">→</span>
                <select
                  className={selectClass}
                  value={r.status}
                  disabled={disabled}
                  aria-label={t("from.statusFor", { name: r.name })}
                  onChange={(e) =>
                    setRows((prev) => prev.map((x) => (x.name === r.name ? { ...x, status: e.target.value as TicketStatusValue } : x)))
                  }
                >
                  {TICKET_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`ticket.${s}`)}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={t("from.remove", { name: r.name })}
                  onClick={() => setRows((prev) => prev.filter((x) => x.name !== r.name))}
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            list={listId}
            value={newName}
            maxLength={80}
            disabled={disabled}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRow();
              }
            }}
            placeholder={t("from.namePlaceholder")}
            aria-label={t("from.namePlaceholder")}
            className="w-full sm:w-56"
          />
          <span aria-hidden className="text-muted-foreground">→</span>
          <select
            className={selectClass}
            value={newStatus}
            disabled={disabled}
            aria-label={t("from.newStatus")}
            onChange={(e) => setNewStatus(e.target.value as TicketStatusValue)}
          >
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`ticket.${s}`)}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={addRow} disabled={disabled || !newName.trim() || rows.length >= MAX_OVERRIDES}>
            <Plus className="size-4" />
            {t("from.add")}
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <h4 className="text-xs font-semibold text-foreground">{t("to.title")}</h4>
        <p className="text-xs text-muted-foreground">{t("to.description")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {TICKET_STATUSES.map((s) => (
            <label key={s} className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t(`ticket.${s}`)}</span>
              <Input
                list={listId}
                value={to[s]}
                maxLength={80}
                disabled={disabled}
                onChange={(e) => setTo((prev) => ({ ...prev, [s]: e.target.value }))}
                placeholder={t(s === "pending" || s === "closed" ? "to.placeholderNone" : "to.placeholderDefault")}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={disabled || saving || !dirty}>
          {t("save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={reset} disabled={!dirty || saving}>
          {t("discard")}
        </Button>
        {dirty ? <span className="text-xs text-muted-foreground">{t("unsaved")}</span> : null}
      </div>
    </JiraCard>
  );
}

function DefaultsTable({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-lg border border-border">
      <p className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground">{title}</p>
      <ul className="divide-y divide-border">
        {rows.map(([a, b]) => (
          <li key={a} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate text-foreground">{a}</span>
            <span aria-hidden className="text-muted-foreground">→</span>
            <span className="min-w-0 flex-1 truncate text-foreground">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
