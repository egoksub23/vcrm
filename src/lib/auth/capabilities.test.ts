import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  DEFAULT_CAPABILITIES,
  LEGACY_CAN_ACTIONS,
  PRESETS,
  canEditRole,
  canGrant,
  capabilityI18nId,
  diffCapabilities,
  editableRoles,
  getCapability,
  getPreset,
  isCapabilityKey,
  overridesFromRows,
  presetCapabilities,
  resolveCapabilities,
  roleCanBeGranted,
  roleHasCapability,
  switchBlockReason,
} from "./capabilities";
import { ACCOUNT_ROLES, roleRank, type AccountRole } from "./roles";

describe("catalogue", () => {
  it("has unique, stable, well-formed keys", () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z]+(\.[a-z]+(-[a-z]+)*)$/);
  });

  it("puts every capability in a known group", () => {
    for (const c of CAPABILITIES) expect(CAPABILITY_GROUPS).toContain(c.group);
  });

  it("always gives the owner every capability by default", () => {
    for (const c of CAPABILITIES) {
      expect(c.defaultRoles).toContain("owner");
      expect(DEFAULT_CAPABILITIES.owner.has(c.key)).toBe(true);
    }
  });

  it("never lets a default role sit below the capability's minGrantRole", () => {
    for (const c of CAPABILITIES) {
      for (const role of c.defaultRoles) {
        expect(roleRank(role)).toBeGreaterThanOrEqual(roleRank(c.minGrantRole));
      }
    }
  });

  it("never defaults a write capability to the viewer role", () => {
    for (const c of CAPABILITIES) {
      if (c.readOnly) continue;
      expect(c.defaultRoles).not.toContain("viewer");
      expect(roleRank(c.minGrantRole)).toBeGreaterThan(roleRank("viewer"));
    }
  });

  it("only lets viewers hold read-only capabilities (menus and reports)", () => {
    for (const c of CAPABILITIES) {
      if (c.minGrantRole === "viewer") {
        expect(c.readOnly).toBe(true);
        expect(c.key.startsWith("menu.") || c.key === "reports.view").toBe(true);
      }
    }
  });

  it("marks the database-enforced capabilities honestly", () => {
    const db = CAPABILITIES.filter((c) => c.enforcedBy === "database").map(
      (c) => c.key,
    );
    expect(db.sort()).toEqual(
      [
        "ai.configure",
        "api.manage",
        "approvals.review",
        "audit.view",
        "channels.manage",
        "members.change-role",
        "members.remove",
        "roles.manage",
        "snippets.manage",
        "snippets.propose",
        "tags.manage",
        "tags.propose",
      ].sort(),
    );
  });

  it("derives i18n ids without dots or dashes", () => {
    expect(capabilityI18nId("messages.send")).toBe("messages_send");
    expect(capabilityI18nId("tickets.configure-form")).toBe(
      "tickets_configure_form",
    );
    for (const c of CAPABILITIES) {
      expect(capabilityI18nId(c.key)).toMatch(/^[a-z_]+$/);
    }
  });

  it("looks capabilities up and rejects unknown keys", () => {
    expect(getCapability("tags.manage")?.group).toBe("tags");
    expect(getCapability("nope")).toBeUndefined();
    expect(isCapabilityKey("tags.manage")).toBe(true);
    expect(isCapabilityKey("nope")).toBe(false);
    expect(isCapabilityKey(42)).toBe(false);
  });
});

