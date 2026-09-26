"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Archive, AtSign, BellOff, CheckSquare, Compass, Hash, Lock, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import type { SembangChannelSummary } from "@/types";

interface ChannelListProps {
  channels: SembangChannelSummary[] | null;
  activeChannelId: string | null;
  onSelect: (channel: SembangChannelSummary) => void;
  onCreateClick: () => void;
  /** Migration 100 — opens NewDmDialog. */
  onNewDmClick: () => void;
  /** Migration 100 — opens ArchivedChannelsDialog. Channels only; DMs
   *  aren't archivable (see channel-thread.tsx). */
  onArchivedClick: () => void;
  /** Migration 101 — opens BrowseChannelsDialog. */
  onBrowseClick: () => void;
  loadError?: boolean;
  /** P4 — the sidebar's persistent "Mentions" entry, replacing the old
   *  header-icon Sheet (it kept getting missed sitting among five other
   *  look-alike icon buttons). Pinned above the Channels section, same
   *  triage-view-outranks-browsing ordering Slack uses for its own
   *  Threads/Mentions entries. */
  mentionsActive: boolean;
  unreadMentionsTotal: number;
  onSelectMentions: () => void;
  /** "My Tasks" entry, same treatment as Mentions above — every
   *  `sembang_tasks` row assigned to the caller across every channel/DM.
   *  Pinned right below Mentions, same triage-view ordering. */
  myTasksActive: boolean;
  openMyTasksTotal: number;
  onSelectMyTasks: () => void;
  /** Migration 106 — the "X" on a DM row. Hides that DM from this user's
   *  own sidebar (it reappears on a new message, or when re-opened). */
  onHideDm: (channelId: string) => void;
}

/** A DM row's display label — the other participant(s)' names, joined.
 *  `dmParticipantNames` is only populated by the list RPC when `isDm` is
 *  true (migration 100). */
function dmLabel(c: SembangChannelSummary, fallback: string): string {
  return c.dmParticipantNames?.join(", ") || fallback;
}

/** Left sidebar — channel list. Mirrors the Inbox sidebar's width/feel
 *  (~272px on lg+) and re-sorts by last activity every render, the same
 *  "don't trust the realtime patch to preserve order" idea
 *  ConversationList's `filtered` useMemo uses. Split into "Channels" and
 *  "Direct Messages" sections (migration 100) — both keep this same
 *  sort/unread-badge treatment, just filtered by `isDm`. */
