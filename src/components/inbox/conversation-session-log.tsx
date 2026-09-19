"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import { History } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { fetchConversationEvents } from "@/lib/conversations/session-log-api";
import { useTeams } from "@/hooks/use-teams";
import type { ConversationEvent, Profile } from "@/types";

interface ConversationSessionLogProps {
  conversationId: string | null;
}

/**
 * klink.cloud parity — a per-conversation "session log" / "case log"
 * (migration 065): a read-only timeline of assign/reassign/priority/
 * close/reopen events, realtime-subscribed so it stays current while an
 * agent has the conversation open. Sits in the contact sidebar rather
 * than the message thread itself — this is metadata about the
 * conversation's handling, not part of the customer-facing transcript.
 */
export function ConversationSessionLog({ conversationId }: ConversationSessionLogProps) {
  const t = useTranslations("Inbox.sessionLog");
  const { teams } = useTeams();
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    const supabase = createClient();
    const [eventRows, { data: profileRows }] = await Promise.all([
      fetchConversationEvents(conversationId).catch(() => [] as ConversationEvent[]),
      supabase.from("profiles").select("*").order("full_name"),
    ]);
    setEvents(eventRows);
    setProfiles((profileRows as Profile[]) ?? []);
    setLoading(false);
  }, [conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`conversation-events-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversation_events",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          setEvents((prev) => [...prev, payload.new as ConversationEvent]);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId]);

  const profileName = (userId: string | null | undefined) =>
    profiles.find((p) => p.user_id === userId)?.full_name ?? t("unknownAgent");
  const teamName = (teamId: string | null | undefined) =>
    teams.find((tm) => tm.id === teamId)?.name ?? t("noTeam");

  const describeEvent = (e: ConversationEvent): string => {
    const meta = e.metadata ?? {};
    switch (e.event_type) {
      case "assigned":
        return t("assigned", { to: profileName(meta.agent_id) });
      case "unassigned":
        return t("unassigned");
      case "team_assigned":
        return t("teamAssigned", { to: teamName(meta.team_id) });
      case "team_unassigned":
        return t("teamUnassigned");
      case "priority_changed":
        return t("priorityChanged", {
          from: meta.from ? t(`priority.${meta.from}` as never) : "—",
          to: meta.to ? t(`priority.${meta.to}` as never) : "—",
        });
      case "closed":
        return t("closed");
      case "reopened":
        return e.metadata?.reason === "customer_message" ? t("reopenedByCustomer") : t("reopened");
      default:
        return e.event_type;
    }
  };

  if (!conversationId) return null;

  return (
    <div>
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <History className="h-3 w-3" />
        {t("heading")}
      </div>
      <div className="mt-2 space-y-1.5">
        {loading && events.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">{t("loading")}</p>
        )}
        {!loading && events.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">{t("empty")}</p>
        )}
        {events.map((e) => (
          <div key={e.id} className="rounded-lg bg-muted px-3 py-2">
            <p className="text-xs text-foreground">{describeEvent(e)}</p>
            {e.note && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{e.note}</p>
            )}
            <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              {e.actor_user_id && <span>{profileName(e.actor_user_id)} · </span>}
              <span title={format(new Date(e.created_at), "PPpp")}>
                {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
              </span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
