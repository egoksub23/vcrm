"use client";

import { useFormatter, useTranslations } from "next-intl";
import { AlarmClock, CheckCircle2, Clock, PauseCircle, XCircle, type LucideIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSharedNow } from "@/hooks/use-shared-now";
import { useSlaConfig } from "@/hooks/use-sla-config";
import { cn } from "@/lib/utils";
import type { BusinessSchedule } from "@/lib/sla/business-time";
import { formatDuration, hasSla, ticketSlaView, type TargetDisplayState, type TargetView } from "@/lib/sla/display";
import { toBusinessSchedule } from "@/lib/sla/policy";
import type { SlaPolicy, SlaSchedule, TicketSlaFields } from "@/lib/sla/types";

// ============================================================
// The SLA badge (migration 086): On track (green, "due in 2h 10m"), At risk
// (amber), Breached (red, "overdue 35m"), Paused (grey), Met (green tick).
// Hidden when the ticket has no SLA. The countdown recomputes every 30 seconds
// from the stored due times, with no server call; remaining time is BUSINESS
// time when the policy has a schedule, wall-clock time otherwise.
// ============================================================

export const SLA_TONE: Record<Exclude<TargetDisplayState, "none">, { icon: LucideIcon; className: string }> = {
  on_track: { icon: Clock, className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  at_risk: { icon: AlarmClock, className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  breached: { icon: XCircle, className: "bg-red-500/15 text-red-700 dark:text-red-300" },
  paused: { icon: PauseCircle, className: "bg-muted text-muted-foreground" },
  met: { icon: CheckCircle2, className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
};

export interface SlaContext {
  policy: SlaPolicy | null;
  schedule: SlaSchedule | null;
  business: BusinessSchedule | null;
}

/** The policy, schedule and business schedule behind a ticket's SLA. */
export function useSlaContext(
  policyId: string | null | undefined,
  override?: Partial<SlaContext>,
  /** false: do not read the configuration (a ticket with no SLA needs none). */
  enabled = true,
): SlaContext {
  const config = useSlaConfig(enabled && !override);
  const policy = override?.policy ?? config.policyById(policyId);
  const schedule = override?.schedule ?? (policy?.schedule_id ? config.scheduleById(policy.schedule_id) : null);
  const business = override?.business !== undefined ? override.business : schedule ? toBusinessSchedule(schedule) : null;
  return { policy, schedule, business };
}

/** "Due in 2h 10m" / "Overdue 35m" style text for one target. */
export function useTargetText() {
  const t = useTranslations("Tickets.sla");
  return (v: TargetView, short = false): string => {
    switch (v.state) {
      case "on_track":
        return t(short ? "badge.dueInShort" : "badge.dueIn", { time: formatDuration(v.remainingSeconds ?? 0) });
      case "at_risk":
        return t(short ? "badge.atRiskShort" : "badge.atRisk", { time: formatDuration(v.remainingSeconds ?? 0) });
      case "breached":
        return t("badge.overdue", { time: formatDuration(v.remainingSeconds ?? 0) });
      case "paused":
        return t("badge.paused");
      case "met":
        return t("badge.met");
      default:
        return "";
    }
  };
}

/** The tooltip body: both targets, when they are due (in the viewer's zone), the policy and the hours. */
export function SlaDetailLines({
  view,
  ctx,
}: {
  view: ReturnType<typeof ticketSlaView>;
  ctx: SlaContext;
}) {
  const t = useTranslations("Tickets.sla");
  const format = useFormatter();
  const when = (ms: number, timeZone?: string) =>
    format.dateTime(new Date(ms), { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  const text = useTargetText();
  return (
    <div className="space-y-1.5 text-left">
      {[view.first, view.resolution]
        .filter((v) => v.state !== "none")
        .map((v) => (
          <div key={v.target}>
            <p className="font-semibold">
              {t(`target.${v.target}`)} · {t(`state.${v.state}`)}
            </p>
            {v.remainingSeconds !== null ? <p>{text(v)}</p> : null}
            {v.dueAt !== null ? (
              <p className="opacity-80">
                {t("tooltip.due", { when: when(v.dueAt) })}
                {ctx.schedule ? ` (${t("tooltip.inZone", { when: when(v.dueAt, ctx.schedule.timezone), zone: ctx.schedule.timezone })})` : ""}
              </p>
            ) : null}
            {v.state === "paused" ? <p className="opacity-80">{t("tooltip.pausedWhilePending")}</p> : null}
          </div>
        ))}
      <p className="border-t border-background/20 pt-1 opacity-80">
        {ctx.policy ? t("tooltip.policy", { name: ctx.policy.name }) : t("tooltip.policyRemoved")}
      </p>
      <p className="opacity-80">
        {ctx.schedule
          ? t("tooltip.hours", { name: ctx.schedule.name, zone: ctx.schedule.timezone })
          : t("tooltip.hours247")}
        {ctx.business ? ` · ${t("tooltip.business")}` : ""}
      </p>
    </div>
  );
}

export function TicketSlaBadge({
  ticket,
  compact = false,
  className,
  now: nowProp,
  context,
}: {
  ticket: TicketSlaFields;
  /** Icon and short text only (board cards). */
  compact?: boolean;
  className?: string;
  /** Tests: a fixed clock. */
  now?: number;
  /** Tests: a fixed policy / schedule instead of the cached configuration. */
  context?: Partial<SlaContext>;
}) {
  const liveNow = useSharedNow(nowProp === undefined);
  const now = nowProp ?? liveNow;
  const ctx = useSlaContext(ticket.sla_policy_id, context, hasSla(ticket));
  const text = useTargetText();
  const t = useTranslations("Tickets.sla");
  const view = ticketSlaView(ticket, now, ctx.business);
  const primary = view.primary;
  if (!primary || primary.state === "none") return null;
  const tone = SLA_TONE[primary.state];
  const Icon = tone.icon;
  const label = text(primary, compact);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            data-sla-state={primary.state}
            aria-label={`${t("badgeLabel")}: ${t(`target.${primary.target}`)}, ${t(`state.${primary.state}`)}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              tone.className,
              className,
            )}
          />
        }
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 whitespace-normal">
        <SlaDetailLines view={view} ctx={ctx} />
      </TooltipContent>
    </Tooltip>
  );
}
