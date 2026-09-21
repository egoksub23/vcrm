"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronsLeft, ChevronsRight, Loader2, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { TICKET_STATUSES } from "@/lib/tickets/constants";
import type { JiraChip } from "@/lib/tickets/jira-ui";
import { compareByRank, planDrop, rebalanceRanks } from "@/lib/tickets/rank";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import type { TicketRow } from "@/hooks/use-ticket-store";
import type { Profile, TicketMention, TicketStatus } from "@/types";
import { JiraKeyChips } from "./jira-key-chip";
import { WaitingOnYouChip } from "./ticket-waiting-chip";
import { TicketSlaBadge } from "./ticket-sla-badge";
import {
  DueChip,
  LabelLozenge,
  PRIORITY_EDGE,
  PersonAvatar,
  PriorityIcon,
  STATUS_DOT,
  TypeIcon,
} from "./ticket-visuals";

export interface BoardMove {
  id: string;
  status: TicketStatus;
  rank: number;
  /** Every card in the column with its new rank, when the neighbours had
   *  run out of room for a midpoint. */
  rebalance: { id: string; rank: number }[] | null;
}

interface TicketBoardProps {
  /** Tickets to show (filters already applied). */
  rows: TicketRow[];
  totals: Record<TicketStatus, number>;
  /** How many tickets of each status are loaded (before filters), to know
   *  whether a column has more to show. */
  loadedCounts: Record<TicketStatus, number>;
  columnLoaded: Record<TicketStatus, boolean>;
  loadingMore: string | null;
  /** Whether filters / search are narrowing the board (counts then show what matches). */
  filtered: boolean;
  canWork: boolean;
  keyOf: (ticketNumber: number) => string;
  members: Profile[];
  onOpen: (id: string) => void;
  onMove: (move: BoardMove) => void;
  onShowMore: (status: TicketStatus) => void;
  /** Called when Closed is opened, so the parent can fetch it. */
  onExpandColumn: (status: TicketStatus) => void;
  closedOpen: boolean;
  onClosedOpenChange: (open: boolean) => void;
  /** Linked Jira issue keys per ticket id (optional: cards show up to two). */
  jiraChips?: Record<string, JiraChip[]>;
  /** The oldest open "needs your response" request per ticket id (migration 095). */
  waiting?: Record<string, TicketMention>;
}

const columnId = (s: TicketStatus) => `col:${s}`;
const isColumnId = (id: string | number) => String(id).startsWith("col:");

type Columns = Record<TicketStatus, string[]>;

function containerOf(id: string | number, cols: Columns): TicketStatus | null {
  const sid = String(id);
  if (isColumnId(sid)) return sid.slice(4) as TicketStatus;
  return TICKET_STATUSES.find((s) => cols[s].includes(sid)) ?? null;
}

// ---- Card -------------------------------------------------------------------

function CardBody({
  row,
  keyText,
  members,
  overlay = false,
  jiraChips,
  waiting,
}: {
  row: TicketRow;
  keyText: string;
  members: Profile[];
  overlay?: boolean;
  jiraChips?: JiraChip[];
  waiting?: TicketMention;
}) {
  const t = useTranslations("Tickets.board");
  const assignee = members.find((m) => m.user_id === row.assigned_agent_id);
  const customer = row.contact ? row.contact.name || contactHandle(row.contact) : "";
  const shownLabels = row.labels.slice(0, 3);
  return (
    <div
      className={cn(
        "rounded-md border border-l-[3px] border-border bg-card p-2.5 text-[13px] shadow-xs transition-shadow",
        PRIORITY_EDGE[row.priority],
        overlay ? "rotate-1 shadow-lg ring-1 ring-primary/30" : "hover:shadow-md",
      )}
    >
      <p className="line-clamp-2 leading-snug font-medium text-foreground">{row.subject}</p>
      {customer ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{customer}</p> : null}
      {waiting ? (
        <div className="mt-1.5">
          <WaitingOnYouChip request={waiting} members={members} />
        </div>
      ) : null}
      {shownLabels.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {shownLabels.map((l) => (
            <LabelLozenge key={l} label={l} />
          ))}
          {row.labels.length > shownLabels.length ? (
            <span className="text-[11px] text-muted-foreground">+{row.labels.length - shownLabels.length}</span>
          ) : null}
        </div>
      ) : null}
      {jiraChips && jiraChips.length > 0 ? (
        <div className="mt-1.5">
          <JiraKeyChips chips={jiraChips} />
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <TypeIcon category={row.category} />
        <span className="font-mono text-[11px] text-muted-foreground">{keyText}</span>
        <PriorityIcon priority={row.priority} />
        <DueChip dueDate={row.due_date} status={row.status} />
        <TicketSlaBadge ticket={row} compact />
        <span className="ml-auto flex items-center gap-2">
          {row.comment_count > 0 ? (
            <span
              className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground"
              title={t("commentCount", { count: row.comment_count })}
            >
              <MessageSquare className="size-3" aria-hidden />
              {row.comment_count}
            </span>
          ) : null}
          {row.assigned_agent_id ? (
            <PersonAvatar name={assignee?.full_name ?? "?"} avatarUrl={assignee?.avatar_url} size="sm" />
          ) : null}
        </span>
      </div>
    </div>
  );
}

function SortableCard({
  row,
  keyText,
  members,
  canWork,
  onOpen,
  jiraChips,
  waiting,
}: {
  row: TicketRow;
  keyText: string;
  members: Profile[];
  canWork: boolean;
  onOpen: (id: string) => void;
  jiraChips?: JiraChip[];
  waiting?: TicketMention;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    disabled: !canWork,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`${keyText} ${row.subject}`}
      onClick={() => onOpen(row.id)}
      onKeyDown={(e) => {
        // Space picks a card up (dnd-kit); Enter opens it.
        listeners?.onKeyDown?.(e);
        if (e.key === "Enter") onOpen(row.id);
      }}
      className={cn(
        "cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        isDragging && "opacity-40",
      )}
    >
      <CardBody row={row} keyText={keyText} members={members} jiraChips={jiraChips} waiting={waiting} />
    </div>
  );
}

