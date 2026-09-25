"use client";

// One message row — shared by the main channel list (channel-thread.tsx)
// and the flat replies list in thread-panel.tsx, so the two stay visually
// and behaviourally identical instead of drifting. Owns: the reaction-pill
// row + "+" picker, hover actions (reply-in-thread, pin/unpin, add to
// tasks, edit/delete own, moderator remove), and inline edit mode.
//
// State ownership stays with the caller (channel-thread.tsx) — every
// mutation here goes through a callback prop so there is exactly one place
// that talks to the API and patches local state.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNowStrict } from "date-fns";
import {
  CornerUpRight,
  FileText,
  Loader2,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  PlusCircle,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { EmojiPicker } from "@/components/emoji/emoji-picker";
import { MessageBody } from "./message-body";
import { cn } from "@/lib/utils";
import type { SembangMessage, SembangReactionSummary } from "@/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Snippet length for the "replied to a thread" context line — same idea
 *  as channel-thread.tsx's `handleAddToTask` title truncation. */
function truncateSnippet(body: string, max = 60): string {
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

function ReactionRow({
  reactions,
  onReact,
}: {
  reactions: SembangReactionSummary[];
  onReact: (emoji: string) => void;
}) {
  const t = useTranslations("Sembang.thread");
  if (reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onReact(r.emoji)}
          title={t("reactedByCount", { count: r.count })}
          className={cn(
            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none",
            r.reactedByMe
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border bg-muted/40 text-foreground hover:bg-muted",
          )}
        >
          <span>{r.emoji}</span>
          <span>{r.count}</span>
        </button>
      ))}
    </div>
  );
}

export interface MessageRowProps {
  message: SembangMessage;
  currentUserId?: string;
  peopleNames: string[];
  isPinned: boolean;
  /** Moderator/admin of this channel — may remove someone else's message. */
  canRemoveOthers: boolean;
  /** Suppress "Reply in thread" and the "N replies" summary — used for the
   *  parent message already pinned at the top of an open thread panel. */
  disableThreadAffordances?: boolean;
  onReplyInThread?: (message: SembangMessage) => void;
  onOpenThread?: (message: SembangMessage) => void;
  /** Migration 101. Set only from the main channel list (never from an
   *  already-open thread panel's own reply list) — fired when the "↪
   *  replied to a thread" context line is clicked, to open the thread for
   *  the reply's PARENT (`message.parentPreview.id`), not the reply's own
   *  id. Only rendered when `message.parentPreview` is set — i.e. this row
   *  is a reply that was mixed into the main timeline via
   *  `alsoInChannel`. */
  onOpenParentThread?: (parentMessageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onTogglePin: (message: SembangMessage, pinned: boolean) => void;
  /** Migration 100. Same fire-and-forget shape as `onTogglePin` —
   *  `starredByMe` lives on the message itself, so the caller flips it
   *  optimistically and reverts on failure. */
  onToggleStar: (message: SembangMessage, starred: boolean) => void;
  /** Resolves to the updated message on success, null on failure — lets the
   *  row itself decide whether to leave edit mode. */
  onEdit: (messageId: string, body: string) => Promise<SembangMessage | null>;
  onRemove: (messageId: string) => void;
  onAddToTask?: (message: SembangMessage) => void;
}

export function MessageRow({
  message,
  currentUserId,
  peopleNames,
  isPinned,
  canRemoveOthers,
  disableThreadAffordances,
  onReplyInThread,
  onOpenThread,
  onOpenParentThread,
  onReact,
  onTogglePin,
  onToggleStar,
  onEdit,
  onRemove,
  onAddToTask,
}: MessageRowProps) {
  const t = useTranslations("Sembang.thread");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [saving, setSaving] = useState(false);

  const isDeleted = !!message.deletedAt;
  const isOwn = !!currentUserId && message.authorId === currentUserId;
  const isTopLevel = message.parentMessageId === null;
  const showThread = isTopLevel && !disableThreadAffordances;

  const startEdit = () => {
    setDraft(message.body);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(message.body);
  };
  const saveEdit = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === message.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const updated = await onEdit(message.id, trimmed);
    setSaving(false);
    if (updated) setEditing(false);
  };

