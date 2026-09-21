"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { AtSign, BellRing, Check, Loader2, MessageSquareText, Users, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Profile, Team, TicketMention } from "@/types";
import { openResponses } from "@/lib/tickets/mentions";

export type MentionRowAction = "done" | "cancel" | "nudge";

/**
 * The "needs a response" requests on the open ticket (migration 095).
 *
 * For the person asked: a banner per request, "X asked for your response (via
 * @Team)", with Mark as done and a jump to the comment. For the person who
 * asked: who is still pending, with Nudge (once an hour) and Cancel request.
 * Renders nothing when neither applies.
 */
export function TicketMentionBanner({
  requests,
  currentUserId,
  members,
  teams,
  canWork,
  onAction,
  onJump,
}: {
  requests: TicketMention[];
  currentUserId: string | null;
  members: Profile[];
  teams: Team[];
  /** tickets.work: Nudge and Cancel need it (Mark as done does not). */
  canWork: boolean;
  onAction: (mention: TicketMention, action: MentionRowAction) => Promise<boolean>;
  onJump: (commentId: string) => void;
}) {
  const t = useTranslations("Tickets.detail.mention");
  const [busy, setBusy] = useState<string | null>(null);

  const open = openResponses(requests);
  const forMe = open.filter((r) => r.mentioned_user_id === currentUserId);
  const byMe = open.filter((r) => r.requested_by === currentUserId);
  if (!currentUserId || (forMe.length === 0 && byMe.length === 0)) return null;

  const nameOf = (id: string | null | undefined) => members.find((m) => m.user_id === id)?.full_name ?? t("someone");
  const teamOf = (id: string | null) => (id ? (teams.find((tm) => tm.id === id)?.name ?? null) : null);
  const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

  const run = async (m: TicketMention, action: MentionRowAction) => {
    if (busy) return;
    setBusy(`${m.id}:${action}`);
    await onAction(m, action);
    setBusy(null);
  };

  return (
    <div className="space-y-2" data-mention-banner="yes">
      {forMe.map((m) => {
        const team = teamOf(m.via_team_id);
        return (
          <div
            key={m.id}
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[13px]"
          >
            <AtSign className="size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
            <p className="min-w-0 flex-1 text-foreground">
              <span className="font-semibold">
                {team
                  ? t("askedYouVia", { name: nameOf(m.requested_by), team })
                  : t("askedYou", { name: nameOf(m.requested_by) })}
              </span>{" "}
              <span className="text-muted-foreground">{ago(m.created_at)}</span>
            </p>
            {m.comment_id ? (
              <Button variant="ghost" size="sm" onClick={() => onJump(m.comment_id as string)}>
                <MessageSquareText className="size-3.5" />
                {t("jumpToComment")}
              </Button>
            ) : null}
            <Button size="sm" disabled={busy !== null} onClick={() => void run(m, "done")}>
              {busy === `${m.id}:done` ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {t("markDone")}
            </Button>
          </div>
        );
      })}

      {byMe.length > 0 ? (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[13px]">
          <p className="text-xs font-semibold text-muted-foreground">{t("youAreWaitingOn", { count: byMe.length })}</p>
          <ul className="mt-1.5 space-y-1.5">
            {byMe.map((m) => {
              const team = teamOf(m.via_team_id);
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-foreground">{nameOf(m.mentioned_user_id)}</span>
                  {team ? (
                    <span className="inline-flex items-center gap-0.5 rounded bg-violet-500/15 px-1 text-[11px] font-medium text-violet-700 dark:text-violet-300">
                      <Users className="size-3" aria-hidden />
                      {team}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{ago(m.created_at)}</span>
                  {canWork ? (
                    <span className="ml-auto flex items-center gap-1">
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(m, "nudge")}>
                        {busy === `${m.id}:nudge` ? <Loader2 className="size-3.5 animate-spin" /> : <BellRing className="size-3.5" />}
                        {t("nudge")}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(m, "cancel")}>
                        {busy === `${m.id}:cancel` ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                        {t("cancelRequest")}
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
