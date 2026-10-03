// ============================================================
// Per-account platform settings (migration 132, `account_platform`):
// status, plan, limits and feature flags that the operator sets and a
// tenant's own admins can only read. Pure, no I/O, so the server context,
// the browser auth provider and the operator console share one reading of
// the row.
//
// A missing row, a missing key or a malformed value always reads as the
// permissive default (active, nothing limited, every feature on). A new
// flag must therefore never switch an existing feature off for tenants
// that predate it; the operator turns things off explicitly.
// ============================================================

export type AccountStatus = "active" | "suspended";

export interface AccountPlatform {
  status: AccountStatus;
  plan: string;
  /** e.g. `{ seats: 10 }`. An absent key means unlimited. */
  limits: Record<string, number>;
  /** e.g. `{ incidents: false }`. An absent key means enabled. */
  features: Record<string, boolean>;
  suspendedReason: string | null;
  /** When the workspace will be deleted, if the owner or the operator asked (migration 153). */
  deletionDueAt: string | null;
}

export const DEFAULT_PLATFORM: AccountPlatform = {
  status: "active",
  plan: "standard",
  limits: {},
  features: {},
  suspendedReason: null,
  deletionDueAt: null,
};

/** The flags the operator console offers. Add a key here to add a toggle. */
export const PLATFORM_FEATURES = ["incidents", "jira", "vircle_chat"] as const;
export type PlatformFeature = (typeof PLATFORM_FEATURES)[number];

/** The limits the operator console offers (and the app enforces). */
export const PLATFORM_LIMITS = [
  "seats",
  "broadcast_per_day",
  "contacts",
  "messages_per_month",
  "ai_tokens_per_month",
  "storage_mb",
] as const;
export type PlatformLimit = (typeof PLATFORM_LIMITS)[number];

/** Shown to a member of a suspended account (API message and screen). */
export const ACCOUNT_SUSPENDED_MESSAGE =
  "This account is suspended. Please contact support.";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read an `account_platform` row (or anything else) tolerantly. */
export function parsePlatformRow(row: unknown): AccountPlatform {
  if (!isPlainObject(row)) return DEFAULT_PLATFORM;

  const limits: Record<string, number> = {};
  if (isPlainObject(row.limits)) {
    for (const [k, v] of Object.entries(row.limits)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) limits[k] = v;
    }
  }
  const features: Record<string, boolean> = {};
  if (isPlainObject(row.features)) {
    for (const [k, v] of Object.entries(row.features)) {
      if (typeof v === "boolean") features[k] = v;
    }
  }

  return {
    status: row.status === "suspended" ? "suspended" : "active",
    plan: typeof row.plan === "string" && row.plan ? row.plan : DEFAULT_PLATFORM.plan,
    limits,
    features,
    suspendedReason:
      typeof row.suspended_reason === "string" && row.suspended_reason
        ? row.suspended_reason
        : null,
    deletionDueAt:
      typeof row.deletion_due_at === "string" && row.deletion_due_at ? row.deletion_due_at : null,
  };
}

export function isFeatureEnabled(
  platform: AccountPlatform | null | undefined,
  feature: string,
): boolean {
  return platform?.features[feature] !== false;
}

/** The numeric limit for `key`, or null when unlimited. */
export function limitFor(
  platform: AccountPlatform | null | undefined,
  key: PlatformLimit,
): number | null {
  const v = platform?.limits[key];
  return typeof v === "number" ? v : null;
}

// Which capabilities belong to which feature flag. A switched-off feature
// loses every one of them, so its menu, pages and routes all disappear
// through the existing capability checks instead of each being patched.
const FEATURE_CAPABILITIES: Record<PlatformFeature, (capability: string) => boolean> = {
  incidents: (c) => c === "menu.incidents" || c.startsWith("incidents."),
  // The Jira link (Settings > Integrations, the Jira section of a ticket,
  // every /api/integrations/jira route) is gated by the three jira.* caps.
  jira: (c) => c.startsWith("jira."),
  // Vircle Chat has no capability of its own: it is configured under
  // `channels.manage`, which every other channel shares. Its routes, the
  // webhook, the send path and the Settings card read the flag directly
  // (lib/vircle-chat/feature.ts, and `isFeatureEnabled` in the browser).
  vircle_chat: () => false,
};

/** Remove the capabilities of every disabled feature. Returns the same set when nothing changes. */
export function applyFeatureFlags<T extends ReadonlySet<string>>(
  capabilities: T,
  platform: AccountPlatform | null | undefined,
): T | Set<string> {
  if (!platform) return capabilities;
  const disabled = PLATFORM_FEATURES.filter((f) => !isFeatureEnabled(platform, f));
  if (disabled.length === 0) return capabilities;
  const kept = new Set<string>();
  for (const cap of capabilities) {
    if (!disabled.some((f) => FEATURE_CAPABILITIES[f](cap))) kept.add(cap);
  }
  return kept;
}
