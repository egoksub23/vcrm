"use client";

import { severityText } from "@/lib/incidents/severity-display";
import { useStatusOptions } from "@/hooks/use-status-options";
import { useTranslations } from "next-intl";
import { AlertTriangle, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { IncidentSeverity, IncidentStatus } from "@/lib/incidents/constants";
import { incidentTypeLabel, severityRank } from "@/lib/incidents/constants";
import { useStandardCatalogue } from "@/hooks/use-incident-standard";

// ============================================================
// The small pieces every incident surface shares (list row, board card,
// detail header): severity badge, status lozenge, type chip, escalation
// indicator. Same soft-tint-lozenge convention as ticket-visuals.tsx.
// ============================================================

export const SEVERITY_STYLE: Record<IncidentSeverity, string> = {
  P1: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  P2: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  P3: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  P4: "bg-muted text-muted-foreground border-border",
};

// Additional slug aliases used by non-BNM standards (ISO 27035, ISO 45001)
const _SEVERITY_STYLE_EXT: Record<string, string> = {
  critical:  "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  high:      "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  medium:    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  low:       "bg-muted text-muted-foreground border-border",
  fatal:     "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  major:     "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  minor:     "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  near_miss: "bg-muted text-muted-foreground border-border",
};

/** Returns the badge class for any severity slug (BNM P1–P4 or future standards). */
export function severityStyle(slug: string): string {
  return (
    SEVERITY_STYLE[slug as IncidentSeverity] ??
    _SEVERITY_STYLE_EXT[slug.toLowerCase()] ??
    "bg-muted text-muted-foreground border-border"
  );
}

/** The 3px coloured edge on a board card, by severity. Every scale (BNM
 *  P1-P4, School / ISO critical-low) shares the same four tiers. */
const _EDGE_BY_RANK = ["border-l-red-500", "border-l-orange-500", "border-l-amber-500", "border-l-border"];

export function severityEdge(slug: string): string {
  return _EDGE_BY_RANK[severityRank(slug)] ?? "border-l-border";
}

export const STATUS_STYLE: Record<IncidentStatus, string> = {
  reported: "bg-red-500/15 text-red-700 dark:text-red-300",
  triaged: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  contained: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  investigating: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  recovered: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  closed: "bg-muted text-muted-foreground",
};

const _BNM_SEVERITY_SLUGS = new Set(["P1", "P2", "P3", "P4"]);

export function SeverityBadge({
  severity,
  label,
  standardId,
  className,
}: {
  severity: string;
  label?: string;
  /** The template the incident was raised under, so a school's "Serious" shows as
   *  such rather than the raw slug. */
  standardId?: string | null;
  className?: string;
}) {
  const t = useTranslations("Incidents.common.severity");
  const catalogue = useStandardCatalogue(standardId);
  const catalogueLabel = catalogue?.severities.find((s) => s.slug === severity)?.label;
  const displayLabel =
    label ?? (_BNM_SEVERITY_SLUGS.has(severity) ? t(severity as IncidentSeverity) : (catalogueLabel ?? severity));
  // A school's named levels are numbered as well (P1 · Critical), most serious first.
  const numbered = !label && !_BNM_SEVERITY_SLUGS.has(severity) && catalogue ? severityText(severity, catalogue.severities) : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-wide",
        severityStyle(severity),
        className,
      )}
    >
      {severityRank(severity) === 0 ? <AlertTriangle className="size-3" /> : null}
      {numbered ?? (displayLabel.toLowerCase() === severity.toLowerCase() ? displayLabel : `${severity} · ${displayLabel}`)}
    </span>
  );
}

export function StatusLozenge({ status, statusKey, className }: { status: IncidentStatus; /** The school's own status, when the incident is in one (migration 226). */ statusKey?: string | null; className?: string }) {
  const { label } = useStatusOptions();
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-[4px] px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-wide uppercase",
        STATUS_STYLE[status],
        className,
      )}
    >
      {label(status, statusKey)}
    </span>
  );
}

export function TypeChip({ code, standardId, className }: { code: string; standardId?: string | null; className?: string }) {
  const catalogue = useStandardCatalogue(standardId);
  const name = catalogue?.types.find((ty) => ty.code === code)?.name ?? incidentTypeLabel(code);
  return (
    <span className={cn("inline-flex items-center gap-1 truncate text-[12px] text-muted-foreground", className)}>
      <ShieldAlert className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Small "L2" / "L3" chip shown once an incident has auto- or manually
 *  escalated past its first level — silent at level 1 (nothing to flag yet). */
export function EscalationChip({ level, className }: { level: number; className?: string }) {
  const t = useTranslations("Incidents.common");
  if (level <= 1) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[4px] bg-red-500/15 px-1.5 py-0.5 text-[11px] leading-none font-bold text-red-700 dark:text-red-300",
        className,
      )}
    >
      {t("escalationLevel", { level })}
    </span>
  );
}
