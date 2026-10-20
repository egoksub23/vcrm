import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  addonCapabilitiesFor,
  addonMinBaseRole,
  withAddonCapabilities,
  DEFAULT_CAPABILITIES,
  LEGACY_CAN_ACTIONS,
  MENU_CAPABILITIES,
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
    // incidents.raise (migration 116) is a deliberate, documented
    // exception: "anyone can raise an incident" per the Security
    // Incident Reporting policy, enforced by RLS (reporter_id =
    // auth.uid() on insert) rather than a role floor.
    for (const c of CAPABILITIES) {
      if (c.readOnly || c.key === "incidents.raise") continue;
      expect(c.defaultRoles).not.toContain("viewer");
      expect(roleRank(c.minGrantRole)).toBeGreaterThan(roleRank("viewer"));
    }
  });

  it("only lets viewers hold read-only capabilities (menus, reports, and incidents.raise)", () => {
    for (const c of CAPABILITIES) {
      if (c.minGrantRole === "viewer") {
        if (c.key === "incidents.raise") continue;
        expect(c.readOnly).toBe(true);
        expect(c.key.startsWith("menu.") || c.key === "reports.view").toBe(true);
      }
    }
  });

  it("marks the database-enforced capabilities honestly", () => {
    // Migration 088 (phase 5): every capability that guards data in a table is
    // database-enforced. The rest are app-tier for a stated reason (below).
    const db = CAPABILITIES.filter((c) => c.enforcedBy === "database").map(
      (c) => c.key,
    );
    expect(db.sort()).toEqual(
      [
        "ai.configure",
        "api.manage",
        "approvals.review",
        "audit.view",
        "automations.manage",
        "broadcasts.send",
        "channels.manage",
        "comments.delete",
        "comments.moderate",
        "contacts.edit",
        "conversations.manage",
        "deals.manage",
        "flows.manage",
        "inbox.shared-views",
        "incidents.manage",
        "incidents.raise",
        "knowledge.draft",
        "knowledge.manage",
        "knowledge.publish",
        "members.change-role",
        "members.invite",
        "members.remove",
        // Sembang (menu.sembang) is the one "menu" capability that is also
        // a real table guard — see the comment above its def() call.
        "menu.sembang",
        // Doc Sign: the reading gate and the three table-guarding writes (migration 157).
        "menu.sign",
        "messages.send",
        "pipelines.configure",
        "roles.manage",
        "sembang.manage",
        "settings.workspace",
        "sign.send",
        "sign.settings",
        "sign.templates",
        "sla.configure",
        "snippets.manage",
        "snippets.propose",
        "tags.manage",
        "tags.propose",
        "teams.manage",
        "tickets.configure-form",
        "tickets.delete",
        "tickets.work",
      ].sort(),
    );
  });

  it("keeps only the capabilities with no table to guard on the app tier", () => {
    const app = CAPABILITIES.filter((c) => c.enforcedBy === "app").map(
      (c) => c.key,
    );
    expect(app.sort()).toEqual(
      [
        // menus and reports show or hide pages; the data behind them is
        // protected by the action capabilities and the read policies.
        // menu.sembang is the deliberate exception (it IS a table guard,
        // see the previous test) so it's excluded here.
        ...MENU_CAPABILITIES.filter((k) => k !== "menu.sembang" && k !== "menu.sign" && k !== "menu.kyc" && k !== "menu.compliance"),
        "reports.view",
        // the action is a call to the AI provider, made by the server
        "ai.use",
        // a service-role function, no client path
        "contacts.merge",
        // server-side routes; the Jira tables have no client write policy
        "jira.connect",
        "jira.link",
        "jira.share-comments",
        // Doc Sign: act through server routes; a sent document is written by the service role
        "sign.reveal-sensitive",
        "sign.sign",
        "sign.void",
        // KYC review (migration 182): server routes only; the ID back end is reached with a key that never leaves the server
        "menu.kyc",
        "kyc.view",
        "kyc.reveal",
        "kyc.decide",
        // Compliance requests (migration 183): server routes only; the database re-checks the actor inside its functions
        "menu.compliance",
        "compliance.review",
        "compliance.approve",
        "compliance.reveal",
        "compliance.execute",
        "compliance.manage",
        "compliance.raise",
      ].sort(),
    );
  });

  it("lets every table-guarding write capability be granted down to Agent, never to Viewer", () => {
    // Migration 088: the policies test the capability, not a role floor, so an
    // Agent can be given pipelines.configure, settings.workspace, ...
    for (const key of [
      "pipelines.configure",
      "settings.workspace",
      "tags.manage",
      "tickets.delete",
      "tickets.configure-form",
      "knowledge.publish",
      "knowledge.manage",
      "inbox.shared-views",
      "members.invite",
      "teams.manage",
    ]) {
      expect(roleCanBeGranted("agent", key), key).toBe(true);
      expect(roleCanBeGranted("viewer", key), key).toBe(false);
    }
    // Changing or removing a member needs the Admin rank inside the database
    // function itself, so those (and roles.manage) stay Admin-and-up.
    for (const key of ["members.change-role", "members.remove", "roles.manage"]) {
      expect(roleCanBeGranted("agent", key), key).toBe(false);
      expect(roleCanBeGranted("admin", key), key).toBe(true);
    }
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
    const agent = resolveCapabilities("agent", { "members.change-role": true });
    expect(agent.has("members.change-role")).toBe(false);
    // below the OLD floor but grantable since migration 088
    expect(resolveCapabilities("agent", { "tags.manage": true }).has("tags.manage")).toBe(true);
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
    expect(roleCanBeGranted("agent", "tags.manage")).toBe(true);
    expect(roleCanBeGranted("agent", "members.change-role")).toBe(false);
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
      switchBlockReason({ ...base, targetRole: "agent", cap: "members.change-role", wantGranted: true }),
    ).toBe("below-min-role");
    // below the OLD floor but grantable since migration 088
    expect(
      switchBlockReason({ ...base, targetRole: "agent", cap: "tags.manage", wantGranted: true }),
    ).toBeNull();
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

describe("KYC review capabilities (migration 182)", () => {
  const KYC = ["menu.kyc", "kyc.view", "kyc.reveal", "kyc.decide"] as const;

  it("exist, in the menus and kyc groups, app tier, read-only is not claimed", () => {
    expect(getCapability("menu.kyc")).toMatchObject({ group: "menus", enforcedBy: "app", minGrantRole: "agent" });
    expect(getCapability("kyc.view")).toMatchObject({ group: "kyc", enforcedBy: "app", minGrantRole: "agent" });
    expect(getCapability("kyc.reveal")).toMatchObject({ group: "kyc", enforcedBy: "app", minGrantRole: "agent" });
    expect(getCapability("kyc.decide")).toMatchObject({ group: "kyc", enforcedBy: "app", minGrantRole: "agent" });
    expect(CAPABILITY_GROUPS).toContain("kyc");
  });

  it("default to the owner and the admin only; an agent, a viewer or a custom role built on them gets none until an admin grants it", () => {
    for (const k of KYC) {
      expect([...(getCapability(k)?.defaultRoles ?? [])].sort(), k).toEqual(["admin", "owner"]);
      expect(DEFAULT_CAPABILITIES.owner.has(k), k).toBe(true);
      expect(DEFAULT_CAPABILITIES.admin.has(k), k).toBe(true);
      expect(DEFAULT_CAPABILITIES.agent.has(k), k).toBe(false);
      expect(DEFAULT_CAPABILITIES.viewer.has(k), k).toBe(false);
    }
  });

  it("can be granted down to an agent and never to a viewer (children's ID data)", () => {
    for (const k of KYC) {
      expect(roleCanBeGranted("agent", k), k).toBe(true);
      expect(roleCanBeGranted("viewer", k), k).toBe(false);
      expect(resolveCapabilities("agent", { [k]: true }).has(k), k).toBe(true);
      expect(resolveCapabilities("admin", { [k]: false }).has(k), k).toBe(false);
    }
  });

  it("derive i18n ids", () => {
    expect(capabilityI18nId("menu.kyc")).toBe("menu_kyc");
    expect(capabilityI18nId("kyc.view")).toBe("kyc_view");
    expect(capabilityI18nId("kyc.reveal")).toBe("kyc_reveal");
    expect(capabilityI18nId("kyc.decide")).toBe("kyc_decide");
  });
});

describe("Compliance requests capabilities (migration 183)", () => {
  const COMPLIANCE = ["menu.compliance", "compliance.review", "compliance.approve", "compliance.reveal", "compliance.execute", "compliance.manage", "compliance.raise"] as const;

  it("exist, in the menus and compliance groups, app tier, grantable down to an agent", () => {
    expect(getCapability("menu.compliance")).toMatchObject({ group: "menus", enforcedBy: "app", minGrantRole: "agent" });
    for (const k of COMPLIANCE.slice(1)) expect(getCapability(k), k).toMatchObject({ group: "compliance", enforcedBy: "app", minGrantRole: "agent" });
    expect(CAPABILITY_GROUPS).toContain("compliance");
  });

  it("default to the owner and the admin only; nobody else, and no named role is seeded (the owner defines Head of Compliance and Compliance Officer as custom roles)", () => {
    for (const k of COMPLIANCE) {
      expect([...(getCapability(k)?.defaultRoles ?? [])].sort(), k).toEqual(["admin", "owner"]);
      expect(DEFAULT_CAPABILITIES.owner.has(k), k).toBe(true);
      expect(DEFAULT_CAPABILITIES.admin.has(k), k).toBe(true);
      expect(DEFAULT_CAPABILITIES.agent.has(k), k).toBe(false);
      expect(DEFAULT_CAPABILITIES.viewer.has(k), k).toBe(false);
    }
  });

  it("can be granted to an agent (so to a custom role built on one) and never to a viewer", () => {
    for (const k of COMPLIANCE) {
      expect(roleCanBeGranted("agent", k), k).toBe(true);
      expect(roleCanBeGranted("viewer", k), k).toBe(false);
      expect(resolveCapabilities("agent", { [k]: true }).has(k), k).toBe(true);
      expect(resolveCapabilities("admin", { [k]: false }).has(k), k).toBe(false);
    }
  });

  it("derive i18n ids", () => {
    expect(capabilityI18nId("menu.compliance")).toBe("menu_compliance");
    expect(capabilityI18nId("compliance.approve")).toBe("compliance_approve");
    expect(capabilityI18nId("compliance.reveal")).toBe("compliance_reveal");
  });
});

// Add-on roles (migration 191): the pure rule the server and the screens share, mirrored in SQL by addon_grants_capability().
describe("add-on roles", () => {
  it("give a capability only when the base tier is high enough for it: the same floor a custom role has", () => {
    for (const cap of CAPABILITIES) {
      for (const role of ACCOUNT_ROLES) {
        const granted = addonCapabilitiesFor(role, [cap.key]).has(cap.key);
        expect(granted, `${role} / ${cap.key}`).toBe(roleRank(role) >= roleRank(cap.minGrantRole));
      }
    }
  });

  it("never give a viewer a capability that writes data, and always give the owner any", () => {
    expect(addonCapabilitiesFor("viewer", ["kyc.decide"]).size).toBe(0);
    expect(addonCapabilitiesFor("agent", ["kyc.decide"]).has("kyc.decide")).toBe(true);
    expect(addonCapabilitiesFor("owner", ["kyc.decide"]).has("kyc.decide")).toBe(true);
  });

  it("ignore a key that is not in the catalogue", () => {
    expect(addonCapabilitiesFor("admin", ["not.a.capability", "kyc.decide"])).toEqual(new Set(["kyc.decide"]));
  });

  it("only ADD: every capability of the base set is still there, and the base set is not changed", () => {
    const base = resolveCapabilities("agent");
    const before = new Set(base);
    const out = withAddonCapabilities(base, "agent", ["kyc.decide", "compliance.review"]);
    for (const cap of before) expect(out.has(cap), cap).toBe(true);
    expect(out.has("kyc.decide")).toBe(true);
    expect(out.has("compliance.review")).toBe(true);
    expect(base).toEqual(before);
    expect(withAddonCapabilities(base, "agent", [])).toEqual(before);
  });

  it("name the lowest base tier at which every capability in a set applies", () => {
    expect(addonMinBaseRole([])).toBe("viewer");
    expect(addonMinBaseRole(["menu.inbox"])).toBe("viewer");
    expect(addonMinBaseRole(["menu.kyc", "kyc.view", "kyc.decide"])).toBe("agent");
    for (const cap of CAPABILITIES) expect(roleRank(addonMinBaseRole([cap.key]))).toBe(Math.max(roleRank("viewer"), roleRank(cap.minGrantRole)));
    // an unknown key does not raise it
    expect(addonMinBaseRole(["not.a.capability"])).toBe("viewer");
  });
});
