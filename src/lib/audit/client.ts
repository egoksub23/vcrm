// ============================================================
// Browser-side helpers for the audit screens — pure, unit-testable.
// ============================================================

import type { AuditEntry, AuditFilters } from "./types";

export const RANGE_PRESETS = ["24h", "7d", "30d", "all", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const HOUR = 3_600_000;
const PRESET_MS: Readonly<Record<string, number>> = {
  "24h": 24 * HOUR,
  "7d": 7 * 24 * HOUR,
  "30d": 30 * 24 * HOUR,
};

/**
 * The [from, to) window for a preset. `custom` takes two `yyyy-mm-dd`
 * dates from the date inputs: both are interpreted in the browser's own
 * time zone, and `to` is inclusive of that whole day. Blank / invalid
 * custom dates leave that side open.
 */
export function resolveRange(
  preset: RangePreset,
  custom: { from: string; to: string } = { from: "", to: "" },
  now: Date = new Date(),
): { from: string | null; to: string | null } {
  if (preset === "all") return { from: null, to: null };
  if (preset !== "custom") {
    return { from: new Date(now.getTime() - PRESET_MS[preset]).toISOString(), to: null };
  }
  const start = parseLocalDate(custom.from);
  const endDay = parseLocalDate(custom.to);
  const end = endDay ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1) : null;
  return {
    from: start ? start.toISOString() : null,
    to: end ? end.toISOString() : null,
  };
}

function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Query string for the list / export routes. */
export function buildAuditParams(
  filters: AuditFilters,
  extra: { cursor?: string | null; limit?: number } = {},
): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.actor) p.set("actor", filters.actor);
  if (filters.action) p.set("action", filters.action);
  if (filters.entityType) p.set("entity_type", filters.entityType);
  if (filters.from) p.set("from", filters.from);
  if (filters.to) p.set("to", filters.to);
  if (filters.q) p.set("q", filters.q);
  if (extra.limit) p.set("limit", String(extra.limit));
  if (extra.cursor) p.set("cursor", extra.cursor);
  return p;
}

/**
 * Where to send someone who clicks the item, or null when there is
 * nowhere sensible (removed, or no screen of its own).
 */
export function entityHref(
  entry: Pick<AuditEntry, "entityType" | "entityId" | "entityExists">,
): string | null {
  // tag / snippet / article / team: only while the item still exists.
  if (entry.entityExists === false) return null;
  const id = entry.entityId;
  switch (entry.entityType) {
    case "tag":
      return "/settings?tab=tags";
    case "snippet":
      return "/settings?tab=quick-replies";
    case "article":
      return id ? `/knowledge/${id}` : null;
    case "team":
      return "/settings?tab=teams";
    case "conversation":
      return id ? `/inbox?c=${id}` : null;
    case "member":
    case "invitation":
      return "/settings?tab=members";
    case "role":
      return "/settings?tab=roles";
    case "channel_config":
      return "/settings?tab=channels";
    case "jira_connection":
      return "/settings?tab=integrations";
    case "api_key":
    case "webhook":
      return "/settings?tab=api";
    default:
      return null;
  }
}
