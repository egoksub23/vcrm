"use client";

import { useTranslations } from "next-intl";
import { formatDistanceToNowStrict } from "date-fns";
import { AtSign } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Profile, TicketMention } from "@/types";

/**
 * "Waiting on you": a small amber chip on a ticket card or row when someone
 * asked the signed-in person for a response there (migration 095). The title
 * says who asked and how long ago; `detail` also prints it (list rows).
 */
export function WaitingOnYouChip({
  request,
  members,
  detail = false,
  className,
}: {
  request: Pick<TicketMention, "requested_by" | "created_at">;
  members: Profile[];
  detail?: boolean;
  className?: string;
}) {
  const t = useTranslations("Tickets.detail.mention");
  const who = members.find((m) => m.user_id === request.requested_by)?.full_name ?? t("someone");
  const ago = formatDistanceToNowStrict(new Date(request.created_at), { addSuffix: true });
  const summary = t("chipTitle", { name: who, ago });
  return (
    <span
      data-waiting-on-you="yes"
      title={summary}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[11px] leading-none font-semibold text-amber-800 dark:text-amber-300",
        className,
      )}
    >
      <AtSign className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{t("waitingOnYou")}</span>
      {detail ? <span className="truncate font-normal text-amber-800/80 dark:text-amber-300/80">{summary}</span> : null}
    </span>
  );
}
