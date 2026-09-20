"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  EyeOff,
  Eye,
  ExternalLink,
  Loader2,
  Megaphone,
  RotateCcw,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import { useCapability } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import {
  REPLY_MAX_CHARS,
  type CommentAction,
  type CommentCapabilities,
  type CommentHandled,
  type CommentPost,
  type CommentRow,
} from "@/lib/comments/types";
import { Button } from "@/components/ui/button";
import { EmojiTextarea } from "@/components/emoji/emoji-textarea";

import { PROVIDER_ICONS, PROVIDER_NAMES } from "./provider-icons";

interface Detail {
  comment: CommentRow & { post: CommentPost };
  thread: CommentRow[];
  actions: {
    id: string;
    action: CommentAction;
    text: string | null;
    status: "success" | "failed";
    error_message: string | null;
    created_at: string;
  }[];
  contact: { id: string; name: string | null; phone: string | null } | null;
  capabilities: CommentCapabilities;
}

const chip = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";

/**
 * One comment in full: the post it sits under, the thread, and the things
 * an agent can do — reply in public, send a private message, hide or
 * delete it, and mark it handled.
 */
export function CommentDetail({
  commentId,
  onBack,
  onChanged,
}: {
  commentId: string;
  onBack: () => void;
  /** Something changed (a reply, a status): refresh the list and count. */
  onChanged: () => void;
}) {
  const t = useTranslations("Comments");
  const canWrite = useCapability("comments.moderate");
  // Deleting a comment: comments.delete (admin+ by default).
  const isAdmin = useCapability("comments.delete");

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"reply" | "private_reply">("reply");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/comments/${commentId}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDetail(data as Detail);
      else toast.error(data.error ?? t("loadFailed"));
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [commentId, t]);

  // A different comment starts clean.
  useEffect(() => {
    setLoading(true);
    setDetail(null);
    setText("");
    setMode("reply");
    void load();
  }, [load]);

  async function run(action: CommentAction, body?: string): Promise<boolean> {
    setBusy(action);
    try {
      const res = await fetch(`/api/comments/${commentId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("actionFailed"));
        return false;
      }
      await load();
      onChanged();
      return true;
    } catch {
      toast.error(t("actionFailed"));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function setHandled(handled: CommentHandled) {
    setBusy(`handled:${handled}`);
    try {
      const res = await fetch(`/api/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handled_status: handled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t("actionFailed"));
        return;
      }
      await load();
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    const ok = await run(mode, body);
    if (ok) {
      setText("");
      toast.success(mode === "reply" ? t("replySent") : t("privateReplySent"));
    }
  }

  if (loading || !detail) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  const { comment, thread, actions, contact, capabilities: caps } = detail;
  const post = comment.post;
  const Icon = PROVIDER_ICONS[comment.provider];
  const max = mode === "reply" ? REPLY_MAX_CHARS[comment.provider] : 1000;
  const modeAllowed = mode === "reply" ? caps.reply : caps.privateReply;
  const modeReason = caps.reasons[mode];
  const handled = comment.handled_status;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          aria-label={t("back")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Icon className="h-5 w-5 shrink-0" aria-label={PROVIDER_NAMES[comment.provider]} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {comment.author_name || comment.author_username || t("unknownAuthor")}
            {comment.author_username && comment.author_username !== comment.author_name ? (
              <span className="ml-1.5 font-normal text-muted-foreground">@{comment.author_username}</span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {PROVIDER_NAMES[comment.provider]}
            {post.source === "ad" ? ` · ${t("adPost")}` : ""}
            {" · "}
            {format(new Date(comment.provider_created_at), "MMM d, yyyy HH:mm")}
            {contact ? ` · ${t("knownContact", { name: contact.name || contact.phone || "—" })}` : ""}
          </p>
        </div>
        {comment.is_test && <span className={cn(chip, "bg-violet-500/15 text-violet-600 dark:text-violet-400")}>{t("sample")}</span>}
        {comment.status === "hidden" && <span className={cn(chip, "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>{t("hidden")}</span>}
        {comment.status === "deleted" && <span className={cn(chip, "bg-destructive/15 text-destructive")}>{t("deleted")}</span>}
        {canWrite && (
          <div className="flex items-center gap-1.5">
            {handled === "resolved" || handled === "spam" ? (
              <Button size="sm" variant="outline" onClick={() => void setHandled("open")} disabled={!!busy}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                {t("reopen")}
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => void setHandled("resolved")} disabled={!!busy}>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  {t("markResolved")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void setHandled("spam")} disabled={!!busy} title={t("markSpamHint")}>
                  <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
                  {t("markSpam")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {/* The post */}
        <div className="flex gap-3 rounded-xl border border-border bg-card p-3">
          {post.media_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.media_url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted">
              {post.source === "ad" ? <Megaphone className="h-5 w-5 text-muted-foreground" /> : <Icon className="h-6 w-6" />}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("onThisPost")}</p>
            <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground">
              {post.message || t("noCaption")}
            </p>
            {post.permalink_url && (
              <a
                href={post.permalink_url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {t("viewPost")} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>

        {/* The thread */}
        <ul className="space-y-2">
          {thread.map((c) => {
            const own = c.direction === "outbound";
            const selected = c.id === comment.id;
            return (
              <li key={c.id} className={cn("flex", own ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm",
                    own ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                    selected && !own && "ring-2 ring-primary/40",
                    c.parent_comment_id && !own && "ml-6",
                  )}
                >
                  <p className={cn("text-[11px] font-medium", own ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {own ? t("you") : c.author_name || c.author_username || t("unknownAuthor")} ·{" "}
                    {formatDistanceToNow(new Date(c.provider_created_at), { addSuffix: true })}
                    {c.status === "hidden" ? ` · ${t("hidden")}` : ""}
                    {c.status === "deleted" ? ` · ${t("deleted")}` : ""}
                  </p>
                  <p className={cn("mt-0.5 whitespace-pre-wrap break-words", c.status === "deleted" && "line-through opacity-60")}>
                    {c.text || (c.attachment_url ? t("attachment") : "—")}
                  </p>
                  {c.attachment_url && (
                    <a href={c.attachment_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs underline">
                      {t("attachment")}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {actions.length > 0 && (
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("activity")}</p>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {actions.slice(0, 5).map((a) => (
                <li key={a.id}>
                  {t(`action.${a.action}`)} · {a.status === "success" ? t("succeeded") : `${t("failed")}: ${a.error_message ?? ""}`} ·{" "}
                  {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Actions */}
      {canWrite && comment.status !== "deleted" && (
        <div className="shrink-0 space-y-2 border-t border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs">
              {(["reply", "private_reply"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-medium transition-colors",
                    mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(m === "reply" ? "replyPublic" : "replyPrivate")}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {caps.hide && (
                <Button size="sm" variant="ghost" onClick={() => void run("hide")} disabled={!!busy}>
                  {busy === "hide" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <EyeOff className="mr-1.5 h-3.5 w-3.5" />}
                  {t("hide")}
                </Button>
              )}
              {caps.unhide && (
                <Button size="sm" variant="ghost" onClick={() => void run("unhide")} disabled={!!busy}>
                  {busy === "unhide" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}
                  {t("unhide")}
                </Button>
              )}
              {isAdmin && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={!!busy || !caps.delete}
                  title={!caps.delete && caps.reasons.delete ? t(`reason.${caps.reasons.delete}`) : t("delete")}
                  onClick={() => {
                    if (window.confirm(t("deleteConfirm"))) void run("delete");
                  }}
                >
                  {busy === "delete" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                  {t("delete")}
                </Button>
              )}
            </div>
          </div>

          {modeAllowed ? (
            <div className="flex gap-2">
              <EmojiTextarea
                containerClassName="flex-1"
                value={text}
                onValueChange={setText}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                maxLength={max}
                rows={3}
                placeholder={mode === "reply" ? t("replyPlaceholder") : t("privatePlaceholder")}
                aria-label={mode === "reply" ? t("replyPublic") : t("replyPrivate")}
                className="min-h-[4.5rem] resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
              />
              <div className="flex flex-col justify-between">
                <Button onClick={() => void send()} disabled={!text.trim() || !!busy} size="sm">
                  {busy === mode ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                  {t("send")}
                </Button>
                <span className="text-right text-[10px] tabular-nums text-muted-foreground">
                  {text.length}/{max}
                </span>
              </div>
            </div>
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
              {modeReason ? t(`reason.${modeReason}`) : t("actionUnavailable")}
            </p>
          )}
          {mode === "private_reply" && modeAllowed && (
            <p className="text-[11px] text-muted-foreground">{t("privateHint")}</p>
          )}
        </div>
      )}
    </div>
  );
}
