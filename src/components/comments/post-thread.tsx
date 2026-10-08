"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { useCapability } from "@/hooks/use-can";
import {
  authorLabel,
  bulkTargets,
  chunk,
  newCommentIds,
  pruneSelection,
  selectableIds,
  snippet,
  summariseBulk,
  toggleId,
  type BulkOp,
  type BulkResult,
  type ReplyTarget,
  type ThreadComment,
  type ThreadPost,
} from "@/lib/comments/threads";
import type { CommentAction, CommentHandled } from "@/lib/comments/types";

import { PostThreadView, type ThreadFailure } from "./post-thread-view";

interface ThreadData {
  post: ThreadPost;
  comments: ThreadComment[];
  truncated: boolean;
  seen_at: string | null;
}

type GroupOp = Extract<BulkOp, "resolve" | "spam" | "hide">;

/**
 * The right pane for a selected post: every comment of the post as a conversation (oldest first, scrolled to the newest, or to the comment a link
 * pointed at), with per-comment actions, one reply box aimed at the comment you chose, group actions for a person with many open comments, and
 * multi-select with a bulk bar. Everything that changes a comment goes through the routes the single-comment view always used
 * (/api/comments/[id] for the handled status, /api/comments/[id]/action for replies, hide and delete) or /api/comments/bulk for several at once.
 * Mount it with key={postId}: a different post starts clean.
 */
