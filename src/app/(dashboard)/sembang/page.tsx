"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AtSign, Hash, MessageSquareText, Search as SearchIcon, Star, Users2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChannelList } from "@/components/sembang/channel-list";
import { ChannelThread } from "@/components/sembang/channel-thread";
import { CreateChannelDialog } from "@/components/sembang/create-channel-dialog";
import { NewDmDialog } from "@/components/sembang/new-dm-dialog";
import { ArchivedChannelsDialog } from "@/components/sembang/archived-channels-dialog";
import { StarredPanel } from "@/components/sembang/starred-panel";
import { MentionsPanel } from "@/components/sembang/mentions-panel";
import { SearchDialog } from "@/components/sembang/search-dialog";
import { ThreadsPanel } from "@/components/sembang/threads-panel";
import { MemberDirectoryDialog } from "@/components/sembang/member-directory-dialog";
import { BrowseChannelsDialog } from "@/components/sembang/browse-channels-dialog";
import { useSembangSidebarRealtime } from "@/hooks/use-sembang-realtime";
import { useAuth } from "@/hooks/use-auth";
import { hasMinRole } from "@/lib/auth/roles";
import type { SembangChannelSummary } from "@/types";

// `useSearchParams` (the `?c=<id>` deep link from the notifications page)
// requires a Suspense boundary or the production build bails to CSR and
// errors out — same wrapper shape as the Inbox page.
export default function SembangPage() {
  return (
    <Suspense fallback={null}>
      <SembangPageInner />
    </Suspense>
  );
}

