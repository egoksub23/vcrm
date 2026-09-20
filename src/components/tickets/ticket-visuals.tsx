"use client";

import { useTranslations } from "next-intl";
import { format } from "date-fns";
import {
  Bug,
  Calendar,
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  CreditCard,
  Lightbulb,
  Minus,
  MoreHorizontal,
  Ticket as TicketIcon,
  UserCog,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { dueState, endOfDueDay } from "@/lib/tickets/due";
import { isDoneStatus } from "@/lib/tickets/constants";
import type { TicketCategory, TicketPriority, TicketStatus } from "@/types";

// ============================================================
// The small pieces every ticket surface shares (board card, list row, detail,
// filters): status lozenge, priority and type icons, avatar chip, label
// lozenge, due-date chip. Jira-like density, on Vircle's own tokens.
// ============================================================

/** Lozenge colours per status: a soft tinted background with readable text in
 *  both themes. */
export const STATUS_STYLE: Record<TicketStatus, string> = {
  open: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  in_progress: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  resolved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground",
};

/** Solid dot per status (column headers, history rows). */
export const STATUS_DOT: Record<TicketStatus, string> = {
  open: "bg-sky-500",
  in_progress: "bg-indigo-500",
  pending: "bg-amber-500",
  resolved: "bg-emerald-500",
  closed: "bg-muted-foreground",
};

/** The 3px coloured edge on the left of a board card. */
export const PRIORITY_EDGE: Record<TicketPriority, string> = {
  urgent: "border-l-red-500",
  high: "border-l-orange-500",
  normal: "border-l-border",
  low: "border-l-sky-500",
};

const PRIORITY_ICON: Record<TicketPriority, { icon: LucideIcon; className: string }> = {
  urgent: { icon: ChevronsUp, className: "text-red-500" },
  high: { icon: ChevronUp, className: "text-orange-500" },
  normal: { icon: Minus, className: "text-muted-foreground" },
  low: { icon: ChevronDown, className: "text-sky-500" },
};

const TYPE_ICON: Record<TicketCategory, { icon: LucideIcon; className: string }> = {
  bug: { icon: Bug, className: "bg-red-500 text-white" },
  feature_request: { icon: Lightbulb, className: "bg-emerald-500 text-white" },
  technical: { icon: Wrench, className: "bg-blue-500 text-white" },
  billing: { icon: CreditCard, className: "bg-violet-500 text-white" },
  account: { icon: UserCog, className: "bg-teal-500 text-white" },
  general: { icon: TicketIcon, className: "bg-slate-500 text-white" },
  other: { icon: MoreHorizontal, className: "bg-slate-400 text-white" },
};

export function StatusLozenge({ status, className }: { status: TicketStatus; className?: string }) {
  const t = useTranslations("Tickets.common.status");
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-wide uppercase",
        STATUS_STYLE[status],
        className,
      )}
    >
      {t(status)}
    </span>
  );
}

export function PriorityIcon({
  priority,
  className,
  withLabel = false,
}: {
  priority: TicketPriority;
  className?: string;
  withLabel?: boolean;
}) {
  const t = useTranslations("Tickets.common.priority");
  const { icon: Icon, className: color } = PRIORITY_ICON[priority];
  return (
    <span className={cn("inline-flex items-center gap-1", color, className)} title={t(priority)}>
      <Icon className="size-4 shrink-0" aria-hidden />
      {withLabel ? <span className="text-[13px] text-foreground">{t(priority)}</span> : <span className="sr-only">{t(priority)}</span>}
    </span>
  );
}

export function TypeIcon({
  category,
  className,
  withLabel = false,
}: {
  category: TicketCategory;
  className?: string;
  withLabel?: boolean;
}) {
  const t = useTranslations("Tickets.common.type");
  const { icon: Icon, className: color } = TYPE_ICON[category];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={t(category)}>
      <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-[3px]", color)}>
        <Icon className="size-3" aria-hidden />
      </span>
      {withLabel ? <span className="text-[13px] text-foreground">{t(category)}</span> : <span className="sr-only">{t(category)}</span>}
    </span>
  );
}

/** Initials for an avatar chip: first letters of the first two words. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + second).toUpperCase();
}

const AVATAR_TONES = [
  "bg-sky-500/20 text-sky-700 dark:text-sky-300",
  "bg-violet-500/20 text-violet-700 dark:text-violet-300",
  "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  "bg-rose-500/20 text-rose-700 dark:text-rose-300",
  "bg-teal-500/20 text-teal-700 dark:text-teal-300",
];

function toneFor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/** Round chip with initials; a photo when the profile has one. */
export function PersonAvatar({
  name,
  avatarUrl,
  size = "md",
  className,
}: {
  name: string | null | undefined;
  avatarUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dims = size === "sm" ? "size-5 text-[9px]" : size === "lg" ? "size-8 text-xs" : "size-6 text-[10px]";
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={avatarUrl} alt={name ?? ""} title={name ?? undefined} className={cn("shrink-0 rounded-full object-cover", dims, className)} />;
  }
  return (
    <span
      title={name ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        dims,
        toneFor(name ?? "?"),
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

export function LabelLozenge({
  label,
  onRemove,
  removeLabel,
  className,
}: {
  label: string;
  onRemove?: () => void;
  /** Accessible name of the remove button. */
  removeLabel?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-[4px] bg-muted px-1.5 py-0.5 text-[11px] leading-none font-medium text-foreground/80",
        className,
      )}
    >
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={removeLabel}
          className="-mr-0.5 rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/** Due date chip: red once overdue, amber on the day it is due, muted after. */
export function DueChip({
  dueDate,
  status,
  className,
  now,
}: {
  dueDate: string | null | undefined;
  status: TicketStatus;
  className?: string;
  now?: Date;
}) {
  const t = useTranslations("Tickets.common");
  const state = dueState(dueDate, now, isDoneStatus(status));
  if (state === "none") return null;
  const end = endOfDueDay(dueDate!);
  const tone =
    state === "overdue"
      ? "bg-red-500/15 text-red-700 dark:text-red-300"
      : state === "soon"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-medium", tone, className)}
      title={t(`due.${state === "later" || state === "done" ? "on" : state}`, { date: end ? format(end, "PP") : "" })}
    >
      <Calendar className="size-3" aria-hidden />
      {end ? format(end, "MMM d") : dueDate}
    </span>
  );
}
