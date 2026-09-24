"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { useTeams } from "@/hooks/use-teams";
import { useTags } from "@/hooks/use-tags";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { readOnlyTitle } from "@/components/ui/gated-button";
import { useNow } from "@/hooks/use-now";
import { useInboxViews } from "@/hooks/use-inbox-views";
import { cn } from "@/lib/utils";
import type { StatusColors } from "@/lib/status-colors";
import { hexWithAlpha } from "@/lib/status-colors";
import type { ChannelType, Conversation, ConversationPriority, ConversationStatus, InboxView, Tag, Team } from "@/types";
import { Search, ChevronDown, X, Flag, ArrowUpDown, Clock, ListChecks, Tag as TagIcon, Check, Bookmark, Trash2, Users } from "lucide-react";
import { CHANNEL_ICONS } from "./channel-icons";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { InboxTabBar } from "./inbox-tab-bar";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { addConversationLabel } from "@/lib/conversations/label-api";
import { TagChip } from "./tag-chip";
import { createInboxView, deleteInboxView } from "@/lib/inbox/views-api";
import {
  TAB_CHANNELS,
  tabForChannel,
  unreadConversationCounts,
  type InboxTab,
} from "@/lib/inbox/channel-scope";
import { PendingDeletePanel } from "./pending-delete-panel";
import { BulkActionsBar } from "./bulk-actions-bar";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Active Chats / Emails tab (controlled by the inbox page, which also
   * needs it for the WhatsApp banner and deep links). The tab is a hard
   * channel boundary, applied before every other filter — unlike
   * `selectedChannelTypes`, the user's own optional multi-select within
   * the tab. The channel dropdown only offers the active tab's channels.
   */
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  /** Comments still waiting for a first response — the Comments tab's bubble. */
  commentsOpen?: number;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Optimistic-update hook, same one MessageThread's single-conversation
   * label toggle uses (see inbox/page.tsx's handleLabelsChange) — the
   * bulk-apply action below calls this per conversation instead of
   * waiting on a full refetch/realtime round-trip. Optional so this
   * stays backward-compatible for any other caller of ConversationList.
   */
  onLabelsChange?: (conversationId: string, labels: Conversation["labels"]) => void;
  /** Patches local state after a bulk write (assign / close / read state), same role as `onLabelsChange` for labels. */
  onBulkPatch?: (ids: string[], patch: Partial<Conversation>) => void;
}

type InboxFilter = ConversationStatus | "all" | "unread" | "mine" | "unassigned";

/** Sentinel for the "no team" bucket in the Team filter — distinct from
 *  `null` (no team filter applied at all). */
const UNASSIGNED_TEAM = "__unassigned__";

/** `Inbox.conversationList` already has Open/Pending/Closed strings
 *  under these filter-menu keys — reused here for the status dot's
 *  tooltip and the priority flag's aria-label rather than adding a
 *  second, redundant set of translations for the same three words. */
const STATUS_FILTER_KEY: Record<ConversationStatus, "filterOpen" | "filterPending" | "filterClosed"> = {
  open: "filterOpen",
  pending: "filterPending",
  closed: "filterClosed",
};

/** Highest first — drives the "Priority" sort. */
const PRIORITY_RANK: Record<ConversationPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

