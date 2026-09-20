import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  LEGACY_CAN_ACTIONS,
  isCapabilityKey,
} from "./capabilities";
import { ACCOUNT_ROLES, hasMinRole, type AccountRole } from "./roles";
import { readMigration } from "@/lib/testing/read-migration";

// ============================================================
// THE PARITY FIXTURE
//
// Editable role capabilities (migration 079) must not change what
// anybody can do until an Owner/Admin edits the matrix. So for every
// route, RLS policy and legacy `useCan` action that was mapped onto a
// capability, this file records the role floor it enforced BEFORE the
// feature (`floor`) and the capability it enforces now, and asserts
// that for each of the four roles the capability's DEFAULT grant equals
// `hasMinRole(role, floor)`.
//
// A future edit that changes a default in capabilities.ts, or maps a
// route onto a different capability, fails here. That is the point:
// change the default on purpose, then change this table in the same
// commit and say why.
//
// `capability` is one key, or several meaning "any one of them"
// (knowledge routes accept a drafter or a publisher at the door).
// ============================================================

type Floor = AccountRole;

interface Row {
  /** Route dir under src/app/api, RLS table(s) or legacy action. */
  where: string;
  /** HTTP method, RLS operation(s) or "legacy". */
  method: string;
  /** The minimum role that was required before the feature. */
  floor: Floor;
  /** The capability now required (any one of, when an array). */
  capability: string | readonly string[];
  note?: string;
}

const row = (
  where: string,
  method: string,
  floor: Floor,
  capability: string | readonly string[],
  note?: string,
): Row => ({ where, method, floor, capability, note });

const DRAFT_OR_PUBLISH = ["knowledge.draft", "knowledge.publish"] as const;

// ------------------------------------------------------------
// 1. API routes (src/app/api/**, excluding /api/v1 which uses API-key
//    scopes, cron/webhook routes which use secrets/signatures, and the
//    new roles/capabilities routes which have no legacy floor).
// ------------------------------------------------------------
const CHANNELS_ADMIN: [string, string[]][] = [
  ["account/channels/email/oauth/start", ["GET"]],
  ["account/channels/email", ["DELETE"]],
  ["account/channels/gmail/oauth/start", ["GET"]],
  ["account/channels/gmail", ["DELETE"]],
  ["account/channels/instagram/comments", ["POST"]],
  ["account/channels/instagram/oauth/finalize", ["POST"]],
  ["account/channels/instagram/oauth/pages", ["GET"]],
  ["account/channels/instagram/oauth/start", ["GET"]],
  ["account/channels/instagram", ["PUT", "DELETE"]],
  ["account/channels/messenger/comments", ["POST"]],
  ["account/channels/messenger/oauth/finalize", ["POST"]],
  ["account/channels/messenger/oauth/pages", ["GET"]],
  ["account/channels/messenger/oauth/start", ["GET"]],
  ["account/channels/messenger", ["PUT", "DELETE"]],
  ["account/channels/tiktok/oauth/start", ["GET"]],
  ["account/channels/tiktok", ["DELETE"]],
  ["account/channels/tiktok/webhook", ["POST"]],
  ["account/channels/web-widget", ["PUT"]],
  ["comments/test", ["POST", "DELETE"]],
  ["whatsapp/templates/submit", ["POST"]],
  ["whatsapp/templates/sync", ["POST"]],
];

