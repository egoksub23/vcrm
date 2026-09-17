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
import { useAuth } from "@/hooks/use-auth";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import type { ChannelType, Conversation, ConversationPriority, ConversationStatus, Tag, Team } from "@/types";
import { Search, ChevronDown, X, MessageCircle, Globe, Flag, ArrowUpDown, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread" | "mine" | "unassigned";

/** Sentinel for the "no team" bucket in the Team filter — distinct from
 *  `null` (no team filter applied at all). */
const UNASSIGNED_TEAM = "__unassigned__";

const CHANNEL_ICONS: Record<ChannelType, typeof MessageCircle> = {
  whatsapp: MessageCircle,
  web_widget: Globe,
};

const PRIORITY_COLORS: Record<ConversationPriority, string> = {
  urgent: "text-red-500",
  high: "text-amber-400",
  normal: "text-muted-foreground",
  low: "text-sky-400",
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
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const { user, slaResponseMinutes } = useAuth();
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

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const { tags } = useTags();
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
  // Channel filter (WhatsApp vs. Web Widget). `null` = no filter.
  const [selectedChannelType, setSelectedChannelType] = useState<ChannelType | null>(null);
  // Priority filter + sort (P1 gap-analysis item, migration 047). `null` =
  // no priority filter. Sort defaults to "recent" (existing behavior) —
  // switching to "priority" doesn't change what's *shown*, only order.
  const [selectedPriority, setSelectedPriority] = useState<ConversationPriority | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("recent");

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

    if (selectedChannelType !== null) {
      result = result.filter((c) => c.last_channel_type === selectedChannelType);
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
    }

    return result;
  }, [
    conversations,
    filter,
    search,
    selectedTagIds,
    selectedCompany,
    selectedTeamId,
    selectedLabelIds,
    selectedChannelType,
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
    setSelectedChannelType(null);
    setSelectedPriority(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 ||
    selectedCompany !== null ||
    selectedTeamId !== null ||
    selectedLabelIds.length > 0 ||
    selectedChannelType !== null ||
    selectedPriority !== null;

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

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
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

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
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
                {tags.map((t) => (
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
          {tags.length > 0 && (
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
                {tags.map((lb) => (
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
                selectedChannelType !== null
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="truncate">
                {selectedChannelType === null
                  ? t("allChannels")
                  : t(`channel.${selectedChannelType}`)}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-48 border-border bg-popover"
            >
              <DropdownMenuItem
                onClick={() => setSelectedChannelType(null)}
                className={cn(
                  "text-sm",
                  selectedChannelType === null
                    ? "text-primary"
                    : "text-popover-foreground"
                )}
              >
                {t("allChannels")}
              </DropdownMenuItem>
              {(["whatsapp", "web_widget"] as ChannelType[]).map((ct) => {
                const Icon = CHANNEL_ICONS[ct];
                return (
                  <DropdownMenuItem
                    key={ct}
                    onClick={() => setSelectedChannelType(ct)}
                    className={cn(
                      "text-sm",
                      selectedChannelType === ct
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t(`channel.${ct}`)}</span>
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                selectedPriority !== null
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Flag className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {selectedPriority === null ? t("allPriorities") : t(`priority.${selectedPriority}`)}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0" />
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
                  <Flag className={cn("mr-2 h-3.5 w-3.5", PRIORITY_COLORS[p])} />
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
              "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
              sortMode === "priority" ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <ArrowUpDown className="h-3 w-3 shrink-0" />
            <span className="hidden truncate sm:inline">
              {sortMode === "priority" ? t("sortByPriority") : t("sortByRecent")}
            </span>
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
            {selectedChannelType !== null && (
              <button
                onClick={() => setSelectedChannelType(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{t(`channel.${selectedChannelType}`)}</span>
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
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
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
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  team,
  t,
  now,
  slaResponseMinutes,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const ChannelIcon = CHANNEL_ICONS[conversation.last_channel_type];

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

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

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
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
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-label={t(`channel.${conversation.last_channel_type}`)}
            />
            {conversation.priority !== "normal" && (
              <Flag
                className={cn("h-3 w-3 shrink-0", PRIORITY_COLORS[conversation.priority])}
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
                className={cn(
                  "flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  isBreached
                    ? "bg-red-500/15 text-red-500"
                    : "bg-amber-500/15 text-amber-500",
                )}
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
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
        {conversation.labels && conversation.labels.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {conversation.labels.slice(0, 3).map((label) => (
              <span
                key={label.id}
                className="max-w-20 truncate rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                style={{ backgroundColor: `${label.color}20`, color: label.color }}
                title={label.name}
              >
                {label.name}
              </span>
            ))}
            {conversation.labels.length > 3 && (
              <span className="text-[9px] text-muted-foreground">
                +{conversation.labels.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
