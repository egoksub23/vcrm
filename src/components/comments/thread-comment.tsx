"use client";

import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { CornerDownRight, Eye, EyeOff, Loader2, RotateCcw, ShieldAlert, Trash2, Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { authorLabel, type ThreadComment } from "@/lib/comments/threads";
import type { CommentHandled } from "@/lib/comments/types";
import { Button } from "@/components/ui/button";

import { chip, TONE } from "./chips";

export interface CommentItemHandlers {
  onToggleSelect: (id: string) => void;
  /** Aim the reply box at this comment: a public reply, or a private message. */
  onReply: (c: ThreadComment, mode: "reply" | "private_reply") => void;
  onVisibility: (c: ThreadComment, action: "hide" | "unhide") => void;
  onDelete: (c: ThreadComment) => void;
  onHandled: (c: ThreadComment, status: CommentHandled) => void;
}

const act = "h-7 gap-1 px-2 text-xs";

/**
 * One comment in the thread. A customer comment is a grey bubble with a tick box and its own actions; a comment from us (an agent or the
 * Page) is a coloured bubble on the right with no actions. A reply is indented under the comment it answers.
 */
export function ThreadCommentItem({
  comment: c,
  depth,
  isNew,
  highlighted,
  checked,
  targeted,
  orphan,
  canWrite,
  canDelete,
  busy,
  handlers,
}: {
  comment: ThreadComment;
  depth: number;
  isNew: boolean;
  highlighted: boolean;
  checked: boolean;
  /** The reply box is aimed at this comment. */
  targeted: boolean;
  /** A reply whose parent is not shown in this thread. */
  orphan: boolean;
  canWrite: boolean;
  canDelete: boolean;
  /** Something is running on this comment (a spinner on its buttons, buttons off). */
  busy: string | null;
  handlers: CommentItemHandlers;
}) {
  const t = useTranslations("Comments");
  const own = c.direction === "outbound";
  const caps = c.capabilities;
  const who = own ? t("you") : (authorLabel(c) ?? t("unknownAuthor"));
  const deleted = c.status === "deleted";
  const h = c.handled_status;
  const reasonFor = (a: "reply" | "private_reply") => {
    const r = caps.reasons[a];
    return r ? t(`reason.${r}`) : t("actionUnavailable");
  };
  const showTools = canWrite && !own && !deleted;

  return (
    <li
      id={`comment-${c.id}`}
      data-comment-id={c.id}
      className={cn("flex items-start gap-2", own ? "justify-end" : "justify-start", depth > 0 && "ml-6 sm:ml-8")}
    >
      {!own && canWrite && !deleted && (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => handlers.onToggleSelect(c.id)}
          aria-label={t("selectComment", { author: who })}
          className="mt-3 h-4 w-4 shrink-0 cursor-pointer accent-primary"
        />
      )}
      <div
        className={cn(
          "min-w-0 max-w-[88%] rounded-2xl px-3.5 py-2 text-sm",
          own ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          (highlighted || targeted) && !own && "ring-2 ring-primary/50",
          highlighted && "scroll-mt-4",
        )}
      >
        {orphan && (
          <p className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <CornerDownRight className="h-3 w-3" aria-hidden />
            {t("orphanReply")}
          </p>
        )}
        <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium", own ? "text-primary-foreground/80" : "text-muted-foreground")}>
          <span>{who}</span>
          {!own && c.author_username && c.author_username !== c.author_name ? <span className="font-normal">@{c.author_username}</span> : null}
          <span aria-hidden>·</span>
          <span className="font-normal">{formatDistanceToNow(new Date(c.provider_created_at), { addSuffix: true })}</span>
          {isNew && <span className={cn(chip, TONE.primary)}>{t("newDivider")}</span>}
          {c.is_test && <span className={cn(chip, TONE.sample)}>{t("sample")}</span>}
          {c.status === "hidden" && <span className={cn(chip, TONE.warn)}>{t("hidden")}</span>}
          {deleted && <span className={cn(chip, TONE.danger)}>{t("deleted")}</span>}
          {!own && h === "replied" && <span className={cn(chip, TONE.ok)}>{t("replied")}</span>}
          {!own && h === "resolved" && <span className={cn(chip, TONE.ok)}>{t("resolved")}</span>}
          {!own && h === "spam" && <span className={cn(chip, TONE.muted)}>{t("view.spam")}</span>}
        </p>
        <p className={cn("mt-0.5 whitespace-pre-wrap break-words", deleted && "line-through opacity-60")}>
          {c.text || (c.attachment_url ? t("attachment") : "—")}
        </p>
        {c.attachment_url && (
          <a href={c.attachment_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs underline">
            {t("attachment")}
          </a>
        )}

        {showTools && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant={targeted ? "default" : "outline"}
              className={act}
              disabled={!caps.reply || !!busy}
              title={caps.reply ? t("reply") : reasonFor("reply")}
              aria-label={caps.reply ? t("reply") : `${t("reply")}: ${reasonFor("reply")}`}
              onClick={() => handlers.onReply(c, "reply")}
            >
              <CornerDownRight className="h-3 w-3" />
              {t("reply")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={cn(act, "text-muted-foreground")}
              disabled={!caps.privateReply || !!busy}
              title={caps.privateReply ? t("replyPrivate") : reasonFor("private_reply")}
              aria-label={caps.privateReply ? t("privateReply") : `${t("privateReply")}: ${reasonFor("private_reply")}`}
              onClick={() => handlers.onReply(c, "private_reply")}
            >
              {t("privateReply")}
            </Button>
            {caps.hide && (
              <Button size="sm" variant="ghost" className={act} disabled={!!busy} onClick={() => handlers.onVisibility(c, "hide")}>
                {busy === "hide" ? <Loader2 className="h-3 w-3 animate-spin" /> : <EyeOff className="h-3 w-3" />}
                {t("hide")}
              </Button>
            )}
            {caps.unhide && (
              <Button size="sm" variant="ghost" className={act} disabled={!!busy} onClick={() => handlers.onVisibility(c, "unhide")}>
                {busy === "unhide" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                {t("unhide")}
              </Button>
            )}
            {h === "resolved" || h === "spam" ? (
              <Button size="sm" variant="ghost" className={act} disabled={!!busy} onClick={() => handlers.onHandled(c, "open")}>
                <RotateCcw className="h-3 w-3" />
                {t("reopen")}
              </Button>
            ) : (
              <>
                {h === "open" && (
                  <Button size="sm" variant="ghost" className={act} disabled={!!busy} onClick={() => handlers.onHandled(c, "resolved")}>
                    {busy === "handled:resolved" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    {t("markHandled")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" className={act} disabled={!!busy} title={t("markSpamHint")} onClick={() => handlers.onHandled(c, "spam")}>
                  <ShieldAlert className="h-3 w-3" />
                  {t("markSpam")}
                </Button>
              </>
            )}
            {canDelete && (
              <Button
                size="sm"
                variant="ghost"
                className={cn(act, "text-destructive hover:text-destructive")}
                disabled={!!busy || !caps.delete}
                title={!caps.delete && caps.reasons.delete ? t(`reason.${caps.reasons.delete}`) : t("delete")}
                onClick={() => handlers.onDelete(c)}
              >
                {busy === "delete" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                {t("delete")}
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