// ---- Column --------------------------------------------------------------------

function Column({
  status,
  ids,
  rowMap,
  total,
  hasMore,
  filtered,
  loadingMore,
  canWork,
  keyOf,
  members,
  onOpen,
  onShowMore,
  onCollapse,
  jiraChips,
  waiting,
}: {
  status: TicketStatus;
  ids: string[];
  rowMap: Map<string, TicketRow>;
  total: number;
  hasMore: boolean;
  filtered: boolean;
  loadingMore: boolean;
  canWork: boolean;
  keyOf: (n: number) => string;
  members: Profile[];
  onOpen: (id: string) => void;
  onShowMore: () => void;
  onCollapse?: () => void;
  jiraChips?: Record<string, JiraChip[]>;
  waiting?: Record<string, TicketMention>;
}) {
  const t = useTranslations("Tickets.board");
  const tStatus = useTranslations("Tickets.common.status");
  const { setNodeRef, isOver } = useDroppable({ id: columnId(status), disabled: !canWork });
  const count = hasMore && !filtered ? t("countOf", { shown: ids.length, total }) : `${ids.length}${hasMore ? "+" : ""}`;
  return (
    <section
      aria-label={tStatus(status)}
      className={cn(
        "flex h-full w-[280px] min-w-[280px] flex-1 flex-col rounded-lg border border-transparent bg-muted/60 dark:bg-muted/30",
        isOver && "border-primary/40 bg-primary/5",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className={cn("size-2 rounded-full", STATUS_DOT[status])} aria-hidden />
        <h3 className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">{tStatus(status)}</h3>
        <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            title={t("hideColumn")}
            aria-label={t("hideColumn")}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-background/70 hover:text-foreground"
          >
            <ChevronsLeft className="size-4" />
          </button>
        ) : null}
      </header>
      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {ids.map((id) => {
            const row = rowMap.get(id);
            return row ? (
              <SortableCard
                key={id}
                row={row}
                keyText={keyOf(row.ticket_number)}
                members={members}
                canWork={canWork}
                onOpen={onOpen}
                jiraChips={jiraChips?.[id]}
                waiting={waiting?.[id]}
              />
            ) : null;
          })}
        </SortableContext>
        {ids.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t("dropHere")}
          </div>
        ) : null}
        {hasMore ? (
          <button
            type="button"
            onClick={onShowMore}
            disabled={loadingMore}
            className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-primary hover:bg-background/70 disabled:opacity-60"
          >
            {loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
            {t("showMore", { count: Math.max(0, total - ids.length) })}
          </button>
        ) : null}
      </div>
    </section>
  );
}

// ---- Board ---------------------------------------------------------------------

