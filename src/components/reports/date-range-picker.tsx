"use client";

import { Calendar, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { startOfLocalDay } from "@/lib/dashboard/date-utils";
import type { DateRange } from "@/lib/reports/date-utils";

export type ReportPreset = "today" | "7d" | "14d" | "30d" | "90d" | "thisMonth";

const PRESETS: ReportPreset[] = ["today", "7d", "14d", "30d", "90d", "thisMonth"];

/** Resolves a preset key into a concrete local-day range, `to` always
 *  being today — reports show data up through now, never a future
 *  cutoff. */
export function presetToRange(preset: ReportPreset): DateRange {
  const to = startOfLocalDay();
  const from = new Date(to);
  switch (preset) {
    case "today":
      break;
    case "7d":
      from.setDate(from.getDate() - 6);
      break;
    case "14d":
      from.setDate(from.getDate() - 13);
      break;
    case "30d":
      from.setDate(from.getDate() - 29);
      break;
    case "90d":
      from.setDate(from.getDate() - 89);
      break;
    case "thisMonth":
      from.setDate(1);
      break;
  }
  return { from, to };
}

interface DateRangePickerProps {
  preset: ReportPreset;
  onChange: (preset: ReportPreset) => void;
}

/**
 * Preset-only range picker — no custom from/to calendar yet (no such
 * component exists anywhere in the app today; the gap-analysis roadmap
 * flags a real calendar picker as a fast-follow). These six presets
 * cover the range respond.io's own report screenshots showed, so
 * shipping this now beats blocking the whole reporting suite on a
 * calendar widget.
 */
export function DateRangePicker({ preset, onChange }: DateRangePickerProps) {
  const t = useTranslations("Reports.dateRange");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm text-foreground hover:bg-muted">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
        {t(preset)}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border-border bg-popover">
        {PRESETS.map((p) => (
          <DropdownMenuItem
            key={p}
            onClick={() => onChange(p)}
            className={p === preset ? "font-medium text-primary" : undefined}
          >
            {t(p)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
