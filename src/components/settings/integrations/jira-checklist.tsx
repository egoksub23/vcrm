"use client";

// Settings > Integrations > Jira > Connection: the first-run checklist (the
// in-product version of docs/jira-setup.md section 7.3) and the "Test
// connection" button. Each step turns green as it becomes true. Presentational:
// the container supplies the steps and runs the test.

import { Check, Circle, Loader2, PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { CHECKLIST_STEPS, nextChecklistStep, type ChecklistStep } from "@/lib/jira/checklist";
import { cn } from "@/lib/utils";

import { SettingsChip } from "../settings-chip";
import type { JiraTestResult } from "./jira-api";
import { JiraCard } from "./jira-form-parts";

export interface JiraChecklistCardProps {
  /** null while the server has not sent it (an older answer). */
  steps: ChecklistStep[] | null;
  /** Connected: the test button needs a live connection. */
  canTest: boolean;
  testing: boolean;
  result: JiraTestResult | null;
  /** How the failure code is worded (the container has the error sentences). */
  failureText: (code: string) => string;
  onTest: () => void;
}

const SHOWN_PROJECTS = 12;

export function JiraChecklistCard({ steps, canTest, testing, result, failureText, onTest }: JiraChecklistCardProps) {
  const t = useTranslations("Settings.jira.checklist");
  const list: ChecklistStep[] = steps ?? CHECKLIST_STEPS.map((id) => ({ id, done: false }));
  const next = nextChecklistStep(list);
  const doneCount = list.filter((s) => s.done).length;
  const all = doneCount === list.length;

  return (
    <JiraCard title={t("title")} description={t("description")}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SettingsChip variant={all ? "ok" : "muted"}>{t("progress", { done: doneCount, total: list.length })}</SettingsChip>
        {all ? <span className="text-xs text-muted-foreground">{t("allDone")}</span> : null}
      </div>
      <ol className="divide-y divide-border rounded-lg border border-border">
        {list.map((s) => (
          <li key={s.id} className={cn("flex items-start gap-3 px-3 py-2.5", next === s.id && "bg-primary-soft/40")} aria-current={next === s.id ? "step" : undefined}>
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                s.done ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "border-border text-muted-foreground",
              )}
            >
              {s.done ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {t(`steps.${s.id}.label`)}
                <span className="sr-only"> {t(s.done ? "doneSr" : "todoSr")}</span>
              </p>
              <p className="text-xs text-muted-foreground">{t(`steps.${s.id}.${s.done ? "doneHint" : "hint"}`)}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onTest} disabled={!canTest || testing}>
          {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          {testing ? t("test.running") : t("test.button")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("test.hint")}</span>
      </div>

      {result ? (
        <div
          role="status"
          className={cn(
            "mt-3 rounded-lg border px-3 py-2.5 text-sm",
            result.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
          )}
        >
          {result.ok ? (
            <>
              <p className="font-medium">{t("test.ok", { name: result.user.displayName ?? t("test.unknownUser") })}</p>
              {result.projects.length === 0 ? (
                <p className="mt-1 text-xs">{t("test.noProjects")}</p>
              ) : (
                <>
                  <p className="mt-1 text-xs">{t("test.projects", { count: result.projects.length })}</p>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {result.projects.slice(0, SHOWN_PROJECTS).map((p) => (
                      <li key={p.key} className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground" title={p.name}>
                        <span className="font-mono font-semibold">{p.key}</span> {p.name}
                      </li>
                    ))}
                  </ul>
                  {result.projects.length > SHOWN_PROJECTS || result.hasMore ? (
                    <p className="mt-1 text-xs">{t("test.more", { count: SHOWN_PROJECTS })}</p>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <>
              <p className="font-medium">{t("test.failed")}</p>
              <p className="mt-1 text-xs">{failureText(result.code)}</p>
            </>
          )}
        </div>
      ) : null}
    </JiraCard>
  );
}
