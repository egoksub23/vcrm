"use client";

import { Clock, Hourglass, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { chipState, type ChipState } from "@/lib/approvals/rules";
import type { ApprovalColumns } from "@/lib/approvals/types";
import { cn } from "@/lib/utils";

const TONE: Record<ChipState, string> = {
  pending:
    "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  pending_changes:
    "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  rejected: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  changes_rejected:
    "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

const ICON = {
  pending: Clock,
  pending_changes: Hourglass,
  rejected: XCircle,
  changes_rejected: XCircle,
} as const;

/**
 * The chip a tag, label or snippet wears while it (or a change to it) waits
 * for a decision: Pending (amber), Pending changes (amber), Rejected (red,
 * with the reviewer's note as its tooltip). Renders nothing when the viewer
 * has no business seeing a proposal (a non-reviewer who did not propose it).
 */
export function ApprovalChip({
  row,
  viewerId,
  canReview,
  className,
}: {
  row: ApprovalColumns;
  viewerId: string | null | undefined;
  canReview: boolean;
  className?: string;
}) {
  const t = useTranslations("Approvals.chips");
  const state = chipState(row, viewerId, canReview);
  if (!state) return null;

  const Icon = ICON[state];
  const note = row.decision_note?.trim();
  const rejected = state === "rejected" || state === "changes_rejected";
  const mine = !!viewerId && row.proposed_by === viewerId;
  const tip = rejected
    ? note
      ? t("rejectedTip", { note })
      : t("rejectedNoNote")
    : state === "pending"
      ? t(mine ? "pendingTip" : "pendingReviewTip")
      : t(mine ? "pendingChangesTip" : "pendingChangesReviewTip");

  return (
    <span
      title={tip}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONE[state],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {t(state)}
      <span className="sr-only">{tip}</span>
    </span>
  );
}
