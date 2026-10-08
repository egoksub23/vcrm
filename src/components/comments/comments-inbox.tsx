"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Loader2, MessageCircleMore, RefreshCw, Search } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { COMMENT_PROVIDERS, type CommentPost, type CommentProvider, type CommentRow } from "@/lib/comments/types";
import { POST_VIEWS, readFlatPref, showUnread, writeFlatPref, type InboxPost, type PostView } from "@/lib/comments/threads";
import type { InboxTab } from "@/lib/inbox/channel-scope";
import { InboxTabBar } from "@/components/inbox/inbox-tab-bar";
import { Button } from "@/components/ui/button";

import { chip, TONE } from "./chips";
import { CommentDetail } from "./comment-detail";
import { CommentPostRow } from "./post-row";
import { PostThread } from "./post-thread";
import { PROVIDER_ICONS, PROVIDER_NAMES } from "./provider-icons";

type ListRow = CommentRow & { post: CommentPost | null };

/** localStorage can throw (blocked, private window): treat that as "no storage". */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The Comments tab of the inbox: public comments on Facebook, Instagram and TikTok posts.
 *
 * Grouped by post (the default): the left column has ONE row per post, and the right pane is the whole conversation under the selected post.
 * "Flat list" shows the older view instead: one row per comment, with the single comment opened on the right.
 * Both update live.
 */
