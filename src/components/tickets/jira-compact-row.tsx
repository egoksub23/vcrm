"use client";

import { formatDistance } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslations } from "next-intl";

import type { TicketJiraLinkRow } from "@/lib/jira/types";
import { categoryTone, loose, normalizeCategory } from "@/lib/tickets/jira-ui";
import { cn } from "@/lib/utils";

/**
 * One linked issue as a single compact line: key, summary, status lozenge and
 * the per-issue sync state (synced / paused / broken). Used when a ticket links
 * more than two issues; pressing it opens the full card. Presentational; Jira
 * text is untrusted and rendered as text.
 */
export function TicketJiraCompactRow({
  link,
  expanded,
  onToggle,
  now,
}: {
  link: TicketJiraLinkRow;
  expanded: boolean;
  onToggle: () => void;
  /** Fixed clock for tests. */
  now?: Date;
}) {
  const t = useTranslations("Jira.depth");
  const category = normalizeCategory(link.status_category);
  const tone =
    link.sync_state === "ok"
      ? "border-border text-muted-foreground"
      : link.sync_state === "paused"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
        : "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200";
  const syncText =
    link.sync_state === "ok"
      ? link.last_synced_at
        ? t("syncState.okWhen", { when: formatDistance(new Date(link.last_synced_at), now ?? new Date(), { addSuffix: true }) })
        : t("syncState.ok")
      : loose(t)(`syncState.${link.sync_state}`);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={t("compact.toggle", { key: link.issue_key })}
      className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="font-mono text-xs font-semibold text-foreground">{link.issue_key}</span>
      <span className="min-w-0 flex-1 basis-32 truncate text-[13px] text-foreground">{link.summary ?? ""}</span>
      {link.status_name ? (
        <span className={cn("inline-flex max-w-full items-center truncate rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-wide uppercase", categoryTone(category))}>
          {link.status_name}
        </span>
      ) : null}
      <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", tone)}>{syncText}</span>
      {expanded ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    </button>
  );
}
