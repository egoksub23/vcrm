"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronDown, KanbanSquare, List, Loader2, Plus, Ticket as TicketIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useAuth } from "@/hooks/use-auth";
import { useMyTicketMentions } from "@/hooks/use-my-ticket-mentions";
import { useSharedNow } from "@/hooks/use-shared-now";
import { useCapability } from "@/hooks/use-can";
import { useTeams } from "@/hooks/use-teams";
import { useJiraLinkChips } from "@/hooks/use-ticket-jira";
import { useTicketKeyPrefix } from "@/hooks/use-ticket-key-prefix";
import { useTicketLabels } from "@/hooks/use-ticket-labels";
import { useTicketResolutions } from "@/hooks/use-ticket-resolutions";
import { useTicketStore, type TicketViewMode } from "@/hooks/use-ticket-store";
import { CreateTicketDialog } from "@/components/tickets/create-ticket-dialog";
import { TicketBoard, type BoardMove } from "@/components/tickets/ticket-board";
import { TicketBulkBar } from "@/components/tickets/ticket-bulk-bar";
import { TicketDetailDialog } from "@/components/tickets/ticket-detail-dialog";
import { TicketFilterBar } from "@/components/tickets/ticket-filter-bar";
import { TicketListView } from "@/components/tickets/ticket-list-view";
import { useResolutionPrompt } from "@/components/tickets/ticket-resolution-dialog";
import {
  applyFilters,
  hasActiveFilters,
  emptyFilters,
  parseFilters,
  serializeFilters,
  type TicketFilters,
} from "@/lib/tickets/filters";
import { buildBulkUpdates, buildTicketPatch, type BulkAction } from "@/lib/tickets/patch";
import {
  anyNeedsResolutionPrompt,
  needsResolutionPrompt,
  withResolution,
  type ResolutionChoice,
} from "@/lib/tickets/resolution";
import {
  DEFAULT_SORT,
  GROUP_BYS,
  parseGroupBy,
  parseSort,
  serializeSort,
  sortTickets,
  toggleSort,
  type GroupBy,
  type SortKey,
  type SortSpec,
} from "@/lib/tickets/sort-group";
import { updateTicketResult, updateTicketsResult, type UpdateResult } from "@/lib/tickets/update";
import type { Ticket, TicketStatus } from "@/types";

const VIEW_STORAGE_KEY = "wacrm:tickets:view";
const SLA_COLUMN_STORAGE_KEY = "wacrm:tickets:sla-column";
const RESOLUTION_COLUMN_STORAGE_KEY = "wacrm:tickets:resolution-column";

// `useSearchParams` opts the page out of static prerendering unless it
// sits under a Suspense boundary — same reason Settings/Reports do this.
export default function TicketsPage() {
  return (
    <Suspense fallback={null}>
      <TicketsPageInner />
    </Suspense>
  );
}