export function TicketBoard({
  rows,
  totals,
  loadedCounts,
  columnLoaded,
  loadingMore,
  filtered,
  canWork,
  keyOf,
  members,
  onOpen,
  onMove,
  onShowMore,
  onExpandColumn,
  closedOpen,
  onClosedOpenChange,
  jiraChips,
  waiting,
}: TicketBoardProps) {
  const t = useTranslations("Tickets.board");
  const tStatus = useTranslations("Tickets.common.status");

  const rowMap = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const baseColumns = useMemo<Columns>(() => {
    const cols = { open: [], in_progress: [], pending: [], resolved: [], closed: [] } as Columns;
    for (const r of [...rows].sort(compareByRank)) cols[r.status].push(r.id);
    return cols;
  }, [rows]);

  // While a card is being dragged the columns are a local copy that follows
  // the pointer; the real order is only written on drop.
  const [dragColumns, setDragColumns] = useState<Columns | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const columns = dragColumns ?? baseColumns;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Space picks a card up and drops it; Enter is kept for opening it.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const cardLabel = (id: string | number) => {
    const r = rowMap.get(String(id));
    return r ? `${keyOf(r.ticket_number)} ${r.subject}` : String(id);
  };
  const columnLabel = (id: string | number) => {
    const s = containerOf(id, columns);
    return s ? tStatus(s) : "";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("a11y.picked", { card: cardLabel(active.id) }),
    onDragOver: ({ active, over }) => (over ? t("a11y.over", { card: cardLabel(active.id), column: columnLabel(over.id) }) : undefined),
    onDragEnd: ({ active, over }) =>
      over ? t("a11y.dropped", { card: cardLabel(active.id), column: columnLabel(over.id) }) : t("a11y.cancelled", { card: cardLabel(active.id) }),
    onDragCancel: ({ active }) => t("a11y.cancelled", { card: cardLabel(active.id) }),
  };

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    setDragColumns(structuredClone(baseColumns));
  };

  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !dragColumns) return;
    const from = containerOf(active.id, dragColumns);
    const to = containerOf(over.id, dragColumns);
    if (!from || !to || from === to) return;
    setDragColumns((prev) => {
      if (!prev) return prev;
      const source = prev[from].filter((id) => id !== String(active.id));
      const target = [...prev[to]];
      let index = target.length;
      if (!isColumnId(over.id)) {
        const overIndex = target.indexOf(String(over.id));
        const below =
          active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
        index = overIndex + (below ? 1 : 0);
      }
      target.splice(index, 0, String(active.id));
      return { ...prev, [from]: source, [to]: target };
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const cols = dragColumns;
    setActiveId(null);
    setDragColumns(null);
    if (!over || !cols) return;
    const id = String(active.id);
    const row = rowMap.get(id);
    const to = containerOf(id, cols);
    if (!row || !to) return;

    let finalIds = cols[to];
    const overStatus = containerOf(over.id, cols);
    if (!isColumnId(over.id) && overStatus === to && over.id !== active.id) {
      finalIds = arrayMove(finalIds, finalIds.indexOf(id), finalIds.indexOf(String(over.id)));
    }
    const index = finalIds.indexOf(id);
    if (to === row.status && index === baseColumns[to].indexOf(id)) return; // dropped where it was

    const others = finalIds.filter((x) => x !== id);
    const otherRanks = others.map((x) => rowMap.get(x)?.board_rank ?? 0);
    const plan = planDrop(otherRanks, index);
    let rebalance: BoardMove["rebalance"] = null;
    if (plan.rebalance) {
      const ordered = [...otherRanks];
      ordered.splice(index, 0, plan.rank);
      const spread = rebalanceRanks(ordered);
      const orderedIds = [...others];
      orderedIds.splice(index, 0, id);
      rebalance = orderedIds.map((cardId, i) => ({ id: cardId, rank: spread[i] }));
    }
    onMove({ id, status: to, rank: plan.rank, rebalance });
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setDragColumns(null);
  };

  const activeRow = activeId ? rowMap.get(activeId) : null;

  const renderColumn = (status: TicketStatus, onCollapse?: () => void) => {
    const total = totals[status];
    return (
      <Column
        key={status}
        status={status}
        ids={columns[status]}
        rowMap={rowMap}
        total={total}
        hasMore={columnLoaded[status] && loadedCounts[status] < total && !dragColumns}
        filtered={filtered}
        loadingMore={loadingMore === status}
        canWork={canWork}
        keyOf={keyOf}
        members={members}
        onOpen={onOpen}
        onShowMore={() => onShowMore(status)}
        onCollapse={onCollapse}
        jiraChips={jiraChips}
        waiting={waiting}
      />
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t("a11y.instructions") },
      }}
    >
      <div className="flex h-[calc(100vh-17rem)] min-h-[420px] gap-3 overflow-x-auto pb-2">
        {TICKET_STATUSES.filter((s) => s !== "closed").map((s) => renderColumn(s))}
        {closedOpen ? (
          renderColumn("closed", () => onClosedOpenChange(false))
        ) : (
          <button
            type="button"
            onClick={() => {
              onClosedOpenChange(true);
              onExpandColumn("closed");
            }}
            className="flex h-full w-11 min-w-11 shrink-0 flex-col items-center gap-3 rounded-lg bg-muted/60 py-3 text-muted-foreground hover:bg-muted dark:bg-muted/30"
            title={t("showColumn", { status: tStatus("closed") })}
            aria-label={t("showColumn", { status: tStatus("closed") })}
          >
            <ChevronsRight className="size-4" />
            <span className="text-[11px] font-bold tracking-wide uppercase [writing-mode:vertical-rl]">
              {tStatus("closed")}
            </span>
            <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[11px] font-medium">{totals.closed}</span>
          </button>
        )}
      </div>
      <DragOverlay>
        {activeRow ? <CardBody row={activeRow} keyText={keyOf(activeRow.ticket_number)} members={members} overlay jiraChips={jiraChips?.[activeRow.id]} waiting={waiting?.[activeRow.id]} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