export const ROUTE_ROWS: readonly Row[] = [
  // ---- channels.manage (admin floor) ----
  ...CHANNELS_ADMIN.flatMap(([where, methods]) =>
    methods.map((m) => row(where, m, "admin", "channels.manage")),
  ),
  // Newly guarded: the routes had no check and relied on the RLS write
  // policy (admin) -- the check now runs before the Meta call.
  row("whatsapp/config", "POST", "admin", "channels.manage", "was RLS-only (admin)"),
  row("whatsapp/config", "DELETE", "admin", "channels.manage", "was RLS-only (admin)"),
  row("whatsapp/templates/[id]", "PATCH", "admin", "channels.manage", "was RLS-only (admin); called Meta first"),
  row("whatsapp/templates/[id]", "DELETE", "admin", "channels.manage", "was RLS-only (admin); called Meta first"),

  // ---- api.manage (admin) ----
  row("account/api-keys", "POST", "admin", "api.manage"),
  row("account/api-keys/[id]", "DELETE", "admin", "api.manage"),

  // ---- settings.workspace / people (admin) ----
  row("account", "PATCH", "admin", "settings.workspace"),
  row("account/invitations", "GET", "admin", "members.invite"),
  row("account/invitations", "POST", "admin", "members.invite"),
  row("account/invitations/[id]", "DELETE", "admin", "members.invite"),
  row("account/members/[userId]", "PATCH", "admin", "members.change-role"),
  row("account/members/[userId]", "DELETE", "admin", "members.remove"),
  row("account/members/[userId]/remove", "POST", "admin", "members.remove"),
  row("account/members/[userId]/teams", "PUT", "admin", "teams.manage"),
  row("account/members/bulk-teams", "POST", "admin", "teams.manage"),
  row("account/teams", "POST", "admin", "teams.manage"),
  row("account/teams/[id]", "PATCH", "admin", "teams.manage"),
  row("account/teams/[id]", "DELETE", "admin", "teams.manage"),
  row("account/teams/[id]/members", "POST", "admin", "teams.manage"),
  row("account/teams/[id]/members/[userId]", "DELETE", "admin", "teams.manage"),

  // ---- ai.configure (admin) / ai.use (agent) ----
  row("ai/budget", "PUT", "admin", "ai.configure"),
  row("ai/config", "POST", "admin", "ai.configure"),
  row("ai/config", "DELETE", "admin", "ai.configure"),
  row("ai/connections", "GET", "admin", "ai.configure"),
  row("ai/connections", "POST", "admin", "ai.configure"),
  row("ai/connections/[id]", "PATCH", "admin", "ai.configure"),
  row("ai/connections/[id]", "DELETE", "admin", "ai.configure"),
  row("ai/connections/[id]/test", "POST", "admin", "ai.configure"),
  row("ai/routing", "PUT", "admin", "ai.configure"),
  row("ai/test", "POST", "admin", "ai.configure"),
  row("ai/usage", "GET", "admin", "ai.configure"),
  row("ai/autoreply/[conversationId]", "POST", "agent", "ai.use"),
  row("ai/closing-note", "POST", "agent", "ai.use"),
  row("ai/draft", "POST", "agent", "ai.use"),
  row("ai/playground", "POST", "agent", "ai.use"),
  row("ai/summary", "POST", "agent", "ai.use"),

  // ---- automations / flows ----
  row("automations", "POST", "agent", "automations.manage"),
  row("automations/[id]", "PATCH", "agent", "automations.manage"),
  row("automations/[id]", "DELETE", "agent", "automations.manage"),
  row("automations/[id]/duplicate", "POST", "agent", "automations.manage"),
  row("automations/engine", "POST", "agent", "automations.manage"),
  row("flows", "POST", "agent", "flows.manage"),
  row("flows/[id]", "PUT", "agent", "flows.manage"),
  row("flows/[id]", "DELETE", "agent", "flows.manage"),
  row("flows/[id]/activate", "POST", "agent", "flows.manage"),
  // Newly guarded reads: every signed-in member could read these.
  row("automations", "GET", "viewer", "menu.automations", "was any signed-in user"),
  row("automations/[id]", "GET", "viewer", "menu.automations", "was any signed-in user"),
  row("flows", "GET", "viewer", "menu.flows", "was any signed-in user"),
  row("flows/[id]", "GET", "viewer", "menu.flows", "was any signed-in user"),
  row("flows/[id]/runs", "GET", "viewer", "menu.flows", "was any signed-in user"),
  row("flows/templates", "GET", "viewer", "menu.flows", "was any signed-in user"),

  // ---- inbox ----
  row("comments/[id]", "PATCH", "agent", "comments.moderate"),
  row("comments/sync", "POST", "agent", "comments.moderate"),
  row("comments/[id]/action", "POST", "agent", "comments.moderate"),
  row("comments/[id]/action", "POST (action=delete)", "admin", "comments.delete", "was role !== admin/owner"),
  row("conversations/[id]/comments", "POST", "agent", "conversations.manage"),
  row("conversations/[id]/labels", "POST", "agent", "conversations.manage"),
  row("conversations/[id]/labels", "DELETE", "agent", "conversations.manage"),
  row("inbox-views", "POST", "agent", "conversations.manage", "personal view"),
  row("inbox-views/[id]", "PATCH", "agent", "conversations.manage", "personal view"),
  row("inbox-views/[id]", "DELETE", "agent", "conversations.manage", "personal view"),
  row("inbox-views", "POST (shared)", "admin", "inbox.shared-views", "was role !== admin/owner"),
  row("inbox-views/[id]", "PATCH (shared)", "admin", "inbox.shared-views", "was role === admin/owner"),
  row("inbox-views/[id]", "DELETE (shared)", "admin", "inbox.shared-views", "was role === admin/owner"),
  // Migration 084: the same floor, or the propose capability (the route
  // then records a pending proposal instead of writing the snippet).
  row("quick-replies", "POST", "agent", ["snippets.manage", "snippets.propose"]),
  row("quick-replies/[id]", "PATCH", "agent", ["snippets.manage", "snippets.propose"]),
  row("quick-replies/[id]", "DELETE", "agent", "snippets.manage"),
  row("whatsapp/send", "POST", "agent", "messages.send"),
  row("whatsapp/react", "POST", "agent", "messages.send"),

  // ---- contacts / broadcasts ----
  row("contacts/merge", "POST", "agent", "contacts.merge"),
  row("contacts/[id]/tags", "POST", "agent", "contacts.edit"),
  row("contacts/[id]/tags", "DELETE", "agent", "contacts.edit"),
  row("whatsapp/broadcast", "POST", "agent", "broadcasts.send"),
  row("whatsapp/broadcast/[id]/resume", "POST", "agent", "broadcasts.send"),

  // ---- knowledge: a drafter or a publisher gets in; publish decides ----
  row("knowledge", "POST", "agent", DRAFT_OR_PUBLISH),
  row("knowledge", "POST (publish)", "admin", "knowledge.publish", "was hasMinRole(role, admin)"),
  row("knowledge/import", "POST", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/gaps/[id]", "PATCH", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/[id]", "PATCH", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/[id]", "PATCH (publish)", "admin", "knowledge.publish", "was hasMinRole(role, admin)"),
  row("knowledge/[id]", "DELETE", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/[id]", "DELETE (publish)", "admin", "knowledge.publish", "was hasMinRole(role, admin)"),
  row("knowledge/[id]/resync", "POST", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/[id]/resync", "POST (publish)", "admin", "knowledge.publish", "was hasMinRole(role, admin)"),
  row("knowledge/[id]/translate", "POST", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/[id]/translate", "POST (publish)", "admin", "knowledge.publish", "was hasMinRole(role, admin)"),
  row("knowledge/[id]/mark-current", "POST", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/[id]/mark-current", "POST (publish)", "admin", "knowledge.publish", "was hasMinRole(role, admin)"),
  row("knowledge/[id]/versions/[versionId]/restore", "POST", "agent", DRAFT_OR_PUBLISH),
  row("knowledge/[id]/versions/[versionId]/restore", "POST (publish)", "admin", "knowledge.publish", "was hasMinRole(role, admin)"),
  row("knowledge/collections", "POST", "admin", "knowledge.manage"),
  row("knowledge/collections/[id]", "PATCH", "admin", "knowledge.manage"),
  row("knowledge/collections/[id]", "DELETE", "admin", "knowledge.manage"),
  row("knowledge/reindex", "POST", "admin", "knowledge.manage"),
];

/**
 * Routes that were tightened on purpose. The old floor was lower than the
 * new default; this list exists so the change is visible and reviewed, and
 * so the default is still pinned.
 */
export const TIGHTENED_ROWS: readonly (Row & { oldFloor: Floor })[] = [
  {
    ...row(
      "whatsapp/config/verify-registration",
      "GET",
      "admin",
      "channels.manage",
      "diagnostic that calls Meta with the stored token; used only on the admin-only channel settings screen",
    ),
    oldFloor: "viewer",
  },
];

// ------------------------------------------------------------
// 2. Database tier: RLS write policies moved onto has_capability() by
//    migration 079. Old floor was is_account_member(account_id, 'admin').
//    A test below parses the migration and fails if this list and the
//    migration disagree.
// ------------------------------------------------------------
export const DB_TIER_ROWS: readonly Row[] = [
  ...[
    "whatsapp_config",
    "messenger_config",
    "instagram_config",
    "email_config",
    "gmail_config",
    "tiktok_config",
    "web_widget_config",
    "message_templates",
  ].map((t) => row(t, "insert/update/delete", "admin", "channels.manage")),
  ...["ai_configs", "ai_connections", "ai_task_routing"].map((t) =>
    row(t, "insert/update/delete", "admin", "ai.configure"),
  ),
  row("ai_connections", "select", "admin", "ai.configure"),
  row("ai_usage_log", "select", "admin", "ai.configure"),
  // Migration 082: new table, no legacy floor; Owner + Admin by default.
  row("audit_log", "select", "admin", "audit.view"),
  // Migration 084: the write policies of tags (contact tags and conversation
  // labels) and quick_replies (snippets) moved to has_capability so a
  // review step cannot be bypassed from the browser. Same floors as before.
  row("tags", "insert/update/delete", "admin", "tags.manage"),
  row("quick_replies", "insert/update/delete", "agent", "snippets.manage"),
  // Migration 084 RPCs (SECURITY DEFINER, they check the capability inside):
  // new, no legacy floor. Propose = the floor of the direct write (an Admin
  // who loses tags.manage falls back to proposing), review = Owner + Admin.
  row("propose_tag / propose_tag_edit", "rpc", "agent", "tags.propose"),
  row("propose_snippet / propose_snippet_edit", "rpc", "agent", "snippets.propose"),
  row("decide_proposal / approvals_list", "rpc", "admin", "approvals.review"),
  // Migration 085 (Jira link): new, no legacy floor, app-enforced. Every
  // /api/integrations/jira route calls requireCapability first (jira-routes.test.ts
  // proves it route by route): connect = Owner + Admin, link and share-comments =
  // Owner, Admin, Agent. A Viewer can never hold them (min grant role agent / admin).
  row("integrations/jira (connect, settings, sites, diagnostics)", "route", "admin", "jira.connect"),
  row("integrations/jira (create, link, unlink, transition, sync)", "route", "agent", "jira.link"),
  row("integrations/jira (share with Jira)", "route", "agent", "jira.share-comments"),
  ...["api_keys", "webhook_endpoints"].map((t) =>
    row(t, "insert/update/delete", "admin", "api.manage"),
  ),
];

/** The (table, capability) pairs migration 079 switches to has_capability(). */
export const DB_TIER_WRITE_TABLES: readonly [string, string][] = [
  ["whatsapp_config", "channels.manage"],
  ["messenger_config", "channels.manage"],
  ["instagram_config", "channels.manage"],
  ["email_config", "channels.manage"],
  ["gmail_config", "channels.manage"],
  ["tiktok_config", "channels.manage"],
  ["web_widget_config", "channels.manage"],
  ["message_templates", "channels.manage"],
  ["ai_configs", "ai.configure"],
  ["ai_connections", "ai.configure"],
  ["ai_task_routing", "ai.configure"],
  ["api_keys", "api.manage"],
  ["webhook_endpoints", "api.manage"],
];

// ------------------------------------------------------------
// 3. Tables that STAY on is_account_member(account_id, '<floor>') until
//    a later phase. Listed with the capability the app now uses for the
//    same action, so a default that drifts away from the RLS floor fails.
//    (Removing a capability blocks the app and the API, not a person
//    calling the database with their own token -- see EnforcedBy.)
// ------------------------------------------------------------
export const MEMBER_TIER_ROWS: readonly Row[] = [
  ...["contacts", "contact_notes", "contact_tags", "contact_custom_values"].map((t) =>
    row(t, "insert/update/delete", "agent", "contacts.edit"),
  ),
  ...["conversations", "conversation_labels"].map((t) =>
    row(t, "insert/update/delete", "agent", "conversations.manage"),
  ),
  row("messages", "insert/update/delete", "agent", "messages.send"),
  row("comments", "insert/update/delete", "agent", "comments.moderate"),
  row("deals", "insert/update/delete", "agent", "deals.manage"),
  ...["pipelines", "pipeline_stages"].map((t) =>
    row(t, "insert/update/delete", "admin", "pipelines.configure"),
  ),
  ...["broadcasts", "broadcast_recipients"].map((t) =>
    row(t, "insert/update/delete", "agent", "broadcasts.send"),
  ),
  ...["automations", "automation_steps"].map((t) =>
    row(t, "insert/update/delete", "agent", "automations.manage"),
  ),
  ...["flows", "flow_nodes"].map((t) =>
    row(t, "insert/update/delete", "agent", "flows.manage"),
  ),
  row("tickets", "insert/update", "agent", "tickets.work"),
  row("ticket_comments", "insert", "agent", "tickets.work"),
  row("tickets", "delete", "admin", "tickets.delete"),
  row("ticket_custom_fields", "insert/update/delete", "admin", "tickets.configure-form"),
  row("inbox_views", "insert/update/delete (shared, owner_id null)", "admin", "inbox.shared-views"),
  row("teams", "insert/update/delete", "admin", "teams.manage"),
  row("team_members", "insert/delete", "admin", "teams.manage"),
  row("accounts", "update", "admin", "settings.workspace"),
  row("ai_knowledge_documents", "insert/update/delete (own drafts)", "agent", "knowledge.draft"),
  row("ai_knowledge_documents", "insert/update/delete (any, published)", "admin", "knowledge.publish"),
  row("knowledge_gaps", "update", "agent", "knowledge.draft"),
  row("knowledge_collections", "insert/update/delete", "admin", "knowledge.manage"),
];

// ------------------------------------------------------------
// 4. Legacy `useCan` actions (src/lib/auth/roles.ts predicates).
// ------------------------------------------------------------
export const LEGACY_ROWS: readonly Row[] = [
  row("useCan", "manage-members", "admin", LEGACY_CAN_ACTIONS["manage-members"]!, "canManageMembers"),
  row("useCan", "edit-settings", "admin", LEGACY_CAN_ACTIONS["edit-settings"]!, "canEditSettings"),
  row("useCan", "send-messages", "agent", LEGACY_CAN_ACTIONS["send-messages"]!, "canSendMessages"),
];

// ------------------------------------------------------------
// Capabilities that gate only UI (or read data) and have no legacy
// route/policy floor to compare against, or are brand new with this
// feature. Anything else in the catalogue MUST appear in a table above.
// ------------------------------------------------------------
const UI_ONLY_ALLOW_LIST: ReadonlySet<string> = new Set([
  // Sidebar menus: menu.automations and menu.flows also appear above as
  // route reads; the others only show or hide a menu item and its page.
  "menu.dashboard",
  "menu.inbox",
  "menu.notifications",
  "menu.contacts",
  "menu.pipelines",
  "menu.broadcasts",
  "menu.tickets",
  "menu.knowledge",
  "menu.agents",
  "menu.reports",
  "menu.settings",
  // Reports are read-only screens (every role by default).
  "reports.view",
  // New with this feature: managing the matrix itself. Enforced by the
  // database function set_role_capabilities and the /api/account/roles
  // routes; there was no earlier floor to preserve.
  "roles.manage",
]);

// ============================================================
// Tests
// ============================================================

const capsOf = (r: Row): readonly string[] =>
  typeof r.capability === "string" ? [r.capability] : r.capability;

const holds = (role: AccountRole, r: Row): boolean =>
  capsOf(r).some((c) => DEFAULT_CAPABILITIES[role].has(c));

function checkTable(name: string, rows: readonly Row[]) {
  describe(name, () => {
    it("has only known capability keys", () => {
      for (const r of rows) {
        for (const c of capsOf(r)) {
          expect(isCapabilityKey(c), `${r.where} ${r.method}: unknown capability ${c}`).toBe(true);
        }
      }
    });

    for (const r of rows) {
      it(`${r.where} ${r.method} needs ${capsOf(r).join(" or ")} (old floor: ${r.floor})`, () => {
        for (const role of ACCOUNT_ROLES) {
          expect(
            holds(role, r),
            `${role} on ${r.where} ${r.method}: default capability grant differs from the old '${r.floor}' floor`,
          ).toBe(hasMinRole(role, r.floor));
        }
      });
    }
  });
}

describe("capability defaults reproduce the pre-079 role floors", () => {
  checkTable("API routes", ROUTE_ROWS);
  checkTable("database tier (RLS on has_capability)", DB_TIER_ROWS);
  checkTable("tables that stay on is_account_member", MEMBER_TIER_ROWS);
  checkTable("legacy useCan actions", LEGACY_ROWS);

  describe("deliberately tightened routes", () => {
    for (const r of TIGHTENED_ROWS) {
      it(`${r.where} ${r.method}: default is now the '${r.floor}' floor (was '${r.oldFloor}')`, () => {
        for (const role of ACCOUNT_ROLES) {
          expect(holds(role, r)).toBe(hasMinRole(role, r.floor));
        }
      });
    }
  });

  it("maps every legacy useCan action, and owner-only ones to no capability", () => {
    expect(Object.keys(LEGACY_CAN_ACTIONS).sort()).toEqual(
      ["delete-account", "edit-settings", "manage-members", "send-messages", "transfer-ownership", "view-only"],
    );
    for (const a of ["view-only", "delete-account", "transfer-ownership"]) {
      expect(LEGACY_CAN_ACTIONS[a]).toBeNull();
    }
  });
});

describe("the catalogue and the tables agree", () => {
  const covered = new Set<string>();
  for (const r of [...ROUTE_ROWS, ...TIGHTENED_ROWS, ...DB_TIER_ROWS, ...MEMBER_TIER_ROWS, ...LEGACY_ROWS]) {
    for (const c of capsOf(r)) covered.add(c);
  }

  it("has every capability in a table or on the UI-only allow-list", () => {
    const missing = CAPABILITIES.map((c) => c.key).filter(
      (k) => !covered.has(k) && !UI_ONLY_ALLOW_LIST.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the allow-list to real, UI-only capabilities", () => {
    for (const k of UI_ONLY_ALLOW_LIST) {
      expect(isCapabilityKey(k), k).toBe(true);
    }
    // A capability that gates a route or policy must be in a table, not
    // hidden here.
    for (const k of UI_ONLY_ALLOW_LIST) {
      expect(covered.has(k), `${k} is in a table; drop it from the allow-list`).toBe(false);
    }
  });
});

describe("migration 079 database tier", () => {
  const migration = readFileSync(
    join(process.cwd(), "supabase", "migrations", "079_role_capabilities.sql"),
    "utf8",
  );
  const start = migration.indexOf("FROM (VALUES", migration.indexOf("Database-tier RLS"));
  const end = migration.indexOf(") AS v(tbl, capability)", start);
  const sqlPairs = [...migration.slice(start, end).matchAll(/\('([a-z_]+)',\s*'([a-z.-]+)'\)/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );

  it("moves exactly the tables listed here onto has_capability()", () => {
    expect(sqlPairs.length).toBeGreaterThan(0);
    expect([...sqlPairs].sort()).toEqual([...DB_TIER_WRITE_TABLES].sort());
  });

  it("has a parity row (old floor admin) for every write table", () => {
    for (const [table, cap] of DB_TIER_WRITE_TABLES) {
      const match = DB_TIER_ROWS.find(
        (r) => r.where === table && r.method === "insert/update/delete",
      );
      expect(match, table).toBeDefined();
      expect(match!.capability).toBe(cap);
      expect(match!.floor).toBe("admin");
    }
  });
});

describe("migration 084 database tier", () => {
  const migration = readMigration("084_approvals.sql");

  it("moves the tags and quick_replies write policies onto has_capability()", () => {
    for (const [table, cap] of [
      ["tags", "tags.manage"],
      ["quick_replies", "snippets.manage"],
    ]) {
      for (const [verb, clause] of [
        ["insert", "FOR INSERT WITH CHECK"],
        ["update", "FOR UPDATE USING"],
        ["delete", "FOR DELETE USING"],
      ]) {
        const re = new RegExp(
          `CREATE POLICY ${table}_${verb} ON public\\.${table}\\s+${clause} \\(has_capability\\(account_id, '${cap}'\\)\\)`,
        );
        expect(migration, `${table}_${verb}`).toMatch(re);
      }
    }
  });

  it("has a parity row for both tables", () => {
    for (const [table, cap, floor] of [
      ["tags", "tags.manage", "admin"],
      ["quick_replies", "snippets.manage", "agent"],
    ] as const) {
      const match = DB_TIER_ROWS.find(
        (r) => r.where === table && r.method === "insert/update/delete",
      );
      expect(match, table).toBeDefined();
      expect(match!.capability).toBe(cap);
      expect(match!.floor).toBe(floor);
    }
  });
});

// ------------------------------------------------------------
// The route source must match the table: no route file may go back to
// `requireRole(` (except the owner-only ones), and the capabilities a
// route file asks for must be exactly the ones the table lists for it.
// ------------------------------------------------------------
const API_DIR = join(process.cwd(), "src", "app", "api");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      routeFiles(p, out);
    } else if (name === "route.ts") {
      out.push(p);
    }
  }
  return out;
}

const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const routeKey = (file: string) =>
  relative(API_DIR, file).split(sep).join("/").replace(/\/route\.ts$/, "");

const ROUTES = routeFiles(API_DIR)
  .map((file) => ({ file, key: routeKey(file), src: stripComments(readFileSync(file, "utf8")) }))
  // /api/v1 authenticates with API-key scopes and is out of scope.
  .filter((r) => !r.key.startsWith("v1/") && r.key !== "v1");

/** Owner-only routes: the one legitimate use of requireRole. */
const OWNER_ONLY_ROUTES = new Set(["account/transfer-ownership"]);

describe("route handlers use capabilities, not role floors", () => {
  it("finds the route files", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  it("has no requireRole( left except owner-only routes", () => {
    const offenders: string[] = [];
    for (const r of ROUTES) {
      const calls = [...r.src.matchAll(/requireRole\(\s*(['"])(\w+)\1\s*\)/g)];
      const anyCall = /requireRole\(/.test(r.src);
      if (!anyCall) continue;
      const ownerOnly =
        OWNER_ONLY_ROUTES.has(r.key) && calls.length > 0 && calls.every((c) => c[2] === "owner");
      if (!ownerOnly) offenders.push(r.key);
    }
    expect(offenders).toEqual([]);
  });

  it("asks for exactly the capabilities the parity table lists, per route", () => {
    const tableCaps = new Map<string, Set<string>>();
    for (const r of [...ROUTE_ROWS, ...TIGHTENED_ROWS]) {
      const set = tableCaps.get(r.where) ?? new Set<string>();
      for (const c of capsOf(r)) set.add(c);
      tableCaps.set(r.where, set);
    }

    const problems: string[] = [];
    for (const r of ROUTES) {
      // New with this feature, no legacy floor to compare against (the
      // audit routes, migration 082, are new as well).
      if (
        r.key.startsWith("account/roles") ||
        r.key.startsWith("account/capabilities") ||
        r.key.startsWith("account/audit") ||
        r.key.startsWith("account/approvals") ||
        r.key.startsWith("integrations/jira")
      ) {
        continue;
      }

      const used = new Set<string>();
      for (const m of r.src.matchAll(/require(?:Any)?Capability\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")\s*\)/g)) {
        for (const k of m[1].matchAll(/['"]([a-z][a-z0-9.-]*)['"]/g)) used.add(k[1]);
      }
      for (const m of r.src.matchAll(/assertCapability\(\s*\w+\s*,\s*['"]([a-z][a-z0-9.-]*)['"]\s*\)/g)) {
        used.add(m[1]);
      }
      for (const m of r.src.matchAll(/capabilities\.has\(\s*['"]([a-z][a-z0-9.-]*)['"]\s*\)/g)) {
        used.add(m[1]);
      }

      const expected = tableCaps.get(r.key);
      if (used.size === 0) {
        if (expected) problems.push(`${r.key}: table lists ${[...expected]} but the route asks for no capability`);
        continue;
      }
      if (!expected) {
        problems.push(`${r.key}: asks for ${[...used]} but is not in the parity table`);
        continue;
      }
      const a = [...used].sort().join(",");
      const b = [...expected].sort().join(",");
      if (a !== b) problems.push(`${r.key}: route asks for [${a}] but the table lists [${b}]`);
    }
    expect(problems).toEqual([]);
  });
});
