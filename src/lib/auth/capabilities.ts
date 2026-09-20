// ============================================================
// Capability catalogue and resolution — pure, unit-testable, no I/O.
//
// A capability is one named thing a person may do or see. Each role
// has a set of them: the built-in default below, plus whatever an
// Owner/Admin has switched on or off for that role (stored as sparse
// overrides in `role_capabilities`, migration 079).
//
// The catalogue is mirrored in SQL by migration 079 (+ `audit.view` in 082,
// + the approvals capabilities in 084)
// (`capability_catalogue` + `role_capability_defaults`); a test
// (`capabilities-sql.test.ts`) fails if the two disagree, and
// `capability-parity.test.ts` proves the defaults equal the role
// floor every converted route/policy enforced before this feature.
//
// Keys are stable identifiers, never rename one. Every key needs an
// i18n label + description under `Permissions.cap.<i18nId>` (see
// `capabilityI18nId`).
//
// Enforcement tiers (be honest, the screen shows them):
//   - 'database': the rule also lives in Postgres (RLS policy or a
//     SECURITY DEFINER RPC calls `has_capability()`), so it cannot be
//     bypassed by calling the database with the user's own login.
//   - 'app': enforced by API routes (`requireCapability`) and by the
//     screens. The underlying table may still be written straight
//     from the browser under the OLD role floor in RLS, so removing
//     the capability blocks the app and the API but not a determined
//     person with their own token. Phase 5 moves those tables over.
//
// `minGrantRole` is the lowest role that can technically be given the
// capability today: below the database's current floor a switch would
// appear to work in the app but the database would still refuse it.
// The database function `set_role_capabilities` enforces the same
// value (column `capability_catalogue.min_grant_role`).
// ============================================================

import { ACCOUNT_ROLES, roleRank, type AccountRole } from "./roles";

export type CapabilityGroup =
  | "menus"
  | "inbox"
  | "contacts"
  | "automation"
  | "tickets"
  | "tags"
  | "knowledge"
  | "ai"
  | "channels"
  | "workspace"
  | "people";

/** Display order of groups on the Roles & permissions screen. */
export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  "menus",
  "inbox",
  "contacts",
  "automation",
  "tickets",
  "tags",
  "knowledge",
  "ai",
  "channels",
  "workspace",
  "people",
] as const;

export type EnforcedBy = "database" | "app";

export interface CapabilityDef {
  /** Stable dotted key, e.g. `tags.manage`. Also the DB primary key. */
  key: string;
  group: CapabilityGroup;
  /** Roles that have it out of the box. Owner is always included. */
  defaultRoles: readonly AccountRole[];
  enforcedBy: EnforcedBy;
  /** Lowest role that can be granted this capability (see header). */
  minGrantRole: AccountRole;
  /** True when the capability only shows/hides UI or reads data. */
  readOnly?: boolean;
}

/** Roles at or above `min`, lowest first. */
function from(min: AccountRole): readonly AccountRole[] {
  return ACCOUNT_ROLES.filter((r) => roleRank(r) >= roleRank(min));
}

const ALL = from("viewer");
const AGENT_UP = from("agent");
const ADMIN_UP = from("admin");

const def = (
  key: string,
  group: CapabilityGroup,
  defaultRoles: readonly AccountRole[],
  minGrantRole: AccountRole,
  enforcedBy: EnforcedBy = "app",
  readOnly = false,
): CapabilityDef => ({ key, group, defaultRoles, enforcedBy, minGrantRole, readOnly });

const menu = (name: string): CapabilityDef =>
  def(`menu.${name}`, "menus", ALL, "viewer", "app", true);

export const MENU_CAPABILITIES = [
  "menu.dashboard",
  "menu.inbox",
  "menu.notifications",
  "menu.contacts",
  "menu.pipelines",
  "menu.broadcasts",
  "menu.tickets",
  "menu.automations",
  "menu.flows",
  "menu.knowledge",
  "menu.agents",
  "menu.reports",
  "menu.settings",
] as const;

/**
 * The catalogue. Order is display order within a group.
 *
 * Notes on the split / merge decisions made while mapping the real
 * routes and policies:
 *   - `contacts.edit` also covers deleting contacts and contact notes
 *     (RLS: agent) and applying tags to a contact (route: agent).
 *   - `conversations.manage` also covers personal inbox views (route:
 *     agent) and internal notes; shared views are `inbox.shared-views`.
 *   - `knowledge.draft` also covers importing, gap handling and the
 *     translate/mark-current routes on the caller's own drafts.
 *   - `channels.manage` covers every channel config + message templates
 *     and the sample-comment tool.
 *   - `ai.use` covers the Translate job; `ai.configure` its routing.
 */
