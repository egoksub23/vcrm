"use client";

// Thread column — a real sibling pane next to the channel view (Slack's
// layout), NOT a Sheet/dialog: no portal, no backdrop, nothing floats over
// the rest of the app. Renders `null` while closed; channel-thread.tsx lays
// it out as a `shrink-0` flex sibling alongside the main channel column.
// Shows the parent message pinned at the top (bordered/dim background),
// the flat list of replies below it, then a MessageComposer that posts
// with `parentMessageId` set. Owns its own fetch of
// GET .../messages/[messageId]/replies and its own realtime subscription
// (a second `useSembangChannelRealtime` for the same channel, disambiguated
// with `topicSuffix: "thread"` so it doesn't collide with
// channel-thread.tsx's own subscription).
//
// Reactions/edit/remove are NOT handled locally — they're single-sourced
// in channel-thread.tsx (so the same message's state agrees whether it's
// shown in the main list or in an open thread) and passed down as
// callbacks that resolve to the updated message/reactions, which this
// panel then patches into its own `parent`/`replies` state.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSembangChannelRealtime } from "@/hooks/use-sembang-realtime";
import { MessageComposer, type MessageComposerHandle, type PendingSembangAttachment } from "./message-composer";
import { MessageRow } from "./message-row";
import type { SembangMessage, SembangReactionSummary } from "@/types";

interface ThreadPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  channelName: string;
  /** The top-level message being threaded on. Null while closed. */
  parentMessageId: string | null;
  currentUserId?: string;
  peopleNames: string[];
  canRemoveMessages: boolean;
  pinnedMessageIds: Set<string>;
  onReact: (messageId: string, emoji: string) => Promise<SembangReactionSummary[] | null>;
  onTogglePin: (message: SembangMessage, pinned: boolean) => void;
  /** Migration 100. Unlike `onTogglePin` (whose pinned/unpinned state is
   *  derived from a `pinnedMessageIds` prop shared with the caller),
   *  `starredByMe` lives on the message object itself — this panel holds
   *  its own `parent`/`replies` copies fetched separately from the main
   *  list, so the wrapper below (mirroring `handleReact`) patches both
   *  local trees after calling through to the caller's handler. */
  onToggleStar: (message: SembangMessage, starred: boolean) => void;
  onEditMessage: (messageId: string, body: string) => Promise<SembangMessage | null>;
  onRemoveMessage: (messageId: string) => Promise<SembangMessage | null>;
  onAddToTask: (message: SembangMessage) => void;
  /** Bumps the parent's replyCount/lastReplyAt in the main channel list —
   *  realtime skips self-authored inserts (mirroring the main list's own
   *  "our own sends are appended locally" convention), so this is what
   *  keeps the "N replies" affordance live for the sender's own reply. */
  onReplyPosted: (parentId: string, reply: SembangMessage) => void;
}