function TicketsPageInner() {
  const t = useTranslations("Tickets.list");
  const tView = useTranslations("Tickets.view");
  const tBulk = useTranslations("Tickets.bulk");
  const tResolution = useTranslations("Tickets.resolution");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { teams } = useTeams();
  const { members, nameOf } = useAccountMembers();
  const { prefix, keyOf } = useTicketKeyPrefix();
  const { labels: knownLabels, reload: reloadLabels } = useTicketLabels();
  const canWork = useCapability("tickets.work");
  const canDelete = useCapability("tickets.delete");

  // Resolutions (migration 096): moving tickets to Resolved or Closed asks how they were
  // resolved (one dialog, also for a bulk change); cancelling leaves them where they were.
  const { resolutions, byId: resolutionsById } = useTicketResolutions();
  const { ask: askResolution, dialog: resolutionDialog } = useResolutionPrompt();
  const resolutionName = useCallback((id: string) => resolutionsById.get(id)?.name ?? null, [resolutionsById]);
  /** The message for a failed write: the resolution reasons are spelled out, anything else is `fallback`. */
  const failureText = (result: UpdateResult, fallback: string) =>
    result.ok
      ? fallback
      : result.code === "resolution_required"
        ? tResolution("required")
        : result.code === "resolution_invalid"
          ? tResolution("invalid")
          : fallback;

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Requests that wait on this person (migration 095): the "Mentioned me" filter and the "Waiting on you" chips.
  const myMentions = useMyTicketMentions();
  const mentionedTicketIds = myMentions.ticketIds;
  const waiting = useMemo(() => Object.fromEntries(myMentions.byTicket), [myMentions.byTicket]);

  // Board or list, remembered per browser. Until it is known nothing loads,
  // so a list user does not pay for a board fetch first.
  const [view, setView] = useState<TicketViewMode | null>(null);
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(VIEW_STORAGE_KEY);
    } catch {
      // storage blocked: fall back to the default
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView(stored === "list" ? "list" : "board");
  }, []);
  const changeView = (next: TicketViewMode) => {
    setView(next);
    setSelected(new Set());
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // storage blocked: the choice just is not remembered
    }
  };
  const mode: TicketViewMode = view ?? "board";

  // The SLA column of the list is hideable, remembered per browser.
  const [showSla, setShowSla] = useState(true);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(SLA_COLUMN_STORAGE_KEY) === "off") setShowSla(false);
    } catch {
      // storage blocked: the column stays on
    }
  }, []);
  // The Resolution column of the list is optional, off by default, remembered per browser.
  const [showResolution, setShowResolution] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(RESOLUTION_COLUMN_STORAGE_KEY) === "on") setShowResolution(true);
    } catch {
      // storage blocked: the column stays off
    }
  }, []);
  const toggleResolutionColumn = () => {
    setShowResolution((prev) => {
      try {
        localStorage.setItem(RESOLUTION_COLUMN_STORAGE_KEY, prev ? "off" : "on");
      } catch {
        // storage blocked: the choice just is not remembered
      }
      return !prev;
    });
  };
  const toggleSlaColumn = () => {
    setShowSla((prev) => {
      try {
        localStorage.setItem(SLA_COLUMN_STORAGE_KEY, prev ? "off" : "on");
      } catch {
        // storage blocked: the choice just is not remembered
      }
      return !prev;
    });
  };

  // Filters, sort and grouping live in state and are mirrored into the URL
  // (`?q=&assignee=&sort=...`), so a link carries them. They are read from the
  // URL once, on load.
  const [filters, setFilters] = useState<TicketFilters>(() => parseFilters(searchParams));
  const [sort, setSort] = useState<SortSpec>(() => parseSort(searchParams.get("sort")));
  const [group, setGroup] = useState<GroupBy>(() => parseGroupBy(searchParams.get("group")));
  useEffect(() => {
    const next = serializeFilters(filters, new URLSearchParams(searchParams.toString()));
    if (sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir) next.delete("sort");
    else next.set("sort", serializeSort(sort));
    if (group === "none") next.delete("group");
    else next.set("group", group);
    if (next.toString() !== searchParams.toString()) {
      const qs = next.toString();
      router.replace(qs ? `/tickets?${qs}` : "/tickets", { scroll: false });
    }
  }, [filters, sort, group, searchParams, router]);

  const store = useTicketStore(mode, view !== null);

  // "Mentioned me" must list every waiting ticket, loaded page or not.
  const mentionedOn = filters.quick.includes("mentioned");
  const { ensureLoaded, loading: mentionStoreLoading } = store;
  useEffect(() => {
    if (mentionedOn && !mentionStoreLoading && mentionedTicketIds.size > 0) void ensureLoaded([...mentionedTicketIds]);
  }, [mentionedOn, mentionStoreLoading, mentionedTicketIds, ensureLoaded]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);

  // Closed is fetched when opened; coming back to a board that had it open
  // reloads it too.
  const { loading: storeLoading, columnLoaded, loadColumn } = store;
  useEffect(() => {
    if (mode === "board" && closedOpen && !storeLoading && !columnLoaded.closed) void loadColumn("closed");
  }, [mode, closedOpen, storeLoading, columnLoaded.closed, loadColumn]);

  const openTicketId = searchParams.get("t");
  const openTicket = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("t", id);
      router.replace(`/tickets?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );
  const closeTicket = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("t");
    router.replace(params.toString() ? `/tickets?${params.toString()}` : "/tickets", { scroll: false });
  }, [router, searchParams]);

  // ---- What is shown -------------------------------------------------------
  const slaFilterOn = filters.quick.includes("sla_at_risk") || filters.quick.includes("sla_breached");
  const slaSortOn = sort.key === "sla" || group === "sla";
  // The SLA filters, sort and groups read the clock (30 s ticks); nothing ticks while they are off.
  const slaNow = useSharedNow(slaFilterOn || slaSortOn);
  // `now` only enters the context while an SLA chip is on, so the other filters do not re-run every 30 s.
  const ctx = useMemo(
    () => ({
      userId: user?.id ?? null,
      prefix,
      mentionedTicketIds,
      ...(slaFilterOn ? { now: new Date(slaNow) } : {}),
    }),
    [user?.id, prefix, mentionedTicketIds, slaFilterOn, slaNow],
  );
  const filtered = useMemo(
    () => applyFilters(store.rows, filters, ctx, mode === "list"),
    [store.rows, filters, ctx, mode],
  );
  const listRows = useMemo(
    () =>
      mode === "list"
        ? sortTickets(filtered, sort, { assigneeName: (id) => nameOf(id), ...(slaSortOn ? { now: slaNow } : {}) })
        : filtered,
    [mode, filtered, sort, nameOf, slaSortOn, slaNow],
  );
  const loadedCounts = useMemo(() => {
    const counts: Record<TicketStatus, number> = { open: 0, in_progress: 0, pending: 0, resolved: 0, closed: 0 };
    for (const r of store.rows) counts[r.status] += 1;
    return counts;
  }, [store.rows]);
  // Linked Jira keys for the cards / rows on screen: cached rows, one query, no Jira call.
  const jiraChips = useJiraLinkChips(useMemo(() => listRows.map((r) => r.id), [listRows]));
  const selectedRows = useMemo(() => listRows.filter((r) => selected.has(r.id)), [listRows, selected]);
  const narrowed = hasActiveFilters(filters, mode === "list");

  // ---- Edits -----------------------------------------------------------------
  /** One ticket, optimistic: an inline edit in the list. */
  const handlePatch = async (id: string, patch: Partial<Ticket>) => {
    let next = patch;
    const row = store.rows.find((r) => r.id === id);
    if (row && patch.status && needsResolutionPrompt(row.status, patch.status, row.resolution_id)) {
      const answer = await askResolution({
        status: patch.status,
        count: 1,
        initial: { resolutionId: row.resolution_id ?? null, note: row.resolution_note ?? null },
      });
      if (answer.kind === "cancel") return; // nothing was changed: the row keeps its status
      next = withResolution(patch, answer.kind === "chosen" ? answer.choice : null);
    }
    const full = buildTicketPatch(next);
    const undo = store.applyPatch([id], full);
    const result = await updateTicketResult(id, full);
    if (!result.ok) {
      undo();
      toast.error(failureText(result, t("updateFailed")));
    } else if (patch.labels) {
      void reloadLabels();
    }
  };

  /** A card dropped on the board: a status change (with its resolved_at /
   *  closed_at) and/or a new rank; rolled back if the write fails. */
  const handleMove = async (move: BoardMove) => {
    const row = store.rows.find((r) => r.id === move.id);
    if (!row) return;
    const rankOf = (id: string) => move.rebalance?.find((r) => r.id === id)?.rank;
    // Dropped into Resolved or Closed: ask first. Nothing has been applied yet, so cancelling
    // leaves the card exactly where it was (the board snaps it back).
    let choice: ResolutionChoice | null = null;
    if (move.status !== row.status && needsResolutionPrompt(row.status, move.status, row.resolution_id)) {
      const answer = await askResolution({
        status: move.status,
        count: 1,
        initial: { resolutionId: row.resolution_id ?? null, note: row.resolution_note ?? null },
      });
      if (answer.kind === "cancel") return;
      if (answer.kind === "chosen") choice = answer.choice;
    }
    const patch: Partial<Ticket> = buildTicketPatch(
      withResolution(
        {
          ...(move.status !== row.status ? { status: move.status } : {}),
          board_rank: rankOf(move.id) ?? move.rank,
        },
        choice,
      ),
    );
    const undos = [store.applyPatch([move.id], patch)];
    const writes = [updateTicketResult(move.id, patch)];
    for (const other of move.rebalance ?? []) {
      if (other.id === move.id) continue;
      undos.push(store.applyPatch([other.id], { board_rank: other.rank }));
      writes.push(updateTicketResult(other.id, { board_rank: other.rank }));
    }
    const results = await Promise.all(writes);
    const failed = results.find((r) => !r.ok);
    if (failed) {
      for (const undo of undos) undo();
      toast.error(failureText(failed, t("moveFailed")));
    }
  };

  const handleBulk = async (requested: BulkAction) => {
    // Moving to Resolved or Closed: one dialog for every selected ticket that needs it.
    let action = requested;
    if (requested.kind === "status" && anyNeedsResolutionPrompt(selectedRows, requested.status)) {
      const answer = await askResolution({
        status: requested.status,
        count: Math.max(1, selectedRows.filter((r) => r.status !== requested.status).length),
      });
      if (answer.kind === "cancel") return;
      if (answer.kind === "chosen") action = { ...requested, resolution: answer.choice };
    }
    const plan = buildBulkUpdates(action, selectedRows);
    if (plan.changed === 0) {
      toast.info(tBulk("nothingToChange"));
      return;
    }
    setBulkBusy(true);
    const failures: UpdateResult[] = [];
    // One update per field (labels: per distinct result), each for all its ids.
    const outcomes = await Promise.all(
      plan.updates.map(async (u) => {
        const undo = store.applyPatch(u.ids, u.patch);
        const result = await updateTicketsResult(u.ids, u.patch);
        if (!result.ok) {
          undo();
          failures.push(result);
        }
        return result.ok ? u.ids.length : 0;
      }),
    );
    setBulkBusy(false);
    const done = outcomes.reduce((n, c) => n + c, 0);
    if (done === plan.changed) toast.success(tBulk("done", { count: done }));
    else if (done > 0) toast.warning(tBulk("partial", { done, total: plan.changed }));
    else toast.error(failures.length > 0 ? failureText(failures[0], tBulk("failed")) : tBulk("failed"));
    if (action.kind === "label") void reloadLabels();
  };

  const handleBulkDelete = async () => {
    const ids = selectedRows.map((r) => r.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    const { error } = await createClient().from("tickets").delete().in("id", ids);
    setBulkBusy(false);
    if (error) {
      toast.error(tBulk("deleteFailed"));
      return;
    }
    store.removeRows(ids);
    setSelected(new Set());
    toast.success(tBulk("deleted", { count: ids.length }));
  };

  const handleSortChange = (key: SortKey) => setSort((prev) => toggleSort(prev, key));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border bg-muted/40 p-0.5" role="group" aria-label={tView("label")}>
            {(["board", "list"] as const).map((v) => {
              const Icon = v === "board" ? KanbanSquare : List;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={mode === v}
                  onClick={() => changeView(v)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    mode === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {tView(v)}
                </button>
              );
            })}
          </div>
          {mode === "list" ? (
            <button
              type="button"
              aria-pressed={showSla}
              onClick={toggleSlaColumn}
              className={cn(
                "inline-flex h-8 items-center rounded-md border px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                showSla
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {tView("slaColumn")}
            </button>
          ) : null}
          {mode === "list" ? (
            <button
              type="button"
              aria-pressed={showResolution}
              onClick={toggleResolutionColumn}
              className={cn(
                "inline-flex h-8 items-center rounded-md border px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                showResolution
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {tView("resolutionColumn")}
            </button>
          ) : null}
          {mode === "list" ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                {tView("groupBy", { by: tView(`group.${group}`) })}
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 border-border bg-popover">
                {GROUP_BYS.map((g) => (
                  <DropdownMenuItem key={g} onClick={() => setGroup(g)}>
                    {tView(`group.${g}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button onClick={() => setCreateOpen(true)} disabled={!canWork} title={canWork ? undefined : t("readOnly")}>
            <Plus className="size-4" />
            {t("newTicket")}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <TicketFilterBar
          filters={filters}
          onChange={setFilters}
          view={mode}
          members={members}
          teams={teams}
          knownLabels={knownLabels.map((k) => k.label)}
          mentionedCount={myMentions.count}
          resolutions={resolutions}
        />
      </div>

      <div className={cn("mt-4", mode === "list" && "rounded-xl border border-border bg-card")}>
        {view === null || store.loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : store.error ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">{t("loadFailed")}</p>
            <Button variant="outline" size="sm" onClick={() => void store.reload()}>
              {t("retry")}
            </Button>
          </div>
        ) : mode === "board" ? (
          <TicketBoard
            rows={filtered}
            totals={store.totals}
            loadedCounts={loadedCounts}
            columnLoaded={store.columnLoaded}
            loadingMore={store.loadingMore}
            filtered={narrowed}
            canWork={canWork}
            keyOf={keyOf}
            members={members}
            onOpen={openTicket}
            onMove={(move) => void handleMove(move)}
            onShowMore={(status) => void store.loadColumn(status)}
            onExpandColumn={(status) => {
              if (!store.columnLoaded[status]) void store.loadColumn(status);
            }}
            closedOpen={closedOpen}
            onClosedOpenChange={setClosedOpen}
            jiraChips={jiraChips}
            waiting={waiting}
          />
        ) : listRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <TicketIcon className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
            {narrowed ? (
              <Button variant="outline" size="sm" onClick={() => setFilters(emptyFilters())}>
                {t("clearFilters")}
              </Button>
            ) : null}
          </div>
        ) : (
          <TicketListView
            rows={listRows}
            sort={sort}
            onSortChange={handleSortChange}
            groupBy={group}
            selected={selected}
            onSelectedChange={setSelected}
            canWork={canWork}
            keyOf={keyOf}
            members={members}
            nameOf={nameOf}
            onOpen={openTicket}
            onPatch={(id, patch) => void handlePatch(id, patch)}
            hasMore={store.listHasMore}
            loadingMore={store.loadingMore === "list"}
            onLoadMore={() => void store.loadMore()}
            jiraChips={jiraChips}
            waiting={waiting}
            showSla={showSla}
            showResolution={showResolution}
            resolutionName={resolutionName}
          />
        )}
      </div>

      {mode === "list" && selectedRows.length > 0 ? (
        <TicketBulkBar
          count={selectedRows.length}
          members={members}
          teams={teams}
          knownLabels={knownLabels}
          canDelete={canDelete}
          busy={bulkBusy}
          onApply={(action) => void handleBulk(action)}
          onDelete={() => void handleBulkDelete()}
          onClear={() => setSelected(new Set())}
          jiraTickets={selectedRows.map((r) => ({ id: r.id, key: keyOf(r.ticket_number), subject: r.subject }))}
          onJiraDone={() => void store.reload()}
        />
      ) : null}

      {resolutionDialog}

      <CreateTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(ticket) => void store.refreshOne(ticket.id)}
        onOpenCreated={openTicket}
      />

      <TicketDetailDialog
        ticketId={openTicketId}
        onOpenChange={(open) => !open && closeTicket()}
        onChanged={(id, patch) => (patch ? store.applyPatch([id], patch) : void store.refreshOne(id))}
        onDeleted={(id) => store.removeRows([id])}
        onOpenTicket={openTicket}
      />
    </div>
  );
}
