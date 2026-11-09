"use client";

import { InfoTip } from "./info-tip";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Check, ClipboardCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import type { IncidentObligation } from "@/lib/incidents/types";
import { roleLabel } from "./message-log-panel";

/**
 * The checklist the account's active frameworks (PDPA, ISO 45001, school
 * policy ...) added to this incident, each with the time it is due. Anyone
 * who can see the incident sees it; ticking an item off needs
 * incidents.manage (enforced by RLS, migration 206).
 */
export function ObligationsPanel({
  rows,
  canManage,
  onChanged,
}: {
  rows: IncidentObligation[];
  canManage: boolean;
  onChanged: (row: IncidentObligation) => void;
}) {
  const t = useTranslations("Incidents.detail.obligations");
  const tParty = useTranslations("Incidents.detail.notificationsSent.party");
  const tTips = useTranslations("Incidents.detail.tips");

  // "Overdue" moves with the clock, not only with edits to the incident.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const items = rows.filter((r) => r.status !== "not_applicable");
  if (items.length === 0) return null;

  const toggleDone = async (row: IncidentObligation) => {
    const next = row.status === "done" ? "open" : "done";
    const res = await fetch(`/api/incidents/${row.incident_id}/obligations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oblId: row.id, status: next }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.obligation) {
      toast.error(t("updateFailed"));
      return;
    }
    onChanged(json.obligation as IncidentObligation);
  };

  const open = items.filter((r) => r.status === "open").length;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <ClipboardCheck className="size-3.5" />
        {t("title")}
        <InfoTip text={tTips("steps")} />
        <span className="ml-auto font-medium normal-case">{t("openCount", { open, total: items.length })}</span>
      </h3>
      <ul className="flex flex-col gap-2.5">
        {items.map((r) => {
          const done = r.status === "done";
          const dueMs = r.due_at ? new Date(r.due_at).getTime() : null;
          const overdue = !done && dueMs !== null && dueMs < now;
          return (
            <li key={r.id} className="flex items-start gap-2 text-xs">
              <button
                type="button"
                disabled={!canManage}
                onClick={() => void toggleDone(r)}
                aria-label={done ? t("markOpen") : t("markDone")}
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                  done ? "border-emerald-500 bg-emerald-500 text-white" : "border-border",
                  canManage ? "cursor-pointer" : "cursor-default",
                )}
              >
                {done ? <Check className="size-3" /> : null}
              </button>
              <div className="min-w-0 flex-1">
                <p className={done ? "text-muted-foreground line-through" : "text-foreground"}>{r.title}</p>
                {r.description && !done ? (
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{r.description}</p>
                ) : null}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted-foreground">
                  {r.role_key ? (
                    <span className="font-medium text-foreground/80">{roleLabel(r.role_key)}</span>
                  ) : r.party ? (
                    <span className="font-medium text-foreground/80">{tParty(r.party)}</span>
                  ) : null}
                  {done && r.completed_at ? (
                    <span>{t("doneAt", { when: format(new Date(r.completed_at), "d MMM, HH:mm") })}</span>
                  ) : dueMs !== null ? (
                    <span className={overdue ? "font-semibold text-red-600 dark:text-red-400" : undefined}>
                      {overdue
                        ? t("overdueBy", { time: formatDistanceToNowStrict(dueMs) })
                        : t("dueIn", { time: formatDistanceToNowStrict(dueMs) })}
                    </span>
                  ) : null}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