export function ThreadPanel({
  open,
  onOpenChange,
  channelId,
  channelName,
  parentMessageId,
  currentUserId,
  peopleNames,
  canRemoveMessages,
  pinnedMessageIds,
  onReact,
  onTogglePin,
  onToggleStar,
  onEditMessage,
  onRemoveMessage,
  onAddToTask,
  onReplyPosted,
}: ThreadPanelProps) {
  const t = useTranslations("Sembang.threadPanel");
  const tThread = useTranslations("Sembang.thread");

  const [parent, setParent] = useState<SembangMessage | null>(null);
  const [replies, setReplies] = useState<SembangMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const composerRef = useRef<MessageComposerHandle>(null);

  const fetchReplies = useCallback(async () => {
    if (!channelId || !parentMessageId) return;
    const res = await fetch(`/api/sembang/channels/${channelId}/messages/${parentMessageId}/replies`, {
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setParent((data.parent as SembangMessage) ?? null);
    setReplies((data.replies as SembangMessage[]) ?? []);
  }, [channelId, parentMessageId]);

  useEffect(() => {
    if (!open || !parentMessageId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setParent(null);
      setReplies([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchReplies()
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, parentMessageId, fetchReplies]);

  useSembangChannelRealtime({
    channelId: open ? channelId : null,
    topicSuffix: "thread",
    onMessageEvent: (event) => {
      if (!parentMessageId) return;
      const row = event.new;
      if (event.eventType === "INSERT") {
        if (row.parent_message_id !== parentMessageId) return;
        if (row.author_id === currentUserId) return; // appended optimistically already
        void fetchReplies().catch(() => {});
      } else if (event.eventType === "UPDATE") {
        if (row.id === parentMessageId) {
          setParent((p) =>
            p ? { ...p, body: row.body, editedAt: row.edited_at ?? p.editedAt, deletedAt: row.deleted_at, deletedBy: row.deleted_by } : p,
          );
        } else if (row.parent_message_id === parentMessageId) {
          setReplies((prev) =>
            prev.map((r) =>
              r.id === row.id
                ? { ...r, body: row.body, editedAt: row.edited_at ?? r.editedAt, deletedAt: row.deleted_at, deletedBy: row.deleted_by }
                : r,
            ),
          );
        }
      }
    },
  });

  const handleSendReply = useCallback(
    async (
      body: string,
      mentions: string[],
      attachments: PendingSembangAttachment[],
      replyToId?: string,
      alsoInChannel?: boolean,
    ): Promise<boolean> => {
      if (!channelId || !replyToId) return false;
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body,
            mentions,
            attachments: attachments.length > 0 ? attachments : undefined,
            parentMessageId: replyToId,
            alsoInChannel,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data?.error || tThread("sendFailed"));
          return false;
        }
        const message = data.message as SembangMessage | undefined;
        if (message) {
          setReplies((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
          onReplyPosted(replyToId, message);
        }
        return true;
      } catch {
        toast.error(tThread("sendFailed"));
        return false;
      }
    },
    [channelId, tThread, onReplyPosted],
  );

  const handleReact = useCallback(
    async (messageId: string, emoji: string) => {
      const reactions = await onReact(messageId, emoji);
      if (!reactions) return;
      setParent((p) => (p && p.id === messageId ? { ...p, reactions } : p));
      setReplies((prev) => prev.map((r) => (r.id === messageId ? { ...r, reactions } : r)));
    },
    [onReact],
  );

  const handleToggleStar = useCallback(
    (message: SembangMessage, starred: boolean) => {
      onToggleStar(message, starred);
      const nextStarred = !starred;
      setParent((p) => (p && p.id === message.id ? { ...p, starredByMe: nextStarred } : p));
      setReplies((prev) =>
        prev.map((r) => (r.id === message.id ? { ...r, starredByMe: nextStarred } : r)),
      );
    },
    [onToggleStar],
  );

  const handleEdit = useCallback(
    async (messageId: string, body: string): Promise<SembangMessage | null> => {
      const updated = await onEditMessage(messageId, body);
      if (!updated) return null;
      setParent((p) => (p && p.id === messageId ? updated : p));
      setReplies((prev) => prev.map((r) => (r.id === messageId ? updated : r)));
      return updated;
    },
    [onEditMessage],
  );

  const handleQuoteReply = useCallback(
    (message: SembangMessage) => {
      // A voice note / file-only message has no body (same fallback
      // MessagePreview uses elsewhere) — the quote still needs SOME text.
      const first = message.attachments[0];
      const body =
        message.body ||
        (first ? (first.mimeType?.startsWith("audio/") ? tThread("voiceMessage") : first.filename) : "");
      composerRef.current?.insertQuote(message.author?.fullName ?? tThread("unknownAuthor"), body);
    },
    [tThread],
  );

  const handleRemove = useCallback(
    async (messageId: string) => {
      const updated = await onRemoveMessage(messageId);
      if (!updated) return;
      setParent((p) => (p && p.id === messageId ? updated : p));
      setReplies((prev) => prev.map((r) => (r.id === messageId ? updated : r)));
    },
    [onRemoveMessage],
  );

  if (!open) return null;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full shrink-0 flex-col border-border bg-background",
        "border-l sm:w-[460px] lg:w-[540px] xl:w-[620px]",
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-heading text-base font-medium text-foreground">{t("title")}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("closeAriaLabel")}
          title={t("closeAriaLabel")}
          onClick={() => onOpenChange(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {loading && !parent ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-4">
            <p className="text-sm text-destructive">{t("loadFailed")}</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              {parent && (
                <div className="mx-3 mt-1 mb-2 rounded-lg border border-border bg-muted/30">
                  <MessageRow
                    message={parent}
                    currentUserId={currentUserId}
                    peopleNames={peopleNames}
                    isPinned={pinnedMessageIds.has(parent.id)}
                    canRemoveOthers={canRemoveMessages}
                    disableThreadAffordances
                    onQuoteReply={handleQuoteReply}
                    onReact={handleReact}
                    onTogglePin={onTogglePin}
                    onToggleStar={handleToggleStar}
                    onEdit={handleEdit}
                    onRemove={handleRemove}
                    onAddToTask={onAddToTask}
                  />
                </div>
              )}
              <div className="border-t border-border pt-1">
                {replies.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("noReplies")}</p>
                ) : (
                  replies.map((reply) => (
                    <MessageRow
                      key={reply.id}
                      message={reply}
                      currentUserId={currentUserId}
                      peopleNames={peopleNames}
                      isPinned={pinnedMessageIds.has(reply.id)}
                      canRemoveOthers={canRemoveMessages}
                      onQuoteReply={handleQuoteReply}
                      onReact={handleReact}
                      onTogglePin={onTogglePin}
                      onToggleStar={handleToggleStar}
                      onEdit={handleEdit}
                      onRemove={handleRemove}
                      onAddToTask={onAddToTask}
                    />
                  ))
                )}
              </div>
            </div>

            {parentMessageId && (
              <MessageComposer
                ref={composerRef}
                channelId={channelId}
                channelName={channelName}
                onSend={handleSendReply}
                parentMessageId={parentMessageId}
                showAlsoInChannelOption
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
