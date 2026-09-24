"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Hash, Lock, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SembangChannelSummary } from "@/types";

interface ChannelListProps {
  channels: SembangChannelSummary[] | null;
  activeChannelId: string | null;
  onSelect: (channel: SembangChannelSummary) => void;
  onCreateClick: () => void;
  loadError?: boolean;
}

/** Left sidebar — channel list. Mirrors the Inbox sidebar's width/feel
 *  (~272px on lg+) and re-sorts by last activity every render, the same
 *  "don't trust the realtime patch to preserve order" idea
 *  ConversationList's `filtered` useMemo uses. */
export function ChannelList({
  channels,
  activeChannelId,
  onSelect,
  onCreateClick,
  loadError,
}: ChannelListProps) {
  const t = useTranslations("Sembang.channelList");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const sorted = useMemo(() => {
    const list = channels ?? [];
    // Always re-sort by last activity rather than trusting arrival order —
    // a realtime patch can update one row without reshuffling the array.
    return [...list].sort((a, b) => {
      const at = (c: SembangChannelSummary) =>
        new Date(c.lastMessageAt ?? c.createdAt).getTime();
      return at(b) - at(a);
    });
  }, [channels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => c.name.toLowerCase().includes(q));
  }, [sorted, query]);

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-[272px] lg:flex-none">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("searchAriaLabel")}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("createAriaLabel")}
            onClick={onCreateClick}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {searchOpen && (
        <div className="border-b border-border px-3 py-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchAriaLabel")}
            className="h-8"
          />
        </div>
      )}

      {/* `min-h-0` is load-bearing — a flex child defaults to
          min-height:auto, so without it this grows to fit every channel
          instead of shrinking to the remaining space (same fix as
          ConversationList's own ScrollArea, issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loadError ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-destructive">{t("loadFailed")}</p>
          </div>
        ) : channels === null ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {query ? t("noMatches") : t("noChannels")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col py-1">
            {filtered.map((c) => {
              const isActive = c.id === activeChannelId;
              const isUnread = c.unreadCount > 0;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect(c)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted",
                    isActive && "bg-muted",
                  )}
                >
                  {c.isPrivate ? (
                    <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-sm text-foreground",
                        isUnread && "font-semibold",
                      )}
                    >
                      {c.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.lastMessageBody || t("noMessagesYet")}
                    </p>
                  </div>
                  {isUnread && (
                    <span
                      aria-label={t("unreadAriaLabel", { count: c.unreadCount })}
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground"
                    >
                      {c.unreadCount > 99 ? "99+" : c.unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-1 flex cursor-not-allowed items-center gap-2 border-t border-border px-3 py-2.5 opacity-50">
          <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="truncate text-sm text-muted-foreground">{t("directMessagesComingSoon")}</p>
        </div>
      </ScrollArea>
    </div>
  );
}
