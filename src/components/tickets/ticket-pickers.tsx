"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, orderedTransitions } from "@/lib/tickets/constants";
import { PersonAvatar, PriorityIcon, StatusLozenge, TypeIcon, STATUS_STYLE } from "./ticket-visuals";
import type { Profile, Team, TicketCategory, TicketPriority, TicketStatus } from "@/types";

// ============================================================
// Dropdown pickers used inline on list rows, in the detail sidebar and in the
// bulk bar. One shape: a trigger that shows the current value, a menu of
// options, `disabled` for read-only viewers. Menus stop click propagation so a
// pick inside a clickable row does not also open the ticket.
// ============================================================

interface PickerOption {
  value: string;
  label: ReactNode;
  selected?: boolean;
}

function PickerMenu({
  trigger,
  triggerClassName,
  options,
  onSelect,
  disabled,
  heading,
  contentClassName,
  align = "start",
  triggerLabel,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  options: PickerOption[];
  onSelect: (value: string) => void;
  disabled?: boolean;
  heading?: string;
  contentClassName?: string;
  align?: "start" | "end";
  triggerLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={triggerLabel}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "inline-flex items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
          !disabled && "cursor-pointer hover:brightness-95 dark:hover:brightness-110",
          triggerClassName,
        )}
      >
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn("w-56 border-border bg-popover", contentClassName)}
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuGroup>
          {heading ? <DropdownMenuLabel>{heading}</DropdownMenuLabel> : null}
          {options.map((o) => (
            <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)} className="justify-between">
              <span className="flex min-w-0 items-center gap-2">{o.label}</span>
              {o.selected ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Transition menu: the statuses an agent most likely wants next come first. */
export function StatusMenu({
  status,
  onChange,
  disabled,
  variant = "lozenge",
}: {
  status: TicketStatus;
  onChange: (next: TicketStatus) => void;
  disabled?: boolean;
  /** `button` is the large transition button of the detail view. */
  variant?: "lozenge" | "button";
}) {
  const t = useTranslations("Tickets.common");
  const tStatus = useTranslations("Tickets.common.status");
  const options: PickerOption[] = orderedTransitions(status).map((s) => ({
    value: s,
    label: <StatusLozenge status={s} />,
  }));
  if (variant === "button") {
    return (
      <PickerMenu
        trigger={
          <>
            <span className="uppercase">{tStatus(status)}</span>
            {!disabled ? <ChevronDown className="size-3.5" /> : null}
          </>
        }
        triggerClassName={cn("h-8 gap-1.5 rounded-md px-3 text-xs font-bold tracking-wide", STATUS_STYLE[status])}
        options={options}
        onSelect={(v) => onChange(v as TicketStatus)}
        disabled={disabled}
        heading={t("transitionTo")}
        triggerLabel={t("changeStatus")}
      />
    );
  }
  return (
    <PickerMenu
      trigger={
        <>
          <StatusLozenge status={status} />
          {!disabled ? <ChevronDown className="size-3 text-muted-foreground" /> : null}
        </>
      }
      options={options}
      onSelect={(v) => onChange(v as TicketStatus)}
      disabled={disabled}
      heading={t("transitionTo")}
      triggerLabel={t("changeStatus")}
    />
  );
}

export function PriorityMenu({
  priority,
  onChange,
  disabled,
  withLabel = false,
}: {
  priority: TicketPriority;
  onChange: (next: TicketPriority) => void;
  disabled?: boolean;
  withLabel?: boolean;
}) {
  const t = useTranslations("Tickets.common");
  return (
    <PickerMenu
      trigger={
        <>
          <PriorityIcon priority={priority} withLabel={withLabel} />
          {!disabled && withLabel ? <ChevronDown className="size-3 text-muted-foreground" /> : null}
        </>
      }
      triggerClassName={withLabel ? "-mx-1.5 px-1.5 py-1 hover:bg-muted" : "p-0.5"}
      options={TICKET_PRIORITIES.map((p) => ({
        value: p,
        label: <PriorityIcon priority={p} withLabel />,
        selected: p === priority,
      }))}
      onSelect={(v) => onChange(v as TicketPriority)}
      disabled={disabled}
      triggerLabel={t("changePriority")}
    />
  );
}

export function TypeMenu({
  category,
  onChange,
  disabled,
}: {
  category: TicketCategory;
  onChange: (next: TicketCategory) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Tickets.common");
  return (
    <PickerMenu
      trigger={
        <>
          <TypeIcon category={category} withLabel />
          {!disabled ? <ChevronDown className="size-3 text-muted-foreground" /> : null}
        </>
      }
      triggerClassName="-mx-1.5 px-1.5 py-1 hover:bg-muted"
      options={TICKET_CATEGORIES.map((c) => ({
        value: c,
        label: <TypeIcon category={c} withLabel />,
        selected: c === category,
      }))}
      onSelect={(v) => onChange(v as TicketCategory)}
      disabled={disabled}
      triggerLabel={t("changeType")}
    />
  );
}

const UNASSIGNED_VALUE = "__unassigned__";

/** Assignee picker: everyone in the account with their avatar, plus Unassigned. */
export function AssigneeMenu({
  assigneeId,
  members,
  onChange,
  disabled,
  withName = true,
}: {
  assigneeId: string | null | undefined;
  members: Profile[];
  onChange: (userId: string | null) => void;
  disabled?: boolean;
  withName?: boolean;
}) {
  const t = useTranslations("Tickets.common");
  const current = members.find((m) => m.user_id === assigneeId);
  return (
    <PickerMenu
      trigger={
        <>
          {assigneeId ? (
            <PersonAvatar name={current?.full_name ?? t("unknownPerson")} avatarUrl={current?.avatar_url} />
          ) : (
            <PersonAvatar name="" className="bg-muted text-muted-foreground" />
          )}
          {withName ? (
            <span className={cn("truncate text-[13px]", assigneeId ? "text-foreground" : "text-muted-foreground")}>
              {assigneeId ? (current?.full_name ?? t("unknownPerson")) : t("unassigned")}
            </span>
          ) : null}
        </>
      }
      triggerClassName={cn("min-w-0 max-w-full", withName && "-mx-1 px-1 py-0.5 hover:bg-muted")}
      options={[
        {
          value: UNASSIGNED_VALUE,
          label: (
            <>
              <PersonAvatar name="" size="sm" className="bg-muted text-muted-foreground" />
              {t("unassigned")}
            </>
          ),
          selected: !assigneeId,
        },
        ...members.map((m) => ({
          value: m.user_id,
          label: (
            <>
              <PersonAvatar name={m.full_name} avatarUrl={m.avatar_url} size="sm" />
              <span className="truncate">{m.full_name}</span>
            </>
          ),
          selected: m.user_id === assigneeId,
        })),
      ]}
      onSelect={(v) => onChange(v === UNASSIGNED_VALUE ? null : v)}
      disabled={disabled}
      triggerLabel={t("changeAssignee")}
    />
  );
}

const NO_TEAM_VALUE = "__none__";

export function TeamMenu({
  teamId,
  teams,
  onChange,
  disabled,
}: {
  teamId: string | null | undefined;
  teams: Team[];
  onChange: (teamId: string | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Tickets.common");
  const current = teams.find((tm) => tm.id === teamId);
  return (
    <PickerMenu
      trigger={
        <>
          <span className={cn("truncate text-[13px]", current ? "text-foreground" : "text-muted-foreground")}>
            {current?.name ?? t("noTeam")}
          </span>
          {!disabled ? <ChevronDown className="size-3 text-muted-foreground" /> : null}
        </>
      }
      triggerClassName="-mx-1.5 min-w-0 max-w-full px-1.5 py-1 hover:bg-muted"
      options={[
        { value: NO_TEAM_VALUE, label: t("noTeam"), selected: !teamId },
        ...teams.map((tm) => ({ value: tm.id, label: <span className="truncate">{tm.name}</span>, selected: tm.id === teamId })),
      ]}
      onSelect={(v) => onChange(v === NO_TEAM_VALUE ? null : v)}
      disabled={disabled}
      triggerLabel={t("changeTeam")}
    />
  );
}
