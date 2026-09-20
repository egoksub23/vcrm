"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Search, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/tickets/constants";
import {
  UNASSIGNED,
  countActiveFilters,
  emptyFilters,
  type QuickFilter,
  type TicketFilters,
} from "@/lib/tickets/filters";
import type { Profile, Team } from "@/types";
import { PersonAvatar, PriorityIcon, StatusLozenge, TypeIcon } from "./ticket-visuals";
import { SavedFiltersMenu } from "./ticket-saved-filters";

const QUICK: QuickFilter[] = ["mine", "unassigned", "overdue", "today", "sla_at_risk", "sla_breached"];

/** A dropdown of checkable options; several can be on, and the trigger says how many. */
function MultiFilter({
  label,
  options,
  selected,
  onChange,
  empty,
}: {
  label: string;
  options: { value: string; label: ReactNode }[];
  selected: string[];
  onChange: (next: string[]) => void;
  empty?: string;
}) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
          selected.length > 0
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-card text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        {selected.length > 0 ? (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {selected.length}
          </span>
        ) : null}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 border-border bg-popover">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{empty}</p>
        ) : (
          options.map((o) => (
            <DropdownMenuCheckboxItem
              key={o.value}
              checked={selected.includes(o.value)}
              onCheckedChange={() => toggle(o.value)}
            >
              <span className="flex min-w-0 items-center gap-2">{o.label}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The bar above the board and the list: search (a key like VIR-12, a number
 * or words), quick chips, dropdown filters, saved filters. The filters live
 * in the page's state and in the URL (the page keeps the two in step), so a
 * link carries them.
 */
export function TicketFilterBar({
  filters,
  onChange,
  view,
  members,
  teams,
  knownLabels,
}: {
  filters: TicketFilters;
  onChange: (next: TicketFilters) => void;
  view: "board" | "list";
  members: Profile[];
  teams: Team[];
  knownLabels: string[];
}) {
  const t = useTranslations("Tickets.filters");
  const tCommon = useTranslations("Tickets.common");

  // The search box keeps its own text and reports it after a pause. It
  // follows `filters.q` again when that changes from elsewhere (Clear
  // filters, a saved filter), but not for the echo of its own report.
  const [text, setText] = useState(filters.q);
  const [seen, setSeen] = useState(filters.q);
  const [reported, setReported] = useState(filters.q);
  if (filters.q !== seen) {
    setSeen(filters.q);
    if (filters.q !== reported) {
      setText(filters.q);
      setReported(filters.q);
    }
  }
  useEffect(() => {
    if (text === reported) return;
    const handle = setTimeout(() => {
      setReported(text);
      onChange({ ...filters, q: text });
    }, 250);
    return () => clearTimeout(handle);
    // `filters` deliberately left out: only a new text should restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const set = (patch: Partial<TicketFilters>) => onChange({ ...filters, ...patch });
  const toggleQuick = (chip: QuickFilter) =>
    set({ quick: filters.quick.includes(chip) ? filters.quick.filter((c) => c !== chip) : [...filters.quick, chip] });

  const listView = view === "list";
  const active = countActiveFilters(filters, listView);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
          className="h-8 w-56 rounded-md border border-border bg-card pr-2 pl-8 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("quickLabel")}>
        {QUICK.map((chip) => {
          const on = filters.quick.includes(chip);
          return (
            <button
              key={chip}
              type="button"
              aria-pressed={on}
              onClick={() => toggleQuick(chip)}
              className={cn(
                "h-8 rounded-md border px-2.5 text-[13px] font-medium transition-colors",
                on
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(`quick.${chip}`)}
            </button>
          );
        })}
      </div>

      <MultiFilter
        label={t("assignee")}
        selected={filters.assignees}
        onChange={(assignees) => set({ assignees })}
        options={[
          {
            value: UNASSIGNED,
            label: (
              <>
                <PersonAvatar name="" size="sm" className="bg-muted text-muted-foreground" />
                {tCommon("unassigned")}
              </>
            ),
          },
          ...members.map((m) => ({
            value: m.user_id,
            label: (
              <>
                <PersonAvatar name={m.full_name} avatarUrl={m.avatar_url} size="sm" />
                <span className="truncate">{m.full_name}</span>
              </>
            ),
          })),
        ]}
      />
      <MultiFilter
        label={t("type")}
        selected={filters.types}
        onChange={(types) => set({ types: types as TicketFilters["types"] })}
        options={TICKET_CATEGORIES.map((c) => ({ value: c, label: <TypeIcon category={c} withLabel /> }))}
      />
      <MultiFilter
        label={t("priority")}
        selected={filters.priorities}
        onChange={(priorities) => set({ priorities: priorities as TicketFilters["priorities"] })}
        options={TICKET_PRIORITIES.map((p) => ({ value: p, label: <PriorityIcon priority={p} withLabel /> }))}
      />
      <MultiFilter
        label={t("label")}
        selected={filters.labels}
        onChange={(labels) => set({ labels })}
        empty={t("noLabels")}
        options={[...new Set([...knownLabels, ...filters.labels])].map((l) => ({ value: l, label: <span className="truncate">{l}</span> }))}
      />
      {teams.length > 0 ? (
        <MultiFilter
          label={t("team")}
          selected={filters.teams}
          onChange={(next) => set({ teams: next })}
          options={teams.map((tm) => ({ value: tm.id, label: <span className="truncate">{tm.name}</span> }))}
        />
      ) : null}
      {listView ? (
        <MultiFilter
          label={t("status")}
          selected={filters.statuses}
          onChange={(statuses) => set({ statuses: statuses as TicketFilters["statuses"] })}
          options={TICKET_STATUSES.map((s) => ({ value: s, label: <StatusLozenge status={s} /> }))}
        />
      ) : null}

      {active > 0 ? (
        <button
          type="button"
          onClick={() => {
            setText("");
            setReported("");
            onChange(emptyFilters());
          }}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
          {t("clear")}
        </button>
      ) : null}

      <div className="ml-auto">
        <SavedFiltersMenu filters={filters} onApply={(f) => onChange(f)} hasActive={active > 0} />
      </div>
    </div>
  );
}
