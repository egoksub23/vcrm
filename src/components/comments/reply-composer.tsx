"use client";

import { forwardRef } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Send, X } from "lucide-react";

import { REPLY_MAX_CHARS } from "@/lib/comments/types";
import type { ReplyMode, ThreadComment } from "@/lib/comments/threads";
import { Button } from "@/components/ui/button";
import { EmojiTextarea } from "@/components/emoji/emoji-textarea";

export interface ResolvedTarget {
  comment: ThreadComment;
  mode: ReplyMode;
  label: string;
  snippet: string;
  allowed: boolean;
}

const PRIVATE_MAX = 1000;

/**
 * The reply box at the bottom of a post. It says who it is answering ("Replying to ayakorose645: nice one") and answers that one comment;
 * clicking another comment's Reply moves it, Esc or the cross clears it. A private message uses the same box.
 */
export const ReplyComposer = forwardRef<
  HTMLTextAreaElement,
  {
    target: ResolvedTarget | null;
    text: string;
    onText: (v: string) => void;
    onSend: () => void;
    onCancel: () => void;
    sending: boolean;
  }
>(function ReplyComposer({ target, text, onText, onSend, onCancel, sending }, ref) {
  const t = useTranslations("Comments");
  const mode: ReplyMode = target?.mode ?? "reply";
  const max = target ? (mode === "reply" ? REPLY_MAX_CHARS[target.comment.provider] : PRIVATE_MAX) : 0;
  const allowed = !!target?.allowed;
  const reasonKey = target && !target.allowed ? target.comment.capabilities.reasons[mode === "reply" ? "reply" : "private_reply"] : undefined;

  return (
    <div className="shrink-0 space-y-2 border-t border-border bg-card p-3" data-reply-composer>
      {target ? (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {t(mode === "reply" ? "replyingTo" : "privateTo", { author: target.label || t("unknownAuthor"), snippet: target.snippet || "…" })}
            </span>
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("cancelReply")}
            title={t("cancelReply")}
          >
            <X className="h-3 w-3" />
            {t("cancelReply")}
          </button>
        </div>
      ) : (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{t("chooseComment")}</p>
      )}

      {target && !allowed && (
        <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          {reasonKey ? t(`reason.${reasonKey}`) : t("actionUnavailable")}
        </p>
      )}

      {target && allowed && (
        <div className="flex gap-2">
          <EmojiTextarea
            ref={ref}
            containerClassName="flex-1"
            value={text}
            onValueChange={onText}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onSend();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            maxLength={max}
            rows={3}
            placeholder={mode === "reply" ? t("replyPlaceholder") : t("privatePlaceholder")}
            aria-label={mode === "reply" ? t("replyPublic") : t("replyPrivate")}
            className="min-h-[4.5rem] resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
          <div className="flex flex-col justify-between">
            <Button onClick={onSend} disabled={!text.trim() || sending} size="sm">
              {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
              {t("send")}
            </Button>
            <span className="text-right text-[10px] tabular-nums text-muted-foreground">
              {text.length}/{max}
            </span>
          </div>
        </div>
      )}
      {target && allowed && mode === "private_reply" && <p className="text-[11px] text-muted-foreground">{t("privateHint")}</p>}
    </div>
  );
});