export const CAPABILITIES: readonly CapabilityDef[] = [
  // ---- Menus (show/hide a sidebar item and block its page) ----
  ...MENU_CAPABILITIES.map((k) => menu(k.slice("menu.".length))),

  // ---- Inbox ----
  def("messages.send", "inbox", AGENT_UP, "agent"),
  def("conversations.manage", "inbox", AGENT_UP, "agent"),
  def("comments.moderate", "inbox", AGENT_UP, "agent"),
  def("comments.delete", "inbox", ADMIN_UP, "agent"),
  def("inbox.shared-views", "inbox", ADMIN_UP, "admin"),

  // ---- Contacts and sales ----
  def("contacts.edit", "contacts", AGENT_UP, "agent"),
  def("contacts.merge", "contacts", AGENT_UP, "agent"),
  def("deals.manage", "contacts", AGENT_UP, "agent"),
  def("pipelines.configure", "contacts", ADMIN_UP, "admin"),
  def("broadcasts.send", "contacts", AGENT_UP, "agent"),

  // ---- Automation ----
  def("automations.manage", "automation", AGENT_UP, "agent"),
  def("flows.manage", "automation", AGENT_UP, "agent"),

  // ---- Tickets ----
  def("tickets.work", "tickets", AGENT_UP, "agent"),
  def("tickets.delete", "tickets", ADMIN_UP, "admin"),
  def("tickets.configure-form", "tickets", ADMIN_UP, "admin"),

  // ---- Tags, labels, snippets ----
  // Migration 084: the write policies of `tags` and `quick_replies` call
  // has_capability(), so a review step cannot be bypassed from the browser.
  def("tags.manage", "tags", ADMIN_UP, "admin", "database"),
  def("snippets.manage", "tags", AGENT_UP, "agent", "database"),
  // Propose and approve (migration 084). Without the direct `manage`
  // capability a change is recorded as pending; without either it is denied.
  def("tags.propose", "tags", AGENT_UP, "agent", "database"),
  def("snippets.propose", "tags", AGENT_UP, "agent", "database"),

  // ---- Knowledge ----
  def("knowledge.draft", "knowledge", AGENT_UP, "agent"),
  def("knowledge.publish", "knowledge", ADMIN_UP, "admin"),
  def("knowledge.manage", "knowledge", ADMIN_UP, "admin"),

  // ---- AI ----
  def("ai.use", "ai", AGENT_UP, "agent"),
  def("ai.configure", "ai", ADMIN_UP, "agent", "database"),

  // ---- Channels and integrations ----
  def("channels.manage", "channels", ADMIN_UP, "agent", "database"),
  def("api.manage", "channels", ADMIN_UP, "agent", "database"),

  // ---- Workspace ----
  def("settings.workspace", "workspace", ADMIN_UP, "admin"),
  def("reports.view", "workspace", ALL, "viewer", "app", true),
  // Migration 082: the audit log's RLS policy and its SECURITY DEFINER
  // readers call has_capability(..., 'audit.view').
  def("audit.view", "workspace", ADMIN_UP, "agent", "database", true),
  // Migration 084: the approvals RPCs (approvals_list, decide_proposal ...)
  // and the queue's routes check it.
  def("approvals.review", "workspace", ADMIN_UP, "agent", "database"),

  // ---- People ----
  def("members.invite", "people", ADMIN_UP, "admin"),
  def("members.change-role", "people", ADMIN_UP, "admin", "database"),
  def("members.remove", "people", ADMIN_UP, "admin", "database"),
  def("teams.manage", "people", ADMIN_UP, "admin"),
  def("roles.manage", "people", ADMIN_UP, "admin", "database"),
];

export type CapabilityKey = (typeof MENU_CAPABILITIES)[number] | (
  | "messages.send"
  | "conversations.manage"
  | "comments.moderate"
  | "comments.delete"
  | "inbox.shared-views"
  | "contacts.edit"
  | "contacts.merge"
  | "deals.manage"
  | "pipelines.configure"
  | "broadcasts.send"
  | "automations.manage"
  | "flows.manage"
  | "tickets.work"
  | "tickets.delete"
  | "tickets.configure-form"
  | "tags.manage"
  | "snippets.manage"
  | "tags.propose"
  | "snippets.propose"
  | "knowledge.draft"
  | "knowledge.publish"
  | "knowledge.manage"
  | "ai.use"
  | "ai.configure"
  | "channels.manage"
  | "api.manage"
  | "settings.workspace"
  | "reports.view"
  | "audit.view"
  | "approvals.review"
  | "members.invite"
  | "members.change-role"
  | "members.remove"
  | "teams.manage"
  | "roles.manage"
);