describe("resolveCapabilities", () => {
  it("returns the defaults with no overrides", () => {
    for (const role of ACCOUNT_ROLES) {
      expect(resolveCapabilities(role)).toEqual(DEFAULT_CAPABILITIES[role]);
      expect(resolveCapabilities(role, {})).toEqual(DEFAULT_CAPABILITIES[role]);
    }
  });

  it("applies a revoke and a grant on top of the defaults", () => {
    const agent = resolveCapabilities("agent", {
      "broadcasts.send": false,
      "channels.manage": true,
    });
    expect(agent.has("broadcasts.send")).toBe(false);
    expect(agent.has("channels.manage")).toBe(true);
    expect(agent.has("messages.send")).toBe(true);
  });

  it("ignores every override for the owner", () => {
    const owner = resolveCapabilities("owner", {
      "roles.manage": false,
      "menu.settings": false,
    });
    expect(owner).toEqual(DEFAULT_CAPABILITIES.owner);
  });

  it("denies unknown keys, granted or not", () => {
    const admin = resolveCapabilities("admin", { "nope.unknown": true });
    expect(admin.has("nope.unknown")).toBe(false);
    expect(roleHasCapability("owner", null, "nope.unknown")).toBe(false);
    expect(roleHasCapability("admin", null, "nope.unknown")).toBe(false);
  });

  it("ignores a grant below the capability's minGrantRole (mirrors the database)", () => {
    const viewer = resolveCapabilities("viewer", {
      "messages.send": true,
      "channels.manage": true,
    });
    expect(viewer.has("messages.send")).toBe(false);
    expect(viewer.has("channels.manage")).toBe(false);
    const agent = resolveCapabilities("agent", { "tags.manage": true });
    expect(agent.has("tags.manage")).toBe(false);
  });

  it("lets a viewer be granted a read-only capability and denied a default one", () => {
    const viewer = resolveCapabilities("viewer", { "menu.reports": false });
    expect(viewer.has("menu.reports")).toBe(false);
    expect(viewer.has("menu.inbox")).toBe(true);
  });

  it("builds overrides from rows", () => {
    expect(
      overridesFromRows([
        { capability: "a", granted: true },
        { capability: "b", granted: false },
      ]),
    ).toEqual({ a: true, b: false });
    expect(overridesFromRows(null)).toEqual({});
  });
});

describe("editing rules", () => {
  const cases: [AccountRole, AccountRole, boolean][] = [
    ["owner", "owner", false],
    ["owner", "admin", true],
    ["owner", "agent", true],
    ["owner", "viewer", true],
    ["admin", "owner", false],
    ["admin", "admin", false],
    ["admin", "agent", true],
    ["admin", "viewer", true],
    ["agent", "agent", false],
    ["agent", "viewer", true],
    ["viewer", "viewer", false],
    ["viewer", "agent", false],
  ];
  it.each(cases)("%s editing %s -> %s", (editor, target, expected) => {
    expect(canEditRole(editor, target)).toBe(expected);
  });

  it("lists the roles an editor may edit, highest first", () => {
    expect(editableRoles("owner")).toEqual(["admin", "agent", "viewer"]);
    expect(editableRoles("admin")).toEqual(["agent", "viewer"]);
    expect(editableRoles("viewer")).toEqual([]);
  });

  it("nobody can grant a capability they do not hold", () => {
    expect(canGrant(new Set(["tags.manage"]), "tags.manage")).toBe(true);
    expect(canGrant(new Set(["tags.manage"]), "api.manage")).toBe(false);
    expect(canGrant(["api.manage"], "api.manage")).toBe(true);
    expect(canGrant(new Set(["nope"]), "nope")).toBe(false);
  });

  it("knows which roles a capability can be granted to", () => {
    expect(roleCanBeGranted("agent", "channels.manage")).toBe(true);
    expect(roleCanBeGranted("viewer", "channels.manage")).toBe(false);
    expect(roleCanBeGranted("agent", "tags.manage")).toBe(false);
    expect(roleCanBeGranted("viewer", "menu.reports")).toBe(true);
    expect(roleCanBeGranted("owner", "nope")).toBe(false);
  });

  it("explains why a switch is greyed", () => {
    const owner = DEFAULT_CAPABILITIES.owner;
    const base = { editorRole: "admin" as const, editorCaps: owner };
    expect(
      switchBlockReason({ ...base, targetRole: "admin", cap: "menu.inbox", wantGranted: true }),
    ).toBe("role-not-editable");
    expect(
      switchBlockReason({ ...base, targetRole: "owner", cap: "menu.inbox", wantGranted: false }),
    ).toBe("role-not-editable");
    expect(
      switchBlockReason({ ...base, targetRole: "agent", cap: "tags.manage", wantGranted: true }),
    ).toBe("below-min-role");
    expect(
      switchBlockReason({
        ...base,
        editorCaps: new Set<string>(),
        targetRole: "agent",
        cap: "channels.manage",
        wantGranted: true,
      }),
    ).toBe("editor-lacks");
    expect(
      switchBlockReason({ ...base, targetRole: "agent", cap: "channels.manage", wantGranted: true }),
    ).toBeNull();
    // turning OFF is always fine for an editable role, even one the editor lacks
    expect(
      switchBlockReason({
        ...base,
        editorCaps: new Set<string>(),
        targetRole: "agent",
        cap: "channels.manage",
        wantGranted: false,
      }),
    ).toBeNull();
    expect(
      switchBlockReason({ ...base, targetRole: "agent", cap: "nope", wantGranted: false }),
    ).toBe("unknown");
    expect(
      switchBlockReason({ ...base, targetRole: "viewer", cap: "messages.send", wantGranted: true }),
    ).toBe("below-min-role");
  });
});