export function CommentsInbox({
  unread,
  onTabChange,
  onCountChange,
  initialCommentId = null,
}: {
  unread: Record<InboxTab, number>;
  onTabChange: (tab: InboxTab) => void;
  /** The open-comment count changed: refresh the tab bubble. */
  onCountChange: () => void;
  /** Open this comment (a link to it): its post's thread, scrolled to and outlining it. */
  initialCommentId?: string | null;
}) {
  const t = useTranslations("Comments");
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const canWrite = useCapability("comments.moderate");

  const [view, setView] = useState<PostView>("open");
  const [provider, setProvider] = useState<CommentProvider | "">("");
  const [q, setQ] = useState("");
  const [flat, setFlat] = useState(false);
  const [prefReady, setPrefReady] = useState(false);
  const [posts, setPosts] = useState<InboxPost[]>([]);
  const [rows, setRows] = useState<ListRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const openedLink = useRef<string | null>(null);

  // The flat-list choice is remembered per person on this device. Read after mount so the server and the first client render agree.
  useEffect(() => {
    setFlat(readFlatPref(browserStorage(), userId));
    setPrefReady(true);
  }, [userId]);

  function chooseFlat(next: boolean) {
    setFlat(next);
    writeFlatPref(browserStorage(), next, userId);
    setSelectedId(null);
    setSelectedPostId(null);
    setHighlightId(null);
  }

  const buildUrl = useCallback(
    (more?: { offset?: number; before?: string }) => {
      const p = new URLSearchParams({ view });
      if (provider) p.set("provider", provider);
      if (q.trim()) p.set("q", q.trim());
      if (flat) {
        if (more?.before) p.set("before", more.before);
        return `/api/comments?${p}`;
      }
      if (more?.offset) p.set("offset", String(more.offset));
      return `/api/comments/posts?${p}`;
    },
    [view, provider, q, flat],
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch(buildUrl(), { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) {
        toast.error(data.error ?? t("loadFailed"));
        return;
      }
      if (flat) setRows(data.comments ?? []);
      else setPosts(data.posts ?? []);
      setHasMore(!!data.has_more);
    } catch {
      if (mine === seq.current) toast.error(t("loadFailed"));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [buildUrl, flat, t]);

  // Reload whenever the filters change (search is debounced).
  useEffect(() => {
    if (!prefReady) return;
    setLoading(true);
    const timer = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q, prefReady]);

  // Live updates: any change to a comment refreshes the list, the open thread and the count.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`comments-${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "comments", filter: `account_id=eq.${accountId}` },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void load();
            setTick((n) => n + 1);
            onCountChange();
          }, 400);
        },
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [accountId, load, onCountChange]);

  // A link to one comment: open its post's thread scrolled to it (or, in the flat list, the comment itself).
  useEffect(() => {
    if (!initialCommentId || !prefReady || openedLink.current === initialCommentId) return;
    openedLink.current = initialCommentId;
    void (async () => {
      try {
        const res = await fetch(`/api/comments/${initialCommentId}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.comment) {
          toast.error(data.error ?? t("loadFailed"));
          return;
        }
        if (flat) setSelectedId(initialCommentId);
        else {
          setSelectedPostId(data.comment.post_id as string);
          setHighlightId(initialCommentId);
        }
      } catch {
        toast.error(t("loadFailed"));
      }
    })();
  }, [initialCommentId, prefReady, flat, t]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      let url: string;
      if (flat) {
        const last = rows[rows.length - 1];
        if (!last) return;
        url = buildUrl({ before: last.provider_created_at });
      } else {
        url = buildUrl({ offset: posts.length });
      }
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (flat) setRows((prev) => [...prev, ...(data.comments ?? [])]);
        else {
          // A post that moved while paging could appear twice: keep the first.
          setPosts((prev) => {
            const have = new Set(prev.map((p) => p.post_id));
            return [...prev, ...((data.posts ?? []) as InboxPost[]).filter((p) => !have.has(p.post_id))];
          });
        }
        setHasMore(!!data.has_more);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/comments/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("syncFailed"));
        return;
      }
      toast.success(t("synced", { count: data.newComments ?? 0 }));
      void load();
      setTick((n) => n + 1);
      onCountChange();
    } catch {
      toast.error(t("syncFailed"));
    } finally {
      setSyncing(false);
    }
  }

  const changed = useCallback(() => {
    void load();
    onCountChange();
  }, [load, onCountChange]);

  const postSeen = useCallback((postId: string) => {
    setPosts((prev) => prev.map((p) => (p.post_id === postId && p.unread ? { ...p, unread: false } : p)));
  }, []);

  const hasDetail = flat ? !!selectedId : !!selectedPostId;
  const count = flat ? rows.length : posts.length;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* List */}
      <div
        className={cn(
          "flex h-full w-full flex-col border-r border-border bg-card lg:w-96 lg:flex-none xl:w-[28rem]",
          hasDetail ? "hidden lg:flex" : "flex",
        )}
      >
        <InboxTabBar tab="comments" onTabClick={onTabChange} unread={unread} />

        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchPlaceholder")}
                className="h-8 w-full rounded-md border border-border bg-muted pl-8 pr-2 text-sm text-foreground outline-none focus:border-primary/50"
              />
            </div>
            {canWrite && (
              <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => void sync()} disabled={syncing} title={t("syncHint")}>
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {POST_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                title={t(`viewHelp.${v}`)}
                aria-pressed={view === v}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  view === v ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`view.${v}`)}
              </button>
            ))}
          </div>
          {!flat && <p className="text-[11px] leading-snug text-muted-foreground">{t(`viewHelp.${view}`)}</p>}
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setProvider("")}
                className={cn(
                  "rounded-md px-2 py-1 text-xs",
                  provider === "" ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("allSources")}
              </button>
              {COMMENT_PROVIDERS.map((p) => {
                const Icon = PROVIDER_ICONS[p];
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProvider(provider === p ? "" : p)}
                    title={PROVIDER_NAMES[p]}
                    aria-label={PROVIDER_NAMES[p]}
                    aria-pressed={provider === p}
                    className={cn("rounded-md p-1.5 transition-opacity", provider === p ? "bg-muted" : "opacity-60 hover:opacity-100")}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={flat}
              onClick={() => chooseFlat(!flat)}
              title={t("flatListHint")}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <span
                aria-hidden
                className={cn("relative inline-block h-4 w-7 rounded-full transition-colors", flat ? "bg-primary" : "bg-border")}
              >
                <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all", flat ? "left-3.5" : "left-0.5")} />
              </span>
              {t("flatList")}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : count === 0 ? (
            <div className="px-6 py-12 text-center">
              <MessageCircleMore className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium text-foreground">{t(view === "open" ? "emptyOpenTitle" : "emptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("emptyBody")}</p>
            </div>
          ) : flat ? (
            <ul>
              {rows.map((c) => {
                const Icon = PROVIDER_ICONS[c.provider];
                const active = c.id === selectedId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        "flex w-full gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                        active && "bg-muted",
                      )}
                    >
                      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-label={PROVIDER_NAMES[c.provider]} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={cn("truncate text-sm", c.handled_status === "open" ? "font-semibold text-foreground" : "text-foreground")}>
                            {c.author_name || c.author_username || t("unknownAuthor")}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatDistanceToNow(new Date(c.provider_created_at), { addSuffix: false })}
                          </span>
                        </div>
                        <p className="line-clamp-2 break-words text-xs text-muted-foreground">{c.text || t("attachment")}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {c.post?.source === "ad" && <span className={cn(chip, TONE.warn)}>{t("adPost")}</span>}
                          {c.status === "hidden" && <span className={cn(chip, TONE.muted)}>{t("hidden")}</span>}
                          {c.status === "deleted" && <span className={cn(chip, TONE.danger)}>{t("deleted")}</span>}
                          {c.handled_status === "replied" && <span className={cn(chip, TONE.ok)}>{t("replied")}</span>}
                          {c.handled_status === "resolved" && <span className={cn(chip, TONE.ok)}>{t("resolved")}</span>}
                          {c.is_test && <span className={cn(chip, TONE.sample)}>{t("sample")}</span>}
                          {c.post?.message && (
                            <span className="min-w-0 max-w-full truncate text-[10px] text-muted-foreground">{c.post.message}</span>
                          )}
                        </div>
                      </div>
                      {c.handled_status === "open" && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul>
              {posts.map((p) => (
                <li key={p.post_id}>
                  <CommentPostRow
                    post={p}
                    active={p.post_id === selectedPostId}
                    unread={showUnread(p, selectedPostId)}
                    onSelect={(id) => {
                      setSelectedPostId(id);
                      setHighlightId(null);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          {hasMore && !loading && (
            <div className="p-3 text-center">
              <Button size="sm" variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t("loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Detail */}
      <div className={cn("min-w-0 flex-1 lg:flex", hasDetail ? "flex" : "hidden")}>
        {flat && selectedId ? (
          <CommentDetail commentId={selectedId} onBack={() => setSelectedId(null)} onChanged={changed} />
        ) : !flat && selectedPostId ? (
          <PostThread
            key={selectedPostId}
            postId={selectedPostId}
            highlightCommentId={highlightId}
            refreshTick={tick}
            onBack={() => setSelectedPostId(null)}
            onChanged={changed}
            onSeen={postSeen}
          />
        ) : (
          <div className="hidden h-full flex-1 flex-col items-center justify-center gap-2 text-center lg:flex">
            <MessageCircleMore className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t(flat ? "selectPrompt" : "selectPostPrompt")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