function SembangPageInner() {
  const t = useTranslations("Sembang.page");
  const searchParams = useSearchParams();
  const deepLinkChannelId = searchParams.get("c");
  const { accountRole } = useAuth();
  // Anyone with menu.sembang access CAN create a channel (no extra gate),
  // but the empty state nudges admins/owners toward doing so and points
  // everyone else at asking one instead — see create-channel-dialog.tsx.
  const canCreateHint = hasMinRole(accountRole ?? "viewer", "admin");

  const [channels, setChannels] = useState<SembangChannelSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // ---- Migration 100: DMs, archive, search, starred ----------------------
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [starredOpen, setStarredOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mentionsOpen, setMentionsOpen] = useState(false);

  // ---- Migration 101: global threads, member directory, browse channels --
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/sembang/channels", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setChannels((data.channels as SembangChannelSummary[]) ?? []);
      setLoadError(false);
    } catch (err) {
      console.error("Failed to load Sembang channels:", err);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void fetchChannels();
  }, [fetchChannels]);

  // Coalesce bursts of realtime events (several messages, a batch add of
  // members) into a single refetch instead of hammering the list route.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current) return;
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      void fetchChannels();
    }, 400);
  }, [fetchChannels]);
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, []);

  useSembangSidebarRealtime({
    onChannelEvent: scheduleRefetch,
    onMemberEvent: scheduleRefetch,
    onMessageEvent: scheduleRefetch,
  });

  // `?c=<channelId>` deep link — the notifications page links here as
  // `/sembang?c=<channelId>`. Fires once per URL value via the ref, same
  // idea as the Inbox page's deep-link handling.
  useEffect(() => {
    if (!deepLinkChannelId) return;
    if (autoSelectedForDeepLinkRef.current === deepLinkChannelId) return;
    autoSelectedForDeepLinkRef.current = deepLinkChannelId;
    setActiveChannelId(deepLinkChannelId);
  }, [deepLinkChannelId]);

  const handleSelect = useCallback((channel: SembangChannelSummary) => {
    setActiveChannelId(channel.id);
    // Optimistic — ChannelThread calls the mark-read route itself and
    // reports back via onChannelRead; this just clears the badge
    // immediately so the click feels instant.
    setChannels((prev) =>
      prev?.map((c) => (c.id === channel.id && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c)) ?? prev,
    );
  }, []);

  const handleChannelRead = useCallback((channelId: string) => {
    setChannels((prev) =>
      prev?.map((c) => (c.id === channelId && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c)) ?? prev,
    );
  }, []);

  // Mobile "back" — deselect the channel so the list pane comes back.
  const handleBack = useCallback(() => {
    setActiveChannelId(null);
  }, []);

  const handleChannelCreated = useCallback((channel: SembangChannelSummary) => {
    setChannels((prev) => [channel, ...(prev ?? []).filter((c) => c.id !== channel.id)]);
    setActiveChannelId(channel.id);
    setCreateOpen(false);
  }, []);

  // POST /api/sembang/dms only returns a `SembangChannel` (no
  // `dmParticipantNames`/`unreadCount`/etc. — those are summary-row-only
  // fields from the list RPC), so unlike handleChannelCreated above this
  // can't build a summary row locally; it selects the DM right away and
  // refetches the sidebar list to pick up its real summary row.
  const handleDmCreated = useCallback(
    (channelId: string) => {
      setActiveChannelId(channelId);
      setNewDmOpen(false);
      void fetchChannels();
    },
    [fetchChannels],
  );

  const handleChannelArchived = useCallback((channelId: string) => {
    setChannels((prev) => prev?.filter((c) => c.id !== channelId) ?? prev);
    setActiveChannelId((prev) => (prev === channelId ? null : prev));
  }, []);

  const handleChannelUnarchived = useCallback(() => {
    void fetchChannels();
  }, [fetchChannels]);

  // Migration 101 — BrowseChannelsDialog just joined a public channel:
  // select it and refetch the sidebar list so it appears there (the
  // dialog itself already dropped it from its own local list).
  const handleChannelJoined = useCallback(
    (channelId: string) => {
      setActiveChannelId(channelId);
      setBrowseOpen(false);
      void fetchChannels();
    },
    [fetchChannels],
  );

  const hasActiveChannel = !!activeChannelId;
  const hasChannels = (channels?.length ?? 0) > 0;
  const totalUnreadMentions = (channels ?? []).reduce((sum, c) => sum + c.unreadMentionCount, 0);

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {/* Migration 100 — global entry points that span every channel/DM at
          once, so they live above the two-pane layout rather than inside
          either pane. */}
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border bg-card px-3 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("searchAriaLabel")}
          title={t("searchAriaLabel")}
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("starredAriaLabel")}
          title={t("starredAriaLabel")}
          onClick={() => setStarredOpen(true)}
        >
          <Star className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={t("mentionsAriaLabel")}
          title={t("mentionsAriaLabel")}
          onClick={() => setMentionsOpen(true)}
        >
          <AtSign className="h-4 w-4" />
          {totalUnreadMentions > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[9px] font-semibold text-white">
              {totalUnreadMentions > 99 ? "99+" : totalUnreadMentions}
            </span>
          )}
        </Button>
        {/* Migration 101 — global "Threads you're in" and member directory,
            same header-bar pattern as the P2 Search/Starred buttons. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("threadsAriaLabel")}
          title={t("threadsAriaLabel")}
          onClick={() => setThreadsOpen(true)}
        >
          <MessageSquareText className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("directoryAriaLabel")}
          title={t("directoryAriaLabel")}
          onClick={() => setDirectoryOpen(true)}
        >
          <Users2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: channel list. Hidden on mobile when a channel is
            selected so the thread can occupy the full width, same
            hasActiveConv-style collapse the Inbox page uses. */}
        <div
          className={cn(
            "flex h-full flex-1 lg:flex-none",
            hasActiveChannel ? "hidden lg:flex" : "flex",
          )}
        >
          <ChannelList
            channels={channels}
            activeChannelId={activeChannelId}
            onSelect={handleSelect}
            onCreateClick={() => setCreateOpen(true)}
            onNewDmClick={() => setNewDmOpen(true)}
            onArchivedClick={() => setArchivedOpen(true)}
            onBrowseClick={() => setBrowseOpen(true)}
            loadError={loadError}
          />
        </div>

        {/* Right panel: channel thread, or an empty state when nothing is
            selected yet / the account has no channels at all. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveChannel ? "flex" : "hidden lg:flex",
          )}
        >
          {channels !== null && !hasChannels && !activeChannelId ? (
            <div className="flex flex-1 flex-col items-center justify-center bg-background">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <Hash className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-sm font-medium text-muted-foreground">{t("emptyTitle")}</h3>
              <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                {canCreateHint ? t("emptyHintCreate") : t("emptyHintAskAdmin")}
              </p>
            </div>
          ) : (
            <ChannelThread
              channelId={activeChannelId}
              onBack={handleBack}
              onChannelRead={handleChannelRead}
              onChannelArchived={handleChannelArchived}
            />
          )}
        </div>
      </div>

      <CreateChannelDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleChannelCreated} />
      <NewDmDialog open={newDmOpen} onOpenChange={setNewDmOpen} onCreated={handleDmCreated} />
      <ArchivedChannelsDialog
        open={archivedOpen}
        onOpenChange={setArchivedOpen}
        onUnarchived={handleChannelUnarchived}
      />
      <StarredPanel open={starredOpen} onOpenChange={setStarredOpen} />
      <MentionsPanel open={mentionsOpen} onOpenChange={setMentionsOpen} onCleared={fetchChannels} />
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <ThreadsPanel open={threadsOpen} onOpenChange={setThreadsOpen} />
      <MemberDirectoryDialog open={directoryOpen} onOpenChange={setDirectoryOpen} />
      <BrowseChannelsDialog open={browseOpen} onOpenChange={setBrowseOpen} onJoined={handleChannelJoined} />
    </div>
  );
}
