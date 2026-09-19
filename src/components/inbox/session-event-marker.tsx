"use client";

import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Lock, RotateCcw } from "lucide-react";

import type { ConversationEvent } from "@/types";

/**
 * Inline, staff-only marker for a conversation being closed or reopened
 * — a centered rule (like the date separators, but amber and with a lock)
 * so it's obvious it's an internal record, not part of the customer chat.
 */
export function SessionEventMarker({
  event,
  actorName,
}: {
  event: ConversationEvent;
  /** null when the event has no signed-in actor (automation / system) or
   *  it's a legacy close that predates event logging. */
  actorName: string | null;
}) {
  const t = useTranslations("Inbox.sessionMarker");
  const closed = event.event_type === "closed";
  const legacy = event.metadata?.legacy === "1";
  const Icon = closed ? Lock : RotateCcw;

  const title = closed
    ? actorName
      ? t("closedBy", { name: actorName })
      : legacy
        ? t("closed")
        : t("closedByAutomation")
    : actorName
      ? t("reopenedBy", { name: actorName })
      : t("reopened");

  return (
    <div className="my-1 flex flex-col items-center gap-1" role="separator">
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-amber-500/30" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <Icon className="h-3 w-3" />
          {title}
          <span className="font-normal opacity-80">
            · {format(new Date(event.created_at), "MMM d, HH:mm")}
          </span>
        </span>
        <div className="h-px flex-1 bg-amber-500/30" />
      </div>
      {event.note && (
        <p className="max-w-[80%] whitespace-pre-wrap text-center text-xs text-muted-foreground">
          <span className="font-medium">{t("note")}:</span> {event.note}
        </p>
      )}
      <p className="text-[10px] text-muted-foreground/70">{t("teamOnly")}</p>
    </div>
  );
}
