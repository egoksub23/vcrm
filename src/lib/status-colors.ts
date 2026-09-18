/**
 * Status colors — per-account customizable colors for the Inbox's
 * conversation-status dot, the SLA-breached "overdue" pill, and the
 * priority flag (migration 057, `accounts.status_colors`). These used
 * to be hardcoded Tailwind classes in conversation-list.tsx
 * (STATUS_COLORS / PRIORITY_COLORS); now they're inline styles driven
 * by this config so an account can pick its own palette from
 * Settings → Status colors.
 */

export interface StatusColors {
  open: string;
  pending: string;
  closed: string;
  /** The SLA-breached "overdue" pill. The pre-breach "aging" tier keeps
   *  a fixed neutral amber (see conversation-list.tsx) — only the
   *  breached state is configurable here, to keep the settings panel
   *  focused on the states that carry real urgency. */
  overdue: string;
  priority: {
    urgent: string;
    high: string;
    normal: string;
    low: string;
  };
}

export const DEFAULT_STATUS_COLORS: StatusColors = {
  open: '#7c3aed',
  pending: '#f59e0b',
  closed: '#6b7280',
  overdue: '#ef4444',
  priority: {
    urgent: '#ef4444',
    high: '#fbbf24',
    normal: '#6b7280',
    low: '#38bdf8',
  },
};

/** Swatch palette offered in the Settings picker — the same 8 hues
 *  already used for tag colors (tag-manager.tsx's PRESET_COLORS) plus
 *  a neutral gray, so "closed" / "normal" have a sensible non-hue
 *  option and the two color pickers in Settings read as one system. */
export const STATUS_COLOR_SWATCHES = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#6b7280',
] as const;

/**
 * `#rrggbb` (or `#rgb`) → `rgba(r, g, b, alpha)`, for the tinted
 * pill backgrounds (e.g. the overdue chip) that need a translucent
 * version of a user-picked color — CSS has no `color-mix()` fallback
 * old enough to rely on here, and these hex values come straight from
 * `accounts.status_colors`, not `currentColor`, so a Tailwind opacity
 * modifier (`bg-red-500/15`) doesn't apply. Falls back to the color
 * as-is (opaque) if it isn't a recognizable hex string.
 */
export function hexWithAlpha(hex: string, alpha: number): string {
  const match = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  let h = match[1];
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Merges a possibly-partial/legacy-shaped JSONB value from the DB onto
 * the defaults, so a row saved before a field existed (or a
 * hand-edited row missing a key) never produces an undefined color.
 */
export function withStatusColorDefaults(value: unknown): StatusColors {
  const v = (value ?? {}) as Partial<StatusColors> & {
    priority?: Partial<StatusColors['priority']>;
  };
  return {
    open: v.open ?? DEFAULT_STATUS_COLORS.open,
    pending: v.pending ?? DEFAULT_STATUS_COLORS.pending,
    closed: v.closed ?? DEFAULT_STATUS_COLORS.closed,
    overdue: v.overdue ?? DEFAULT_STATUS_COLORS.overdue,
    priority: {
      urgent: v.priority?.urgent ?? DEFAULT_STATUS_COLORS.priority.urgent,
      high: v.priority?.high ?? DEFAULT_STATUS_COLORS.priority.high,
      normal: v.priority?.normal ?? DEFAULT_STATUS_COLORS.priority.normal,
      low: v.priority?.low ?? DEFAULT_STATUS_COLORS.priority.low,
    },
  };
}
