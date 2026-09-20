"use client";

import { Fragment, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsUpDown, Loader2 } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { UNASSIGNED } from "@/lib/tickets/filters";
import type { JiraChip } from "@/lib/tickets/jira-ui";
import { groupTickets, type GroupBy, type SortKey, type SortSpec } from "@/lib/tickets/sort-group";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { useSharedNow } from "@/hooks/use-shared-now";
import type { TicketRow } from "@/hooks/use-ticket-store";
import type { Profile, Ticket } from "@/types";
import { JiraKeyChips } from "./jira-key-chip";
import { AssigneeMenu, PriorityMenu, StatusMenu } from "./ticket-pickers";
import { TicketSlaBadge } from "./ticket-sla-badge";
import { DueChip, LabelLozenge, PersonAvatar, PriorityIcon, StatusLozenge, TypeIcon } from "./ticket-visuals";

interface TicketListViewProps {
  /** Tickets to show, already filtered and sorted. */
  rows: TicketRow[];
  sort: SortSpec;
  onSortChange: (key: SortKey) => void;
  groupBy: GroupBy;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  canWork: boolean;
  keyOf: (ticketNumber: number) => string;
  members: Profile[];
  nameOf: (userId: string | null | undefined, fallback?: string) => string;
  onOpen: (id: string) => void;
  /** An inline edit of one ticket (optimistic; the page saves it). */
  onPatch: (id: string, patch: Partial<Ticket>) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Linked Jira issue keys per ticket id (optional: rows show up to two next to the summary). */
  jiraChips?: Record<string, JiraChip[]>;
  /** The SLA column (migration 086); hideable from the page. Default on. */
  showSla?: boolean;
}

const COLUMNS: { key: SortKey | null; label: string; className?: string }[] = [
  { key: "key", label: "key", className: "w-24" },
  { key: "summary", label: "summary" },
  { key: "status", label: "status", className: "w-40" },
  { key: "priority", label: "priority", className: "w-28" },
  { key: "assignee", label: "assignee", className: "w-44" },
  { key: null, label: "labels", className: "w-40" },
  { key: "due", label: "due", className: "w-24" },
  { key: "sla", label: "sla", className: "w-36" },
  { key: "updated", label: "updated", className: "w-32 text-right" },
];

