"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { categoryTone, visibleChips, type JiraChip } from "@/lib/tickets/jira-ui";

/** A linked Jira issue key (ENG-482) as a small lozenge, coloured by the issue's status category. */
export function JiraKeyChip({ chip, className }: { chip: JiraChip; className?: string }) {
  const t = useTranslations("Jira.chip");
  const title =
    chip.state === "broken" ? t("titleBroken", { key: chip.key }) : chip.state === "paused" ? t("titlePaused", { key: chip.key }) : t("title", { key: chip.key });
  return (
    <span
      title={title}
      data-jira-key={chip.key}
      className={cn(
        "inline-flex max-w-full items-center rounded-[4px] px-1.5 py-0.5 font-mono text-[11px] leading-none font-medium",
        categoryTone(chip.category),
        chip.state === "broken" && "line-through opacity-70",
        chip.state === "paused" && "opacity-70",
        className,
      )}
    >
      <span className="truncate">{chip.key}</span>
    </span>
  );
}

/** Up to two chips, then "+N". Renders nothing without chips. */
export function JiraKeyChips({ chips, max = 2, className }: { chips: readonly JiraChip[] | undefined; max?: number; className?: string }) {
  const t = useTranslations("Jira.chip");
  if (!chips || chips.length === 0) return null;
  const { shown, extra } = visibleChips(chips, max);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      {shown.map((c) => (
        <JiraKeyChip key={c.key} chip={c} />
      ))}
      {extra > 0 ? (
        <span className="text-[11px] text-muted-foreground" title={t("more", { count: extra })}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
