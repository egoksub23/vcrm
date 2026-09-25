"use client";

// Global Mentions column — the middle-pane view for the sidebar's
// "Mentions" entry (replaces the old header-icon Sheet, mentions-panel.tsx,
// which kept getting missed sitting among five other look-alike icon
// buttons). Lists every unread mention/DM notification across every
// channel, same GET /api/sembang/mentions source the old panel used;
// clicking a row opens its thread in the right column (ThreadPanel)
// without leaving this list, so several mentions can be worked through
// in a row — the list stays visible, only the thread on the right
// changes.
//
// ThreadPanel here is driven by per-message action calls parametrized
// per click (@/lib/sembang/message-actions.ts), since each mention can
// belong to a different channel — unlike channel-thread.tsx, which has
// one fixed channelId for its whole lifetime.
//
// Known, accepted simplifications for this cross-channel view (not
// present in the regular per-channel thread):
// - canRemoveMessages only reflects account-admin, not per-channel
//   moderator role (that would need a per-channel membership fetch for
//   an arbitrary set of channels) — a moderator wanting to remove
//   someone else's message still needs to do it from the real channel.
// - pinnedMessageIds is always empty here, so the pin icon may briefly
//   under-report an already-pinned message; pinning it again surfaces
//   the existing "already pinned" 409 as a toast, not silent duplication.
// - Replying doesn't auto-clear a mention — "Mark as done" is still the
//   one clearing mechanism, unchanged from the old panel.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { AtSign, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { ThreadPanel } from "./thread-panel";
import { MessagePreview } from "./message-body";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useAccountMembers } from "@/hooks/use-account-members";
import { hasMinRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/client";
import {
  addMessageToTask,
  editMessage,
  reactToMessage,
  removeMessage,
  toggleMessagePin,
  toggleMessageStar,
} from "@/lib/sembang/message-actions";
import type { SembangMentionItem, SembangMessage, SembangReactionSummary } from "@/types";

const EMPTY_PINNED_IDS = new Set<string>();

interface MentionsColumnProps {
  /** Bumped whenever a mention is cleared, so the sidebar's unread-total
   *  badge (a separate fetch over the channel list) can refresh. */
  onCleared?: () => void;
}

export function MentionsColumn({ onCleared }: MentionsColumnProps) {
  const t = useTranslations("Sembang.mentionsPanel");
  const tThread = useTranslations("Sembang.thread");
  const { user, accountRole } = useAuth();
  const { members: accountMembers } = useAccountMembers();
  const peopleNames = useMemo(() => accountMembers.map((m) => m.full_name), [accountMembers]);
  const canRemoveMessages = hasMinRole(accountRole ?? "viewer", "admin");

  const [results, setResults] = useState<SembangMentionItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [openMention, setOpenMention] = useState<SembangMentionItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await fetch("/api/sembang/mentions", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (!cancelled) setResults((data.results as SembangMentionItem[]) ?? []);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClear = async (item: SembangMentionItem) => {
    setClearingId(item.notificationId);
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", item.notificationId);
    setClearingId(null);
    if (updateError) return;
    setResults((prev) => prev?.filter((r) => r.notificationId !== item.notificationId) ?? prev);
    if (openMention?.notificationId === item.notificationId) setOpenMention(null);
    onCleared?.();
  };

  // ---- Thread actions, parametrized per click by openMention.channel.id --
  const handleReact = useCallback(
    async (messageId: string, emoji: string): Promise<SembangReactionSummary[] | null> => {
      if (!openMention) return null;
      const result = await reactToMessage(openMention.channel.id, messageId, emoji);
      if (!result.ok) {
        toast.error(result.error || tThread("reactFailed"));
        return null;
      }
      return result.reactions;
    },
    [openMention, tThread],
  );

  const handleTogglePin = useCallback(
    (message: SembangMessage, pinned: boolean) => {
      if (!openMention) return;
      void toggleMessagePin(openMention.channel.id, message.id, pinned).then((result) => {
        if (!result.ok) toast.error(result.error || (pinned ? tThread("unpinFailed") : tThread("pinFailed")));
      });
    },
    [openMention, tThread],
  );

  const handleToggleStar = useCallback(
    (message: SembangMessage, starred: boolean) => {
      if (!openMention) return;
      void toggleMessageStar(openMention.channel.id, message.id, starred).then((result) => {
        if (!result.ok) toast.error(starred ? tThread("unstarFailed") : tThread("starFailed"));
      });
    },
    [openMention, tThread],
  );

  const handleEditMessage = useCallback(
    async (messageId: string, body: string): Promise<SembangMessage | null> => {
      if (!openMention) return null;
      const result = await editMessage(openMention.channel.id, messageId, body);
      if (!result.ok) {
        toast.error(result.error || tThread("editFailed"));
        return null;
      }
      return result.message;
    },
    [openMention, tThread],
  );

  const handleRemoveMessage = useCallback(
    async (messageId: string): Promise<SembangMessage | null> => {
      if (!openMention) return null;
      const result = await removeMessage(openMention.channel.id, messageId);
      if (!result.ok) {
        toast.error(result.error || tThread("removeMessageFailed"));
        return null;
      }
      return result.message;
    },
    [openMention, tThread],
  );

  const handleAddToTask = useCallback(
    (message: SembangMessage) => {
      if (!openMention) return;
      void addMessageToTask(openMention.channel.id, message).then((result) => {
        if (!result.ok) toast.error(result.error || tThread("addToTasksFailed"));
        else toast.success(tThread("addedToTasks"));
      });
    },
    [openMention, tThread],
  );

  const handleReplyPosted = useCallback(() => {}, []);

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex h-full w-full min-w-0 flex-col border-r border-border sm:w-[360px] sm:shrink-0">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-3">
          <AtSign className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="font-heading text-sm font-medium text-foreground">{t("title")}</span>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {loading && !results ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : error ? (
            <p className="py-8 text-center text-sm text-destructive">{t("loadFailed")}</p>
          ) : !results || results.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            results.map((r) => (
              <div
                key={r.notificationId}
                className={cn(
                  "rounded-lg border p-2.5",
                  openMention?.notificationId === r.notificationId
                    ? "border-primary/40 bg-primary/5"
                    : "border-border hover:bg-muted/40",
                )}
              >
                <button
                  type="button"
                  onClick={() => setOpenMention(r)}
                  disabled={!r.message}
                  className="block w-full text-left disabled:cursor-default"
                >
                  {r.message ? (
                    <div className="flex items-start gap-2">
                      <PersonAvatar
                        name={r.message.author?.fullName}
                        avatarUrl={r.message.author?.avatarUrl}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="truncate text-xs font-semibold text-foreground">
                            {r.message.author?.fullName ?? t("unknownAuthor")}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {format(new Date(r.message.createdAt), "MMM d, HH:mm")}
                          </span>
                        </div>
                        <MessagePreview
                          body={r.message.body}
                          attachments={r.message.attachments}
                          peopleNames={peopleNames}
                        />
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("messageRemoved")}</p>
                  )}
                  <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                    {r.channel.isDm
                      ? r.channel.dmParticipantNames?.join(", ") || t("directMessage")
                      : `#${r.channel.name ?? ""}`}
                  </p>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1.5 h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
                  disabled={clearingId === r.notificationId}
                  onClick={() => handleClear(r)}
                >
                  {clearingId === r.notificationId ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {t("markDone")}
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      {openMention?.message ? (
        <ThreadPanel
          open
          onOpenChange={(next) => {
            if (!next) setOpenMention(null);
          }}
          channelId={openMention.channel.id}
          channelName={
            openMention.channel.isDm
              ? (openMention.channel.dmParticipantNames?.join(", ") ?? t("directMessage"))
              : (openMention.channel.name ?? "")
          }
          parentMessageId={openMention.message.parentMessageId ?? openMention.message.id}
          currentUserId={user?.id}
          peopleNames={peopleNames}
          canRemoveMessages={canRemoveMessages}
          pinnedMessageIds={EMPTY_PINNED_IDS}
          onReact={handleReact}
          onTogglePin={handleTogglePin}
          onToggleStar={handleToggleStar}
          onEditMessage={handleEditMessage}
          onRemoveMessage={handleRemoveMessage}
          onAddToTask={handleAddToTask}
          onReplyPosted={handleReplyPosted}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center bg-background px-6 text-center">
          <AtSign className="h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">{t("selectMentionHint")}</p>
        </div>
      )}
    </div>
  );
}