export function PostThread({
  postId,
  highlightCommentId,
  refreshTick,
  onBack,
  onChanged,
  onSeen,
}: {
  postId: string;
  highlightCommentId: string | null;
  /** Bumped when the list heard that a comment changed: reload quietly. */
  refreshTick: number;
  onBack: () => void;
  /** Something changed (a reply, a status): refresh the list and the count. */
  onChanged: () => void;
  /** This post was opened: its dot is cleared. */
  onSeen: (postId: string) => void;
}) {
  const t = useTranslations("Comments");
  const canWrite = useCapability("comments.moderate");
  const canDelete = useCapability("comments.delete");

  const [data, setData] = useState<ThreadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [busyByComment, setBusyByComment] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [failures, setFailures] = useState<ThreadFailure[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);
  const knownIds = useRef<Set<string> | null>(null);
  const seenAtBefore = useRef<string | null>(null);
  const firstScrollDone = useRef(false);
  const stickToBottom = useRef(false);
  const lastCount = useRef(0);
  const lastTick = useRef(refreshTick);

  const markSeen = useCallback(async () => {
    try {
      const res = await fetch(`/api/comments/posts/${postId}/seen`, { method: "POST" });
      if (res.ok) onSeen(postId);
    } catch {
      // The dot clears on the next open instead.
    }
  }, [postId, onSeen]);

  const load = useCallback(
    async (silent: boolean): Promise<ThreadData | null> => {
      const mine = ++seq.current;
      try {
        const res = await fetch(`/api/comments/posts/${postId}`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (mine !== seq.current) return null;
        if (!res.ok) {
          if (!silent) toast.error(body.error ?? t("loadFailed"));
          return null;
        }
        const d = body as ThreadData;
        if (!silent) {
          // What was already here when the post was opened; anything that turns up later is "new".
          knownIds.current = new Set(d.comments.map((c) => c.id));
          seenAtBefore.current = d.seen_at;
        }
        const el = scrollRef.current;
        stickToBottom.current = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 240;
        setData(d);
        setNewIds(newCommentIds(d.comments, { seenAt: seenAtBefore.current, knownIds: knownIds.current }));
        return d;
      } catch {
        if (!silent && mine === seq.current) toast.error(t("loadFailed"));
        return null;
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [postId, t],
  );

  // Open: load, record that it was opened.
  useEffect(() => {
    void load(false).then((d) => {
      if (d) void markSeen();
    });
  }, [load, markSeen]);

  // The list heard that a comment changed: reload quietly; a live arrival is recorded as seen too, since the post is open.
  useEffect(() => {
    if (refreshTick === lastTick.current) return;
    lastTick.current = refreshTick;
    void load(true).then((d) => {
      if (d && d.comments.some((c) => knownIds.current && !knownIds.current.has(c.id) && c.direction === "inbound")) void markSeen();
    });
  }, [refreshTick, load, markSeen]);

  // Scroll: to the linked comment, or to the newest on open; follow a live arrival only when already near the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !data) return;
    if (!firstScrollDone.current) {
      firstScrollDone.current = true;
      lastCount.current = data.comments.length;
      const linked = highlightCommentId ? document.getElementById(`comment-${highlightCommentId}`) : null;
      if (linked) linked.scrollIntoView({ block: "center" });
      else el.scrollTop = el.scrollHeight;
      return;
    }
    if (data.comments.length > lastCount.current && stickToBottom.current) el.scrollTop = el.scrollHeight;
    lastCount.current = data.comments.length;
  }, [data, highlightCommentId]);

  // Ticks never outlive their comments (one was deleted, or the list changed under them).
  useEffect(() => {
    if (!data) return;
    setSelected((prev) => pruneSelection(prev, new Set(selectableIds(data.comments))));
  }, [data]);

  const comments = useMemo(() => data?.comments ?? [], [data]);
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);

  const afterChange = useCallback(async () => {
    await load(true);
    onChanged();
  }, [load, onChanged]);

  async function runAction(c: ThreadComment, action: CommentAction, body?: string): Promise<boolean> {
    setBusyByComment((m) => ({ ...m, [c.id]: action }));
    try {
      const res = await fetch(`/api/comments/${c.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text: body }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(out.error ?? t("actionFailed"));
        return false;
      }
      await afterChange();
      return true;
    } catch {
      toast.error(t("actionFailed"));
      return false;
    } finally {
      setBusyByComment((m) => {
        const next = { ...m };
        delete next[c.id];
        return next;
      });
    }
  }

  async function setHandled(c: ThreadComment, status: CommentHandled) {
    setBusyByComment((m) => ({ ...m, [c.id]: `handled:${status}` }));
    try {
      const res = await fetch(`/api/comments/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handled_status: status }),
      });
      if (!res.ok) {
        const out = await res.json().catch(() => ({}));
        toast.error(out.error ?? t("actionFailed"));
        return;
      }
      await afterChange();
    } finally {
      setBusyByComment((m) => {
        const next = { ...m };
        delete next[c.id];
        return next;
      });
    }
  }

  async function send() {
    const c = target ? byId.get(target.commentId) : undefined;
    const body = text.trim();
    if (!target || !c || !body || sending) return;
    setSending(true);
    try {
      const ok = await runAction(c, target.mode, body);
      if (ok) {
        setText("");
        setTarget(null);
        toast.success(target.mode === "reply" ? t("replySent") : t("privateReplySent"));
      }
    } finally {
      setSending(false);
    }
  }

  async function bulk(op: GroupOp, ids: string[]) {
    const picked = ids.map((id) => byId.get(id)).filter((c): c is ThreadComment => !!c);
    const { ids: send, skipped } = bulkTargets(op, picked);
    if (send.length === 0) {
      toast.message(t("bulkUpdated", { count: 0 }));
      setSelected(new Set());
      return;
    }
    setBulkBusy(true);
    setFailures([]);
    const results: BulkResult[] = [];
    try {
      for (const part of chunk(send)) {
        try {
          const res = await fetch("/api/comments/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op, ids: part }),
          });
          const out = await res.json().catch(() => ({}));
          if (res.ok && Array.isArray(out.results)) results.push(...(out.results as BulkResult[]));
          else results.push(...part.map((id) => ({ id, ok: false, error: out.error ?? t("actionFailed") })));
        } catch {
          results.push(...part.map((id) => ({ id, ok: false, error: t("actionFailed") })));
        }
      }
      const summary = summariseBulk(results);
      setFailures(
        summary.failed.map((f) => {
          const c = byId.get(f.id);
          return {
            id: f.id,
            who: (c && authorLabel(c)) || t("unknownAuthor"),
            text: snippet(c?.text, 50),
            error: f.error ?? t("actionFailed"),
          };
        }),
      );
      const left = skipped.length + summary.skipped;
      const message = left > 0 ? `${t("bulkUpdated", { count: summary.done })} · ${t("bulkLeftAsIs", { count: left })}` : t("bulkUpdated", { count: summary.done });
      if (summary.failed.length > 0) toast.error(`${message} · ${t("bulkFailedTitle", { count: summary.failed.length })}`);
      else toast.success(message);
      setSelected(new Set());
    } finally {
      setBulkBusy(false);
      await afterChange();
    }
  }

  const aim = useCallback((c: ThreadComment, mode: "reply" | "private_reply") => {
    setTarget({ commentId: c.id, mode });
    setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  if (loading || !data) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-w-0 flex-1"
      onKeyDown={(e) => {
        // Esc clears the reply target (the box inside also handles it, this covers focus being elsewhere in the thread).
        if (e.key === "Escape" && target) setTarget(null);
      }}
    >
      <PostThreadView
        ref={scrollRef}
        composerRef={composerRef}
        post={data.post}
        comments={comments}
        truncated={data.truncated}
        newIds={newIds}
        highlightId={highlightCommentId}
        selected={selected}
        target={target}
        text={text}
        busyByComment={busyByComment}
        bulkBusy={bulkBusy}
        sending={sending}
        canWrite={canWrite}
        canDelete={canDelete}
        failures={failures}
        onBack={onBack}
        onText={setText}
        onSend={() => void send()}
        onCancelReply={() => setTarget(null)}
        onClearSelection={() => setSelected(new Set())}
        onBulk={(op, ids) => void bulk(op, ids)}
        onDismissFailures={() => setFailures([])}
        handlers={{
          onToggleSelect: (id) => setSelected((prev) => toggleId(prev, id)),
          onReply: aim,
          onVisibility: (c, action) => void runAction(c, action),
          onDelete: (c) => {
            if (window.confirm(t("deleteConfirm"))) void runAction(c, "delete");
          },
          onHandled: (c, status) => void setHandled(c, status),
        }}
      />
    </div>
  );
}