export function ChannelList({
  channels,
  activeChannelId,
  onSelect,
  onCreateClick,
  onNewDmClick,
  onArchivedClick,
  onBrowseClick,
  loadError,
  mentionsActive,
  unreadMentionsTotal,
  onSelectMentions,
  myTasksActive,
  openMyTasksTotal,
  onSelectMyTasks,
  onHideDm,
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
    return sorted.filter((c) => {
      const label = c.isDm ? dmLabel(c, "") : (c.name ?? "");
      return label.toLowerCase().includes(q);
    });
  }, [sorted, query]);

  const filteredChannels = useMemo(() => filtered.filter((c) => !c.isDm), [filtered]);
  const filteredDms = useMemo(() => filtered.filter((c) => c.isDm), [filtered]);

  const renderRow = (c: SembangChannelSummary) => {
    const isActive = c.id === activeChannelId;
    const isUnread = c.unreadCount > 0;
    const label = c.isDm ? dmLabel(c, t("directMessageFallback")) : (c.name ?? "");
    return (
      <div
        key={c.id}
        className={cn(
          "group/row flex items-center transition-colors hover:bg-muted",
          isActive && "bg-muted",
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(c)}
          className={cn("flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-3 text-left", c.isDm ? "pr-1" : "pr-3")}
        >
          {c.isDm ? (
            <PersonAvatar
              name={c.dmParticipantNames?.[0]}
              avatarUrl={c.dmParticipantAvatarUrls?.[0] ?? null}
              size="sm"
            />
          ) : c.isPrivate ? (
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
              {label}
            </p>
          </div>
          {c.muted && (
            <span title={t("mutedTooltip")} className="shrink-0">
              <BellOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </span>
          )}
          {c.unreadMentionCount > 0 && (
            <span
              title={t("unreadMentionsTooltip", { count: c.unreadMentionCount })}
              aria-label={t("unreadMentionsTooltip", { count: c.unreadMentionCount })}
              className="flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-full bg-amber-500 px-1 text-[11px] font-semibold text-white"
            >
              <AtSign className="h-3 w-3" aria-hidden />
              {c.unreadMentionCount > 99 ? "99+" : c.unreadMentionCount}
            </span>
          )}
          {isUnread && (
            <span
              aria-label={t("unreadAriaLabel", { count: c.unreadCount })}
              className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground"
            >
              {c.unreadCount > 99 ? "99+" : c.unreadCount}
            </span>
          )}
        </button>
        {/* Migration 106 — only DMs can be removed from the sidebar this
            way; a regular channel is left/archived instead, not hidden. */}
        {c.isDm && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onHideDm(c.id);
            }}
            aria-label={t("removeDmAriaLabel", { name: label })}
            title={t("removeDmAriaLabel", { name: label })}
            className="mr-1.5 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

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

      <button
        type="button"
        onClick={onSelectMentions}
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted",
          mentionsActive && "bg-muted",
        )}
      >
        <AtSign className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className={cn("flex-1 truncate text-sm text-foreground", unreadMentionsTotal > 0 && "font-semibold")}>
          {t("mentionsNavLabel")}
        </p>
        {unreadMentionsTotal > 0 && (
          <span
            aria-label={t("unreadMentionsTooltip", { count: unreadMentionsTotal })}
            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-semibold text-white"
          >
            {unreadMentionsTotal > 99 ? "99+" : unreadMentionsTotal}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={onSelectMyTasks}
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted",
          myTasksActive && "bg-muted",
        )}
      >
        <CheckSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className={cn("flex-1 truncate text-sm text-foreground", openMyTasksTotal > 0 && "font-semibold")}>
          {t("myTasksNavLabel")}
        </p>
        {openMyTasksTotal > 0 && (
          <span
            aria-label={t("openMyTasksTooltip", { count: openMyTasksTotal })}
            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-semibold text-white"
          >
            {openMyTasksTotal > 99 ? "99+" : openMyTasksTotal}
          </span>
        )}
      </button>

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
        ) : (
          <>
            {/* Channels section */}
            <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("channelsSectionTitle")}
            </p>
            {filteredChannels.length === 0 ? (
              <div className="px-4 py-4 text-center">
                <p className="text-xs text-muted-foreground">
                  {query ? t("noMatches") : t("noChannels")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col py-1">{filteredChannels.map(renderRow)}</div>
            )}
            <button
              type="button"
              onClick={onArchivedClick}
              className="flex items-center gap-2 border-t border-b border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("archivedChannelsLink")}
            </button>
            {/* Migration 101 — BrowseChannelsDialog entry point, same
                visual treatment as the Archived channels row above. */}
            <button
              type="button"
              onClick={onBrowseClick}
              className="flex items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Compass className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("browseChannelsLink")}
            </button>

            {/* Direct messages section */}
            <div className="flex items-center justify-between px-3 pt-2 pb-1">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("dmSectionTitle")}
              </p>
            </div>
            <button
              type="button"
              onClick={onNewDmClick}
              className="flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted"
            >
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="truncate text-sm text-foreground">{t("newMessage")}</p>
            </button>
            {filteredDms.length === 0 ? (
              <div className="px-4 py-4 text-center">
                <p className="text-xs text-muted-foreground">
                  {query ? t("noMatches") : t("noDirectMessages")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col py-1">{filteredDms.map(renderRow)}</div>
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