type SortMode = "recent" | "priority";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onLabelsChange,
  onBulkPatch,
  tab,
  onTabChange,
  commentsOpen = 0,
}: ConversationListProps) {
  const channelScope = TAB_CHANNELS[tab];
  const t = useTranslations("Inbox.conversationList");
  const { user, slaResponseMinutes, statusColors } = useAuth();
  // One shared ticking clock for every row's aging-response chip,
  // rather than each ConversationItem running its own interval.
  const now = useNow(30000);

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterMine"), value: "mine" },
    { label: t("filterUnassigned"), value: "unassigned" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  // The ownership row is All / Mine / Unassigned as direct tabs, plus an
  // "Others" tab that opens the remaining status-based options in a
  // dropdown — same seven values as FILTER_OPTIONS, just split into what
  // deserves a one-click tab versus what's rare enough to stay tucked
  // away. Replaces the single flat "All ▾" dropdown that used to hold
  // all seven undifferentiated.
  const OTHER_FILTER_OPTIONS = useMemo(
    () => FILTER_OPTIONS.filter((o) => o.value === "unread" || o.value === "open" || o.value === "pending" || o.value === "closed"),
    [FILTER_OPTIONS],
  );

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  // `tags` = the full palette (resolves ids in saved views); the two
  // pickers below offer only what each list is for (migration 068).
  const { tags, contactTags, conversationLabels } = useTags();
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // Team bucket filter (P0 gap-analysis item). `null` = no filter,
  // `UNASSIGNED_TEAM` = only conversations with no assigned_team_id,
  // otherwise a team id.
  const { teams } = useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  // Conversation label filter (P0 gap-analysis item) — OR logic across
  // selected labels, same semantics as the contact-tag filter above but
  // over `conversation.labels` instead of `conversation.contact.tags`.
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  // Channel filter — multi-select (e.g. "Email" = email+gmail, or
  // "Everything else" = every non-email channel) so a saved view can
  // group channels, not just isolate one. Empty array = no filter.
  const [selectedChannelTypes, setSelectedChannelTypes] = useState<ChannelType[]>([]);
  // Priority filter + sort (P1 gap-analysis item, migration 047). `null` =
  // no priority filter. Sort defaults to "recent" (existing behavior) —
  // switching to "priority" doesn't change what's *shown*, only order.
  const [selectedPriority, setSelectedPriority] = useState<ConversationPriority | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  // Bulk label apply (Conversation Labels gap-analysis follow-up) — a
  // lightweight multi-select mode scoped to the one bulk action this
  // category actually needs today (apply a label to N conversations at
  // once, e.g. after an incident). Bulk assign/close is a separate,
  // not-yet-built roadmap card and intentionally out of scope here.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [applyingLabelId, setApplyingLabelId] = useState<string | null>(null);

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => !prev);
    setSelectedIds(new Set());
  }, []);

  // Pending Delete panel (migration 062) — account-wide, not scoped to
  // any one conversation, so it lives at this level rather than inside
  // MessageThread. The count badge refetches on mount and whenever the
  // panel itself restores/clears a row, so it stays roughly current
  // without a dedicated realtime subscription for what's a low-traffic
  // number.
  const [pendingDeleteOpen, setPendingDeleteOpen] = useState(false);
  const [pendingDeleteCount, setPendingDeleteCount] = useState(0);
  const refetchPendingDeleteCount = useCallback(() => {
    const supabase = createClient();
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("pending_delete", true)
      .then(({ count }) => setPendingDeleteCount(count ?? 0));
  }, []);
  useEffect(() => {
    refetchPendingDeleteCount();
  }, [refetchPendingDeleteCount]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Saved inbox views (P1 gap-analysis item) — persists the filter
  // combination above as a named, re-selectable view instead of it
  // resetting every session.
  const { views, loading: viewsLoading, refetch: refetchViews } = useInboxViews();
  // Shared (team-wide) views: inbox.shared-views (admin+ by default).
  const canSaveShared = useCapability("inbox.shared-views");
  // Personal views, bulk label/assign/close: conversations.manage.
  const canManageConv = useCapability("conversations.manage");
  const canSaveView = canManageConv || canSaveShared;
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  const [saveViewShared, setSaveViewShared] = useState(false);
  const [savingView, setSavingView] = useState(false);

  const applyView = useCallback((view: InboxView) => {
    const cfg = view.filter_config ?? {};
    setFilter((cfg.filter as InboxFilter) ?? "all");
    setSelectedTagIds(cfg.tagIds ?? []);
    setSelectedCompany(cfg.company ?? null);
    setSelectedTeamId(cfg.teamId ?? null);
    setSelectedLabelIds(cfg.labelIds ?? []);
    const viewChannels: ChannelType[] =
      cfg.channelTypes ?? (cfg.channelType ? [cfg.channelType] : []);
    setSelectedChannelTypes(viewChannels);
    // A saved view that targets email channels belongs on the Emails tab
    // (and vice versa); one with no channel filter keeps the current tab.
    if (viewChannels.length > 0) onTabChange(tabForChannel(viewChannels[0]));
    setSelectedPriority(cfg.priority ?? null);
    setSortMode((cfg.sortMode as SortMode) ?? "recent");
  }, [onTabChange]);

  const unreadByTab = useMemo(() => unreadConversationCounts(conversations), [conversations]);

  const handleTabClick = useCallback(
    (next: InboxTab) => {
      if (next === tab) return;
      // Channels differ per tab, so a channel filter picked on one tab
      // can't carry over to the other.
      setSelectedChannelTypes([]);
      onTabChange(next);
    },
    [tab, onTabChange],
  );

  const handleSaveView = useCallback(async () => {
    const name = saveViewName.trim();
    if (!name || !canSaveView) return;
    setSavingView(true);
    try {
      await createInboxView({
        name,
        filterConfig: {
          filter,
          tagIds: selectedTagIds,
          company: selectedCompany,
          teamId: selectedTeamId,
          labelIds: selectedLabelIds,
          channelTypes: selectedChannelTypes,
          priority: selectedPriority,
          sortMode,
        },
        shared: saveViewShared,
      });
      refetchViews();
      setShowSaveViewForm(false);
      setSaveViewName("");
      setSaveViewShared(false);
      toast.success(t("viewSaved", { name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("viewSaveFailed"));
    } finally {
      setSavingView(false);
    }
  }, [
    saveViewName,
    saveViewShared,
    canSaveView,
    filter,
    selectedTagIds,
    selectedCompany,
    selectedTeamId,
    selectedLabelIds,
    selectedChannelTypes,
    selectedPriority,
    sortMode,
    refetchViews,
    t,
  ]);

  const handleDeleteView = useCallback(
    async (view: InboxView, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await deleteInboxView(view.id);
        refetchViews();
        toast.success(t("viewDeleted", { name: view.name }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("viewDeleteFailed"));
      }
    },
    [refetchViews, t]
  );

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const teamsById = useMemo(() => {
    const m = new Map<string, (typeof teams)[number]>();
    for (const tm of teams) m.set(tm.id, tm);
    return m;
  }, [teams]);

  const filtered = useMemo(() => {
    let result = conversations;

    // Email/Chat inbox split — a hard boundary, applied before every
    // other (togglable) filter below, so a "Chat Inbox" instance can
    // never surface an email conversation regardless of what else is
    // selected.
    result = result.filter((c) => channelScope.includes(c.last_channel_type));

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === "mine") {
      result = result.filter((c) => !!user && c.assigned_agent_id === user.id);
    } else if (filter === "unassigned") {
      // Matches the P0 spec: no agent AND still open — a closed or
      // pending conversation that never got assigned isn't a live queue
      // item, so it shouldn't clutter this view.
      result = result.filter((c) => !c.assigned_agent_id && c.status === "open");
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    // Team bucket filter — conversation-level, not contact-level, so it
    // filters directly on assigned_team_id rather than through
    // matchesContactFilters.
    if (selectedTeamId === UNASSIGNED_TEAM) {
      result = result.filter((c) => !c.assigned_team_id);
    } else if (selectedTeamId !== null) {
      result = result.filter((c) => c.assigned_team_id === selectedTeamId);
    }

    // Conversation label filter — OR logic, same as the contact-tag filter.
    if (selectedLabelIds.length > 0) {
      result = result.filter((c) =>
        (c.labels ?? []).some((l) => selectedLabelIds.includes(l.id)),
      );
    }

    if (selectedChannelTypes.length > 0) {
      result = result.filter((c) => selectedChannelTypes.includes(c.last_channel_type));
    }

    if (selectedPriority !== null) {
      result = result.filter((c) => c.priority === selectedPriority);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    if (sortMode === "priority") {
      // Stable sort: priority rank first, then the existing recency order
      // as the tiebreaker (Array.prototype.sort is stable per spec, and
      // `result` already arrives in recency order from `conversations`).
      result = [...result].sort(
        (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
      );
    } else {
      // "recent" — always re-derive order from last_message_at instead of
      // trusting `conversations`' incoming order. That order is only ever
      // correct right after the initial fetch (a real ORDER BY); a
      // realtime patch — a new inbound message, any conversation-row
      // update — updates a row's fields in place via .map() and never
      // moves it, so without this a conversation with brand-new activity
      // could sit wherever it happened to be instead of jumping to the
      // top, and an agent scanning from the top could miss it entirely.
      result = [...result].sort((a, b) => {
        const at = (c: Conversation) => (c.last_message_at ? new Date(c.last_message_at).getTime() : 0);
        return at(b) - at(a);
      });
    }

    return result;
  }, [
    conversations,
    channelScope,
    filter,
    search,
    selectedTagIds,
    selectedCompany,
    selectedTeamId,
    selectedLabelIds,
    selectedChannelTypes,
    selectedPriority,
    sortMode,
    user,
  ]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const toggleLabel = useCallback((id: string) => {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
    setSelectedTeamId(null);
    setSelectedLabelIds([]);
    setSelectedChannelTypes([]);
    setSelectedPriority(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 ||
    selectedCompany !== null ||
    selectedTeamId !== null ||
    selectedLabelIds.length > 0 ||
    selectedPriority !== null;

  const toggleChannelType = useCallback((ct: ChannelType) => {
    setSelectedChannelTypes((prev) =>
      prev.includes(ct) ? prev.filter((c) => c !== ct) : [...prev, ct]
    );
  }, []);

  const handleBulkApplyLabel = useCallback(
    async (tag: Tag) => {
      if (!canManageConv || selectedIds.size === 0) return;
      setApplyingLabelId(tag.id);
      const targetIds = Array.from(selectedIds);
      const results = await Promise.allSettled(
        targetIds.map((id) => addConversationLabel(id, tag.id))
      );

      let succeeded = 0;
      results.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        succeeded += 1;
        const id = targetIds[i];
        const current = conversations.find((c) => c.id === id)?.labels ?? [];
        if (current.some((l) => l.id === tag.id)) return;
        onLabelsChange?.(id, [...current, tag]);
      });

      setApplyingLabelId(null);
      if (succeeded === targetIds.length) {
        toast.success(t("bulkLabelApplied", { count: succeeded, label: tag.name }));
        setSelectMode(false);
        setSelectedIds(new Set());
      } else {
        toast.error(
          t("bulkLabelPartialFailure", { succeeded, total: targetIds.length })
        );
      }
    },
    [canManageConv, selectedIds, conversations, onLabelsChange, t]
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);
  const isOtherFilter = filter === "unread" || filter === "open" || filter === "pending" || filter === "closed";

  return (
    <>
    {/* w-full on mobile so the list occupies the whole viewport when it's
        the single pane showing; fixed 320px on desktop where it shares the
        row with the thread + contact sidebar. */}
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-96 lg:flex-none xl:w-[28rem]">
      <InboxTabBar
        tab={tab}
        onTabClick={handleTabClick}
        unread={{ ...unreadByTab, comments: commentsOpen }}
      />

      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        {/* Ownership tabs — All / Mine / Unassigned as one-click tabs, plus
            an "Others" tab holding the remaining status filters (Unread,
            Open, Pending, Closed) in a dropdown. Replaces the old single
            "All ▾" dropdown that flattened all seven options together. */}
        <div className="flex items-center gap-4 text-xs font-medium">
          {(["all", "mine", "unassigned"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setFilter(v)}
              className={cn(
                "border-b-2 pb-1 pt-0.5 transition-colors",
                filter === v
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {v === "all" ? t("filterAll") : v === "mine" ? t("filterMine") : t("filterUnassigned")}
            </button>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "flex items-center gap-0.5 border-b-2 pb-1 pt-0.5 transition-colors",
                isOtherFilter
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {isOtherFilter ? activeFilter?.label : t("filterOthers")}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              {OTHER_FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value ? "text-primary" : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) {
                setShowSaveViewForm(false);
                setSaveViewName("");
                setSaveViewShared(false);
              }
            }}
          >
            <DropdownMenuTrigger
              title={t("views")}
              aria-label={t("views")}
              className="order-10 ml-auto inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted"
            >
              <Bookmark className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 border-border bg-popover">
              {viewsLoading ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("loading")}</div>
              ) : views.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("noSavedViews")}</div>
              ) : (
                views.map((view) => (
                  <DropdownMenuItem
                    key={view.id}
                    onClick={() => applyView(view)}
                    className="group flex items-center justify-between text-sm text-popover-foreground"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {view.owner_id === null && (
                        <Users className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("shared")} />
                      )}
                      <span className="truncate">{view.name}</span>
                    </span>
                    {(view.owner_id === user?.id || (view.owner_id === null && canSaveShared)) && (
                      <button
                        onClick={(e) => handleDeleteView(view, e)}
                        disabled={view.owner_id === null ? !canSaveShared : !canManageConv}
                        className="ml-2 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-red-500 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                        title={t("deleteView")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </DropdownMenuItem>
                ))
              )}
              <div className="border-t border-border p-2">
                {showSaveViewForm ? (
                  <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
                    <Input
                      autoFocus
                      value={saveViewName}
                      onChange={(e) => setSaveViewName(e.target.value)}
                      placeholder={t("viewNamePlaceholder")}
                      className="h-7 border-border bg-muted text-xs text-foreground"
                    />
                    {canSaveShared && (
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={saveViewShared}
                          onChange={(e) => setSaveViewShared(e.target.checked)}
                          className="h-3 w-3"
                        />
                        {t("shareWithTeam")}
                      </label>
                    )}
                    <button
                      onClick={handleSaveView}
                      disabled={!canSaveView || savingView || !saveViewName.trim()}
                      className="w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                    >
                      {t("save")}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowSaveViewForm(true);
                    }}
                    disabled={!canSaveView}
                    title={canSaveView ? undefined : readOnlyTitle("save inbox views")}
                    className="w-full rounded-md px-2 py-1 text-left text-xs text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("saveCurrentView")}
                  </button>
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {contactTags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {contactTags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Conversation labels — draws from the same tag palette as the
              contact-tag filter above, but filters on the conversation's
              own `labels` (migration 044), not the contact's tags. */}
          {conversationLabels.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedLabelIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("labels")}
                {selectedLabelIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedLabelIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {conversationLabels.map((lb) => (
                  <DropdownMenuCheckboxItem
                    key={lb.id}
                    checked={selectedLabelIds.includes(lb.id)}
                    onCheckedChange={() => toggleLabel(lb.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: lb.color }}
                      />
                      <span className="truncate">{lb.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {teams.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTeamId !== null
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {selectedTeamId !== null && selectedTeamId !== UNASSIGNED_TEAM && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: teamsById.get(selectedTeamId)?.color }}
                  />
                )}
                <span className="truncate">
                  {selectedTeamId === null
                    ? t("allTeams")
                    : selectedTeamId === UNASSIGNED_TEAM
                      ? t("unassignedTeam")
                      : (teamsById.get(selectedTeamId)?.name ?? t("teams"))}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedTeamId(null)}
                  className={cn(
                    "text-sm",
                    selectedTeamId === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allTeams")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedTeamId(UNASSIGNED_TEAM)}
                  className={cn(
                    "text-sm",
                    selectedTeamId === UNASSIGNED_TEAM
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("unassignedTeam")}
                </DropdownMenuItem>
                {teams.map((tm) => (
                  <DropdownMenuItem
                    key={tm.id}
                    onClick={() => setSelectedTeamId(tm.id)}
                    className={cn(
                      "text-sm",
                      selectedTeamId === tm.id
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: tm.color }}
                      />
                      <span className="truncate">{tm.name}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                selectedChannelTypes.length > 0
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="truncate">
                {selectedChannelTypes.length === 0
                  ? t(tab === "chats" ? "allChatChannels" : "allEmailChannels")
                  : selectedChannelTypes.length === 1
                    ? t(`channel.${selectedChannelTypes[0]}`)
                    : t("channelsSelected", { count: selectedChannelTypes.length })}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-48 border-border bg-popover"
            >
              <DropdownMenuItem
                onClick={() => setSelectedChannelTypes([])}
                className={cn(
                  "text-sm",
                  selectedChannelTypes.length === 0
                    ? "text-primary"
                    : "text-popover-foreground"
                )}
              >
                {t(tab === "chats" ? "allChatChannels" : "allEmailChannels")}
              </DropdownMenuItem>
              {channelScope.map((ct) => {
                const Icon = CHANNEL_ICONS[ct];
                return (
                  <DropdownMenuCheckboxItem
                    key={ct}
                    checked={selectedChannelTypes.includes(ct)}
                    onCheckedChange={() => toggleChannelType(ct)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t(`channel.${ct}`)}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              title={t("allPriorities")}
              aria-label={t("allPriorities")}
              className={cn(
                "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                selectedPriority !== null
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Flag className="h-3.5 w-3.5 shrink-0" />
              {/* Icon-only until a priority is chosen, to keep the filter
                  row to one line in the 320px column. */}
              {selectedPriority !== null && (
                <>
                  <span className="truncate">{t(`priority.${selectedPriority}`)}</span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40 border-border bg-popover">
              <DropdownMenuItem
                onClick={() => setSelectedPriority(null)}
                className={cn(
                  "text-sm",
                  selectedPriority === null ? "text-primary" : "text-popover-foreground"
                )}
              >
                {t("allPriorities")}
              </DropdownMenuItem>
              {(["urgent", "high", "normal", "low"] as ConversationPriority[]).map((p) => (
                <DropdownMenuItem
                  key={p}
                  onClick={() => setSelectedPriority(p)}
                  className={cn(
                    "text-sm",
                    selectedPriority === p ? "text-primary" : "text-popover-foreground"
                  )}
                >
                  <Flag className="mr-2 h-3.5 w-3.5" style={{ color: statusColors.priority[p] }} />
                  {t(`priority.${p}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            onClick={() => setSortMode((m) => (m === "recent" ? "priority" : "recent"))}
            title={t("sortToggleTitle")}
            className={cn(
              "order-11 inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
              sortMode === "priority" ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
          </button>

          <button
            type="button"
            onClick={toggleSelectMode}
            title={t("selectModeTitle")}
            className={cn(
              "order-12 inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
              selectMode ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <ListChecks className="h-3.5 w-3.5 shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => setPendingDeleteOpen(true)}
            title={t("pendingDeleteTitle")}
            className="relative order-13 inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            {pendingDeleteCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive/15 px-1 text-[10px] font-bold text-destructive">
                {pendingDeleteCount}
              </span>
            )}
          </button>
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedTeamId !== null && (
              <button
                onClick={() => setSelectedTeamId(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                {selectedTeamId !== UNASSIGNED_TEAM && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: teamsById.get(selectedTeamId)?.color }}
                  />
                )}
                <span className="max-w-24 truncate">
                  {selectedTeamId === UNASSIGNED_TEAM
                    ? t("unassignedTeam")
                    : (teamsById.get(selectedTeamId)?.name ?? t("teams"))}
                </span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedPriority !== null && (
              <button
                onClick={() => setSelectedPriority(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{t(`priority.${selectedPriority}`)}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedLabelIds.map((id) => {
              const label = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleLabel(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: label?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{label?.name ?? t("labels")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {selectMode && selectedIds.size > 0 && (
        <BulkActionsBar
          selected={conversations.filter((c) => selectedIds.has(c.id))}
          visibleCount={filtered.length}
          onSelectAll={() => setSelectedIds(new Set(filtered.map((c) => c.id)))}
          onClear={clearSelection}
          onPatch={(ids, patch) => onBulkPatch?.(ids, patch)}
          onDone={() => {
            setSelectMode(false);
            setSelectedIds(new Set());
          }}
          labelControl={
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!canManageConv || applyingLabelId !== null}
                  title={canManageConv ? undefined : readOnlyTitle("manage conversations")}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-foreground hover:bg-muted disabled:opacity-60"
                >
                  <TagIcon className="h-3 w-3" />
                  {t("applyLabel")}
                  <ChevronDown className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
                  {conversationLabels.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("noLabelsAvailable")}</div>
                  ) : (
                    conversationLabels.map((tag) => (
                      <DropdownMenuItem
                        key={tag.id}
                        onClick={() => handleBulkApplyLabel(tag)}
                        disabled={applyingLabelId !== null}
                        className="text-sm text-popover-foreground"
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="truncate">{tag.name}</span>
                        </span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
          }
        />
      )}

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                team={conv.assigned_team_id ? teamsById.get(conv.assigned_team_id) : undefined}
                t={t}
                now={now}
                slaResponseMinutes={slaResponseMinutes}
                statusColors={statusColors}
                selectMode={selectMode}
                selected={selectedIds.has(conv.id)}
                onToggleSelect={toggleSelected}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
    <PendingDeletePanel
      open={pendingDeleteOpen}
      onOpenChange={setPendingDeleteOpen}
      onChanged={refetchPendingDeleteCount}
    />
    </>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** The conversation's assigned team, if any — resolved by the parent
   *  from its `teamsById` map so each row doesn't redo the lookup. */
  team?: Pick<Team, "id" | "name" | "color">;
  t: ReturnType<typeof useTranslations>;
  /** Shared clock from the parent's single `useNow()` (migration 049's
   *  aging-response chip) — reading `Date.now()` directly during render
   *  is impure, and one shared interval beats one per row. */
  now: number;
  slaResponseMinutes: number;
  /** Per-account Inbox colors (migration 057) — drives the status dot,
   *  the overdue pill, and the priority flag below. */
  statusColors: StatusColors;
  /** Bulk label-apply mode (Conversation Labels follow-up) — when on,
   *  the row toggles selection instead of opening the conversation. */
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  team,
  t,
  now,
  slaResponseMinutes,
  statusColors,
  selectMode,
  selected,
  onToggleSelect,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const ChannelIcon = CHANNEL_ICONS[conversation.last_channel_type];

  const handleClick = useCallback(() => {
    if (selectMode) {
      onToggleSelect(conversation.id);
      return;
    }
    onSelect(conversation);
  }, [selectMode, onToggleSelect, onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  // "Aging response" indicator (migration 049) — only meaningful for a
  // conversation that's still open/pending and genuinely waiting on us.
  // Closed threads can carry a stale awaiting_response from before they
  // were closed; nothing actionable to flag there.
  const showAging =
    conversation.awaiting_response &&
    conversation.status !== "closed" &&
    !!conversation.last_customer_message_at;
  const waitingMinutes = showAging
    ? (now - new Date(conversation.last_customer_message_at!).getTime()) / 60000
    : 0;
  const isBreached = showAging && waitingMinutes >= slaResponseMinutes;

  // Contact tags first (about the person), then conversation labels
  // (about this thread) — both carry their colour so an agent can scan
  // the list for e.g. VIP customers without opening anything.
  const chips: { tag: Tag; kind: "tag" | "label" }[] = [
    ...(contact?.tags ?? []).map((tag) => ({ tag, kind: "tag" as const })),
    ...(conversation.labels ?? []).map((tag) => ({ tag, kind: "label" as const })),
  ];

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70",
        selectMode && selected && "bg-primary/5"
      )}
    >
      {selectMode && (
        <span
          className={cn(
            "mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border"
          )}
        >
          {selected && <Check className="h-3 w-3" />}
        </span>
      )}

      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChannelIcon
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-label={t(`channel.${conversation.last_channel_type}`)}
            />
            {conversation.priority !== "normal" && (
              <Flag
                className="h-3 w-3 shrink-0"
                style={{ color: statusColors.priority[conversation.priority] }}
                aria-label={t(`priority.${conversation.priority}`)}
              />
            )}
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {showAging && (
              <span
                className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                style={
                  isBreached
                    ? { backgroundColor: hexWithAlpha(statusColors.overdue, 0.15), color: statusColors.overdue }
                    : { backgroundColor: "rgba(245, 158, 11, 0.15)", color: "rgb(245, 158, 11)" }
                }
                title={t("awaitingResponseSince", {
                  time: formatDistanceToNow(
                    new Date(conversation.last_customer_message_at!),
                    { addSuffix: true },
                  ),
                })}
              >
                <Clock className="h-2.5 w-2.5" />
                {formatDistanceToNow(
                  new Date(conversation.last_customer_message_at!),
                  { addSuffix: false },
                )}
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            {team && (
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: team.color }}
                title={team.name}
              />
            )}
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: statusColors[conversation.status] }}
              title={t(STATUS_FILTER_KEY[conversation.status])}
            />
          </div>
        </div>
        {chips.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {chips.slice(0, 3).map(({ tag, kind }) => (
              <TagChip
                key={`${kind}-${tag.id}`}
                tag={tag}
                kind={kind}
                size="xs"
                title={t(kind === "tag" ? "tagTitle" : "labelTitle", { name: tag.name })}
              />
            ))}
            {chips.length > 3 && (
              <span className="text-[9px] text-muted-foreground">+{chips.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
