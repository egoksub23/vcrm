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
import type { InboxTab } from "@/lib/inbox/channel-scope";
import { InboxTabBar } from "@/components/inbox/inbox-tab-bar";
import { Button } from "@/components/ui/button";

import { CommentDetail } from "./comment-detail";
import { PROVIDER_ICONS, PROVIDER_NAMES } from "./provider-icons";

type View = "open" | "done" | "spam" | "all";
type ListRow = CommentRow & { post: CommentPost | null };

const chip = "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap";

/**
 * The Comments tab of the inbox: public comments on Facebook, Instagram
 * and TikTok posts, in a list on the left and the selected comment (its
 * post, thread and actions) on the right. Updates live.
 */
export function CommentsInbox({
  unread,
  onTabChange,
  onCountChange,
}: {
  unread: Record<InboxTab, number>;
  onTabChange: (tab: InboxTab) => void;
  /** The open-comment count changed: refresh the tab bubble. */
  onCountChange: () => void;
}) {
  const t = useTranslations("Comments");
  const { accountId } = useAuth();
  const canWrite = useCapability("comments.moderate");

  const [view, setView] = useState<View>("open");
  const [provider, setProvider] = useState<CommentProvider | "">("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ListRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const seq = useRef(0);

  const buildUrl = useCallback(
    (before?: string) => {
      const p = new URLSearchParams({ view });
      if (provider) p.set("provider", provider);
      if (q.trim()) p.set("q", q.trim());
      if (before) p.set("before", before);
      return `/api/comments?${p}`;
    },
    [view, provider, q],
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
      setRows(data.comments ?? []);
      setHasMore(!!data.has_more);
    } catch {
      if (mine === seq.current) toast.error(t("loadFailed"));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [buildUrl, t]);

  // Reload whenever the filters change (search is debounced).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const timer = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  // Live updates: any change to a comment refreshes the list and the count.
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

  async function loadMore() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(last.provider_created_at), { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRows((prev) => [...prev, ...(data.comments ?? [])]);
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

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* List */}
      <div
        className={cn(
          "flex h-full w-full flex-col border-r border-border bg-card lg:w-96 lg:flex-none xl:w-[28rem]",
          selectedId ? "hidden lg:flex" : "flex",
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
            {(["open", "done", "spam", "all"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  view === v ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`view.${v}`)}
              </button>
            ))}
          </div>
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
                  className={cn(
                    "rounded-md p-1.5 transition-opacity",
                    provider === p ? "bg-muted" : "opacity-60 hover:opacity-100",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <MessageCircleMore className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium text-foreground">{t(view === "open" ? "emptyOpenTitle" : "emptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("emptyBody")}</p>
            </div>
          ) : (
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
                          {c.post?.source === "ad" && <span className={cn(chip, "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>{t("adPost")}</span>}
                          {c.status === "hidden" && <span className={cn(chip, "bg-muted text-muted-foreground")}>{t("hidden")}</span>}
                          {c.status === "deleted" && <span className={cn(chip, "bg-destructive/15 text-destructive")}>{t("deleted")}</span>}
                          {c.handled_status === "replied" && <span className={cn(chip, "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400")}>{t("replied")}</span>}
                          {c.handled_status === "resolved" && <span className={cn(chip, "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400")}>{t("resolved")}</span>}
                          {c.is_test && <span className={cn(chip, "bg-violet-500/15 text-violet-600 dark:text-violet-400")}>{t("sample")}</span>}
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
      <div className={cn("min-w-0 flex-1 lg:flex", selectedId ? "flex" : "hidden")}>
        {selectedId ? (
          <CommentDetail commentId={selectedId} onBack={() => setSelectedId(null)} onChanged={changed} />
        ) : (
          <div className="hidden h-full flex-1 flex-col items-center justify-center gap-2 text-center lg:flex">
            <MessageCircleMore className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("selectPrompt")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