export const CAPABILITY_KEYS: readonly CapabilityKey[] = CAPABILITIES.map(
  (c) => c.key as CapabilityKey,
);

const BY_KEY: ReadonlyMap<string, CapabilityDef> = new Map(
  CAPABILITIES.map((c) => [c.key, c]),
);

export function getCapability(key: string): CapabilityDef | undefined {
  return BY_KEY.get(key);
}

export function isCapabilityKey(key: unknown): key is CapabilityKey {
  return typeof key === "string" && BY_KEY.has(key);
}

/**
 * i18n id for a capability: `messages.send` -> `messages_send`,
 * `tickets.configure-form` -> `tickets_configure_form`. next-intl keys
 * cannot contain dots, so labels live at `Permissions.cap.<id>.label`
 * and `.description`.
 */
export function capabilityI18nId(key: string): string {
  return key.replace(/[.-]/g, "_");
}

// ------------------------------------------------------------
// Defaults and resolution
// ------------------------------------------------------------

/** Effective default capability set per role. Owner has everything. */
export const DEFAULT_CAPABILITIES: Readonly<
  Record<AccountRole, ReadonlySet<string>>
> = Object.fromEntries(
  ACCOUNT_ROLES.map((role) => [
    role,
    new Set(
      CAPABILITIES.filter(
        (c) => role === "owner" || c.defaultRoles.includes(role),
      ).map((c) => c.key),
    ),
  ]),
) as unknown as Record<AccountRole, ReadonlySet<string>>;

/** Sparse per-role overrides: capability -> granted. */
export type CapabilityOverrides = Readonly<Record<string, boolean>>;

/**
 * Turn `role_capabilities` rows for ONE role into an overrides map.
 */
export function overridesFromRows(
  rows: readonly { capability: string; granted: boolean }[] | null | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of rows ?? []) out[r.capability] = r.granted;
  return out;
}

/** Can `role` ever hold `cap` as an override grant? (Mirrors the DB.) */
export function roleCanBeGranted(role: AccountRole, cap: string): boolean {
  const entry = BY_KEY.get(cap);
  if (!entry) return false;
  return roleRank(role) >= roleRank(entry.minGrantRole);
}

/**
 * Effective capability set for a role: default, then overrides.
 * Owner always has everything and ignores overrides. Unknown keys
 * are dropped (deny by default). A grant override below the
 * capability's `minGrantRole` is ignored, exactly as `has_capability()`
 * ignores it in the database.
 */
export function resolveCapabilities(
  role: AccountRole,
  overrides?: CapabilityOverrides | null,
): Set<string> {
  if (role === "owner") return new Set(DEFAULT_CAPABILITIES.owner);
  const out = new Set(DEFAULT_CAPABILITIES[role]);
  if (!overrides) return out;
  for (const [cap, granted] of Object.entries(overrides)) {
    if (!BY_KEY.has(cap)) continue;
    if (granted === true) {
      if (roleCanBeGranted(role, cap)) out.add(cap);
    } else if (granted === false) {
      out.delete(cap);
    }
  }
  return out;
}

/** Convenience: does `role` (with overrides) hold `cap`? Unknown => false. */
export function roleHasCapability(
  role: AccountRole,
  overrides: CapabilityOverrides | null | undefined,
  cap: string,
): boolean {
  if (!BY_KEY.has(cap)) return false;
  return resolveCapabilities(role, overrides).has(cap);
}

// ------------------------------------------------------------
// Editing rules (mirrored inside `set_role_capabilities`)
// ------------------------------------------------------------

/**
 * Owner edits admin/agent/viewer; Admin edits agent/viewer only;
 * nobody edits owner, and nobody edits a role at or above their own.
 */
export function canEditRole(
  editorRole: AccountRole,
  targetRole: AccountRole,
): boolean {
  if (targetRole === "owner") return false;
  return roleRank(targetRole) < roleRank(editorRole);
}

/** Roles the editor may edit, highest first. */
export function editableRoles(editorRole: AccountRole): AccountRole[] {
  return ACCOUNT_ROLES.filter((r) => canEditRole(editorRole, r)).reverse();
}

type CapSet = ReadonlySet<string> | readonly string[];