  return (
    <div className="group flex gap-2.5 px-3 py-1.5 hover:bg-muted/30 sm:px-4">
      <PersonAvatar name={message.author?.fullName} avatarUrl={message.author?.avatarUrl} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {message.parentPreview && onOpenParentThread && (
          <button
            type="button"
            onClick={() => onOpenParentThread(message.parentPreview!.id)}
            className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            <CornerUpRight className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">
              {t("repliedToThread", {
                author: message.parentPreview.authorName,
                snippet: truncateSnippet(message.parentPreview.body),
              })}
            </span>
          </button>
        )}
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {message.author?.fullName ?? t("unknownAuthor")}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{format(new Date(message.createdAt), "HH:mm")}</span>
          {message.editedAt && !isDeleted && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{t("edited")}</span>
          )}
        </div>

        {isDeleted ? (
          <p className="text-sm text-muted-foreground italic">{t("messageRemoved")}</p>
        ) : editing ? (
          <div className="mt-1 space-y-1.5">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              aria-label={t("edit")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === "Escape") {
                  cancelEdit();
                }
              }}
              className="w-full resize-y rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
            />
            <div className="flex gap-1.5">
              <Button size="sm" onClick={saveEdit} disabled={saving || !draft.trim()}>
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                {t("editSave")}
              </Button>
              <Button size="sm" variant="outline" onClick={cancelEdit}>
                {t("editCancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {message.body && <MessageBody body={message.body} peopleNames={peopleNames} />}
            {message.attachments.length > 0 && (
              <div className="mt-1 flex flex-col gap-1">
                {message.attachments.map((a) =>
                  a.mimeType?.startsWith("audio/") ? (
                    <audio key={a.id} src={a.url} controls className="h-10 max-w-72" />
                  ) : (
                    <a
                      key={a.id}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex w-fit items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-foreground hover:bg-muted"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="max-w-56 truncate">{a.filename}</span>
                      <span className="text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
                    </a>
                  ),
                )}
              </div>
            )}
            <ReactionRow reactions={message.reactions} onReact={(emoji) => onReact(message.id, emoji)} />
            {showThread && (message.replyCount ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => onOpenThread?.(message)}
                className="-ml-2 mt-1.5 flex items-center gap-1 rounded-md bg-primary/5 px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
              >
                <MessageSquareText className="h-3 w-3" aria-hidden />
                {t("replyCount", { count: message.replyCount ?? 0 })}
                {message.lastReplyAt && (
                  <span className="font-normal text-muted-foreground">
                    · {t("lastReply", { time: formatDistanceToNowStrict(new Date(message.lastReplyAt), { addSuffix: true }) })}
                  </span>
                )}
              </button>
            )}
          </>
        )}
      </div>

      {!isDeleted && !editing && (
        <div className="flex shrink-0 items-start gap-0.5 self-start">
          {showThread && onReplyInThread && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("replyInThread")}
              title={t("replyInThread")}
              onClick={() => onReplyInThread(message)}
            >
              <MessageSquareText className="h-3.5 w-3.5" />
            </Button>
          )}
          <EmojiPicker onPick={(emoji) => onReact(message.id, emoji)} className="h-7 w-7" iconClassName="h-3.5 w-3.5" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={isPinned ? t("unpin") : t("pin")}
            title={isPinned ? t("unpin") : t("pin")}
            onClick={() => onTogglePin(message, isPinned)}
          >
            {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={message.starredByMe ? t("unstar") : t("star")}
            title={message.starredByMe ? t("unstar") : t("star")}
            onClick={() => onToggleStar(message, message.starredByMe)}
          >
            <Star
              className={cn(
                "h-3.5 w-3.5",
                message.starredByMe && "fill-current text-amber-500",
              )}
            />
          </Button>
          {onAddToTask && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("addToTasks")}
              title={t("addToTasks")}
              onClick={() => onAddToTask(message)}
            >
              <PlusCircle className="h-3.5 w-3.5" />
            </Button>
          )}
          {isOwn ? (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={t("edit")} title={t("edit")} onClick={startEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("deleteOwn")}
                title={t("deleteOwn")}
                onClick={() => onRemove(message.id)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            canRemoveOthers && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("removeMessage")}
                title={t("removeMessage")}
                onClick={() => onRemove(message.id)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}