describe("presets", () => {
  it("only revokes known capabilities", () => {
    for (const p of PRESETS) {
      for (const cap of p.revoke) expect(isCapabilityKey(cap)).toBe(true);
    }
  });

  it("Support Manager profile trims the Admin role as designed", () => {
    const p = getPreset("support-manager")!;
    const caps = presetCapabilities("admin", p);
    for (const removed of [
      "ai.configure",
      "channels.manage",
      "api.manage",
      "settings.workspace",
    ]) {
      expect(caps.has(removed)).toBe(false);
    }
    for (const kept of [
      "messages.send",
      "contacts.edit",
      "tickets.work",
      "knowledge.publish",
      "teams.manage",
      "reports.view",
      "roles.manage",
    ]) {
      expect(caps.has(kept)).toBe(true);
    }
  });

  it("Chat-only agent removes the sales/automation menus and actions", () => {
    const caps = presetCapabilities("agent", getPreset("chat-only-agent")!);
    for (const removed of [
      "menu.broadcasts",
      "menu.automations",
      "menu.flows",
      "menu.pipelines",
      "menu.reports",
      "broadcasts.send",
      "automations.manage",
      "flows.manage",
      "deals.manage",
    ]) {
      expect(caps.has(removed)).toBe(false);
    }
    expect(caps.has("messages.send")).toBe(true);
    expect(caps.has("menu.inbox")).toBe(true);
  });

  it("Read-only stakeholder limits menus to Dashboard, Inbox, Reports, Tickets", () => {
    const caps = presetCapabilities("viewer", getPreset("read-only-stakeholder")!);
    const menus = [...caps].filter((c) => c.startsWith("menu.")).sort();
    expect(menus).toEqual([
      "menu.dashboard",
      "menu.inbox",
      "menu.reports",
      "menu.tickets",
    ]);
    // every preset result is something the role can technically hold
    for (const cap of caps) expect(roleCanBeGranted("viewer", cap)).toBe(true);
  });

  it("looks presets up by id", () => {
    expect(getPreset("nope")).toBeUndefined();
  });

  it("diffCapabilities returns only the differences", () => {
    const current = new Set(["a", "menu.inbox"]);
    const desired = new Set(["menu.inbox", "menu.reports"]);
    // 'a' is not a catalogue key so it never appears in a diff
    expect(diffCapabilities(current, desired)).toEqual({ "menu.reports": true });
    expect(
      diffCapabilities(DEFAULT_CAPABILITIES.agent, DEFAULT_CAPABILITIES.agent),
    ).toEqual({});
    const chat = presetCapabilities("agent", getPreset("chat-only-agent")!);
    const diff = diffCapabilities(DEFAULT_CAPABILITIES.agent, chat);
    expect(Object.values(diff).every((v) => v === false)).toBe(true);
    expect(Object.keys(diff).sort()).toEqual(
      [...getPreset("chat-only-agent")!.revoke].sort(),
    );
  });
});

describe("legacy useCan actions", () => {
  it("maps onto real capabilities or to role facts", () => {
    for (const [action, cap] of Object.entries(LEGACY_CAN_ACTIONS)) {
      if (cap !== null) expect(isCapabilityKey(cap), action).toBe(true);
    }
    expect(Object.keys(LEGACY_CAN_ACTIONS).sort()).toEqual(
      [
        "delete-account",
        "edit-settings",
        "manage-members",
        "send-messages",
        "transfer-ownership",
        "view-only",
      ].sort(),
    );
  });
});