function has(set: CapSet, cap: string): boolean {
  return Array.isArray(set)
    ? (set as readonly string[]).includes(cap)
    : (set as ReadonlySet<string>).has(cap);
}

/** Nobody can grant a capability they do not hold themselves. */
export function canGrant(editorCaps: CapSet, cap: string): boolean {
  return BY_KEY.has(cap) && has(editorCaps, cap);
}

export type SwitchBlockReason =
  /** The editor may not edit this role at all (owner, own role, above). */
  | "role-not-editable"
  /** The editor does not hold the capability they would be granting. */
  | "editor-lacks"
  /** The role sits below the lowest role the database can support. */
  | "below-min-role"
  /** Unknown capability. */
  | "unknown";

/**
 * Why a switch must be greyed for the editor, or null if it may be
 * flipped. Turning a capability OFF is always allowed for an
 * editable role; only turning ON is restricted.
 */
export function switchBlockReason(input: {
  editorRole: AccountRole;
  editorCaps: CapSet;
  targetRole: AccountRole;
  cap: string;
  /** The value the switch would take. */
  wantGranted: boolean;
}): SwitchBlockReason | null {
  const { editorRole, editorCaps, targetRole, cap, wantGranted } = input;
  if (!BY_KEY.has(cap)) return "unknown";
  if (!canEditRole(editorRole, targetRole)) return "role-not-editable";
  if (!wantGranted) return null;
  if (!roleCanBeGranted(targetRole, cap)) return "below-min-role";
  if (!canGrant(editorCaps, cap)) return "editor-lacks";
  return null;
}

// ------------------------------------------------------------
// Presets (design section 3.3)
// ------------------------------------------------------------

export interface CapabilityPreset {
  id: "support-manager" | "chat-only-agent" | "read-only-stakeholder";
  /** The role this preset is meant for (informational). */
  role: AccountRole;
  /** Capabilities switched OFF relative to the role's default. */
  revoke: readonly string[];
}

export const PRESETS: readonly CapabilityPreset[] = [
  {
    id: "support-manager",
    role: "admin",
    revoke: [
      "ai.configure",
      "channels.manage",
      "api.manage",
      "settings.workspace",
    ],
  },
  {
    id: "chat-only-agent",
    role: "agent",
    revoke: [
      "menu.broadcasts",
      "menu.automations",
      "menu.flows",
      "menu.pipelines",
      "menu.reports",
      "broadcasts.send",
      "automations.manage",
      "flows.manage",
      "deals.manage",
    ],
  },
  {
    id: "read-only-stakeholder",
    role: "viewer",
    // Menus limited to Dashboard, Inbox, Reports, Tickets.
    revoke: MENU_CAPABILITIES.filter(
      (m) =>
        m !== "menu.dashboard" &&
        m !== "menu.inbox" &&
        m !== "menu.reports" &&
        m !== "menu.tickets",
    ),
  },
];

export function getPreset(id: string): CapabilityPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/**
 * The full desired capability set when `preset` is applied to
 * `role`: the role's defaults minus what the preset revokes.
 */
export function presetCapabilities(
  role: AccountRole,
  preset: CapabilityPreset,
): Set<string> {
  const out = new Set(DEFAULT_CAPABILITIES[role]);
  for (const cap of preset.revoke) out.delete(cap);
  return out;
}

/**
 * Convert a desired capability set for `role` into the minimal
 * `changes` object for `set_role_capabilities`: `true`/`false` for
 * each capability that differs from the CURRENT effective set. Keys
 * already matching are omitted.
 */
export function diffCapabilities(
  current: ReadonlySet<string>,
  desired: ReadonlySet<string>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of CAPABILITIES) {
    const now = current.has(c.key);
    const want = desired.has(c.key);
    if (now !== want) out[c.key] = want;
  }
  return out;
}

// ------------------------------------------------------------
// Legacy `useCan` actions -> capabilities
// ------------------------------------------------------------

/**
 * The six legacy `useCan` action strings mapped onto capabilities so
 * nothing else breaks. `view-only`, `delete-account` and
 * `transfer-ownership` are role facts, not capabilities (owner-only
 * actions stay outside the matrix), so they map to `null`.
 */
export const LEGACY_CAN_ACTIONS: Readonly<Record<string, string | null>> = {
  "manage-members": "members.change-role",
  "edit-settings": "settings.workspace",
  "send-messages": "messages.send",
  "view-only": null,
  "delete-account": null,
  "transfer-ownership": null,
};
