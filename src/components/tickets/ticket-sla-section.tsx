"use client";

import { useFormatter, useTranslations } from "next-intl";

import { useSharedNow } from "@/hooks/use-shared-now";
import { cn } from "@/lib/utils";
import { hasSla, ticketSlaView, type TargetView } from "@/lib/sla/display";
import type { TicketSlaFields } from "@/lib/sla/types";
import { SLA_TONE, SlaDetailLines, useSlaContext, useTargetText, type SlaContext } from "./ticket-sla-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The SLA box of the ticket details card: First response and Resolution, each
 * with its own state and due time. Due times show in the viewer's time zone;
 * the tooltip also gives the schedule's zone and both targets. Nothing is
 * rendered for a ticket that has no SLA.
 */
export function TicketSlaSection({
  ticket,
  now: nowProp,
  context,
}: {
  ticket: TicketSlaFields;
  now?: number;
  context?: Partial<SlaContext>;
}) {
  const t = useTranslations("Tickets.sla");
  const format = useFormatter();
  const liveNow = useSharedNow(nowProp === undefined);
  const now = nowProp ?? liveNow;
  const ctx = useSlaContext(ticket.sla_policy_id, context, hasSla(ticket));
  const text = useTargetText();
  if (!hasSla(ticket)) return null;

  const view = ticketSlaView(ticket, now, ctx.business);

  const row = (v: TargetView, respondedAt: string | null | undefined) => {
    if (v.state === "none") return null;
    const tone = SLA_TONE[v.state];
    const Icon = tone.icon;
    return (
      <div key={v.target} className="flex items-start justify-between gap-2 py-1.5">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t(`target.${v.target}`)}</p>
          {v.dueAt !== null ? (
            <p className="text-[13px] text-foreground">
              {t("detail.dueOn", { when: format.dateTime(new Date(v.dueAt), { dateStyle: "medium", timeStyle: "short" }) })}
            </p>
          ) : null}
          {respondedAt ? (
            <p className="text-xs text-muted-foreground">
              {t("detail.respondedAt", { when: format.dateTime(new Date(respondedAt), { dateStyle: "medium", timeStyle: "short" }) })}
            </p>
          ) : null}
        </div>
        <span
          data-sla-state={v.state}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
            tone.className,
          )}
        >
          <Icon className="size-3" aria-hidden />
          {text(v) || t(`state.${v.state}`)}
        </span>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card" data-testid="ticket-sla-section">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-[13px] font-semibold">{t("detail.heading")}</h3>
        <Tooltip>
          <TooltipTrigger
            render={
              <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50" />
            }
          >
            {ctx.policy ? ctx.policy.name : t("tooltip.policyRemoved")}
          </TooltipTrigger>
          <TooltipContent className="max-w-72 whitespace-normal">
            <SlaDetailLines view={view} ctx={ctx} />
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="divide-y divide-border/60 px-3 py-1">
        {row(view.first, ticket.sla_first_response_at)}
        {row(view.resolution, null)}
      </div>
      {ctx.schedule ? (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {t("detail.hours", { name: ctx.schedule.name, zone: ctx.schedule.timezone })}
        </p>
      ) : (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">{t("tooltip.hours247")}</p>
      )}
    </div>
  );
}