export function TicketListView({
  rows,
  sort,
  onSortChange,
  groupBy,
  selected,
  onSelectedChange,
  canWork,
  keyOf,
  members,
  nameOf,
  onOpen,
  onPatch,
  hasMore,
  loadingMore,
  onLoadMore,
  jiraChips,
  showSla = true,
}: TicketListViewProps) {
  const t = useTranslations("Tickets.list");
  const tCommon = useTranslations("Tickets.common");
  const tSla = useTranslations("Tickets.sla");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const now = useSharedNow(groupBy === "sla");
  const columns = useMemo(() => (showSla ? COLUMNS : COLUMNS.filter((c) => c.key !== "sla")), [showSla]);

  const groups = useMemo(
    () => (groupBy === "none" ? null : groupTickets(rows, groupBy, { assigneeName: (id) => nameOf(id), now })),
    [rows, groupBy, nameOf, now],
  );

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = !allSelected && rows.some((r) => selected.has(r.id));

  const toggleAll = () => {
    onSelectedChange(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderRow = (row: TicketRow) => {
    const isSelected = selected.has(row.id);
    const customer = row.contact ? row.contact.name || contactHandle(row.contact) : "";
    return (
      <TableRow
        key={row.id}
        data-state={isSelected ? "selected" : undefined}
        onClick={() => onOpen(row.id)}
        className="cursor-pointer text-[13px]"
      >
        <TableCell className="w-9 py-1.5 pl-3" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => toggleOne(row.id)}
            disabled={!canWork}
            aria-label={t("selectRow", { key: keyOf(row.ticket_number) })}
          />
        </TableCell>
        <TableCell className="w-8 py-1.5 pr-0">
          <TypeIcon category={row.category} />
        </TableCell>
        <TableCell className="py-1.5 font-mono text-xs text-muted-foreground">{keyOf(row.ticket_number)}</TableCell>
        <TableCell className="max-w-0 min-w-56 py-1.5 whitespace-normal">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground">{row.subject}</span>
            <JiraKeyChips chips={jiraChips?.[row.id]} className="shrink-0" />
          </div>
          {customer ? <div className="truncate text-[11px] text-muted-foreground">{customer}</div> : null}
        </TableCell>
        <TableCell className="py-1.5">
          <StatusMenu status={row.status} disabled={!canWork} onChange={(status) => onPatch(row.id, { status })} />
        </TableCell>
        <TableCell className="py-1.5">
          <PriorityMenu
            priority={row.priority}
            disabled={!canWork}
            withLabel
            onChange={(priority) => onPatch(row.id, { priority })}
          />
        </TableCell>
        <TableCell className="max-w-44 py-1.5">
          <AssigneeMenu
            assigneeId={row.assigned_agent_id}
            members={members}
            disabled={!canWork}
            onChange={(userId) => onPatch(row.id, { assigned_agent_id: userId })}
          />
        </TableCell>
        <TableCell className="py-1.5">
          <div className="flex items-center gap-1">
            {row.labels.slice(0, 2).map((l) => (
              <LabelLozenge key={l} label={l} className="max-w-20" />
            ))}
            {row.labels.length > 2 ? (
              <span className="text-[11px] text-muted-foreground">+{row.labels.length - 2}</span>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="py-1.5">
          <DueChip dueDate={row.due_date} status={row.status} />
        </TableCell>
        {showSla ? (
          <TableCell className="py-1.5">
            <TicketSlaBadge ticket={row} />
          </TableCell>
        ) : null}
        <TableCell className="py-1.5 pr-3 text-right text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(row.updated_at), { addSuffix: true })}
        </TableCell>
      </TableRow>
    );
  };

  const groupLabel = (key: string) => {
    if (groupBy === "status") return <StatusLozenge status={key as never} />;
    if (groupBy === "priority") return <PriorityIcon priority={key as never} withLabel />;
    if (groupBy === "sla") return <span>{tSla(`state.${key}` as never)}</span>;
    if (key === UNASSIGNED) {
      return (
        <>
          <PersonAvatar name="" size="sm" className="bg-muted text-muted-foreground" />
          <span className="text-muted-foreground">{tCommon("unassigned")}</span>
        </>
      );
    }
    const person = members.find((m) => m.user_id === key);
    return (
      <>
        <PersonAvatar name={person?.full_name ?? "?"} avatarUrl={person?.avatar_url} size="sm" />
        <span>{person?.full_name ?? tCommon("unknownPerson")}</span>
      </>
    );
  };

  return (
    <div>
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-9 pl-3">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={toggleAll}
                disabled={!canWork || rows.length === 0}
                aria-label={t("selectAll")}
              />
            </TableHead>
            <TableHead className="w-8 pr-0" aria-label={tCommon("typeColumn")} />
            {columns.map((c) => {
              const active = c.key !== null && sort.key === c.key;
              const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <TableHead
                  key={c.label}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cn("h-8 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase", c.className)}
                >
                  {c.key ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(c.key!)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded uppercase hover:text-foreground",
                        active && "text-foreground",
                      )}
                    >
                      {t(`col.${c.label}`)}
                      <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
                    </button>
                  ) : (
                    t(`col.${c.label}`)
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups
            ? groups.map((g) => {
                const isCollapsed = collapsed.has(g.key);
                return (
                  <Fragment key={g.key}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={columns.length + 2} className="py-1.5 pl-3">
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.key)}
                          aria-expanded={!isCollapsed}
                          className="flex items-center gap-2 text-[13px] font-medium"
                        >
                          {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                          {groupLabel(g.key)}
                          <span className="text-xs font-normal text-muted-foreground">{g.rows.length}</span>
                        </button>
                      </TableCell>
                    </TableRow>
                    {isCollapsed ? null : g.rows.map(renderRow)}
                  </Fragment>
                );
              })
            : rows.map(renderRow)}
        </TableBody>
      </Table>
      {hasMore ? (
        <div className="flex justify-center border-t border-border py-3">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-primary hover:bg-muted disabled:opacity-60"
          >
            {loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
            {t("loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
