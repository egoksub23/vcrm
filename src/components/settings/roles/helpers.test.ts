import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  PRESETS,
  presetCapabilities,
} from "@/lib/auth/capabilities";
import {
  buildChangeSummary,
  buildChangesPayload,
  clampDesired,
  countChanges,
  countDifferingFromDefault,
  differsFromDefault,
  draftSet,
  editsFromDesired,
  filterCapabilities,
  groupCapabilities,
  normalizeEdits,
  peopleHolding,
  rolesHolding,
  rowBlockReason,
  savedSet,
  setEdit,
} from "./helpers";

const agentDefault = () => new Set(DEFAULT_CAPABILITIES.agent);
const allCaps = new Set(CAPABILITIES.map((c) => c.key));

describe("draft edits", () => {
  it("drops unknown keys and edits equal to saved", () => {
    const saved = agentDefault();
    const edits = normalizeEdits(saved, {
      "messages.send": true, // already saved as on
      "ai.configure": false, // already off
      "tags.manage": true, // real change
      "nope.nope": true, // unknown
    });
    expect(edits).toEqual({ "tags.manage": true });
  });

  it("layers edits over saved", () => {
    const saved = agentDefault();
    const draft = draftSet(saved, { "messages.send": false, "tags.manage": true });
    expect(draft.has("messages.send")).toBe(false);
    expect(draft.has("tags.manage")).toBe(true);
    expect(draft.has("contacts.edit")).toBe(true);
  });

  it("flipping a switch back removes the edit", () => {
    const saved = agentDefault();
    let edits = setEdit(saved, {}, "messages.send", false);
    expect(countChanges(saved, edits)).toBe(1);
    edits = setEdit(saved, edits, "messages.send", true);
    expect(edits).toEqual({});
    expect(countChanges(saved, edits)).toBe(0);
  });

  it("re-baselines against a fresher saved state", () => {
    // Someone else already revoked messages.send while the draft was open.
    const fresher = agentDefault();
    fresher.delete("messages.send");
    const edits = { "messages.send": false, "tags.manage": true };
    expect(countChanges(fresher, edits)).toBe(1);
  });

  it("editsFromDesired matches the desired set exactly", () => {
    const saved = agentDefault();
    const desired = presetCapabilities("agent", PRESETS[1]);
    const draft = draftSet(saved, editsFromDesired(saved, desired));
    expect([...draft].sort()).toEqual([...desired].sort());
  });
});

describe("changed versus default", () => {
  it("is measured against the role default, not the saved state", () => {
    const saved = agentDefault();
    saved.delete("messages.send");
    expect(differsFromDefault("agent", saved, "messages.send")).toBe(true);
    expect(differsFromDefault("agent", saved, "contacts.edit")).toBe(false);
    expect(countDifferingFromDefault("agent", saved)).toBe(1);
    expect(countDifferingFromDefault("agent", agentDefault())).toBe(0);
  });
});

describe("buildChangesPayload", () => {
  it("is empty when nothing changed", () => {
    const saved = agentDefault();
    expect(buildChangesPayload("agent", saved, new Set(saved))).toEqual({});
  });

  it("sends false for a revoke of a default capability", () => {
    const saved = agentDefault();
    const draft = new Set(saved);
    draft.delete("messages.send");
    expect(buildChangesPayload("agent", saved, draft)).toEqual({
      "messages.send": false,
    });
  });

  it("sends true for a grant beyond the default", () => {
    const saved = agentDefault();
    const draft = new Set(saved);
    draft.add("tags.manage");
    expect(buildChangesPayload("agent", saved, draft)).toEqual({
      "tags.manage": true,
    });
  });

  it("sends null when the desired value equals the default (removes the override)", () => {
    // Saved has an override revoking messages.send; the draft restores it.
    const saved = agentDefault();
    saved.delete("messages.send");
    const draft = agentDefault();
    expect(buildChangesPayload("agent", saved, draft)).toEqual({
      "messages.send": null,
    });
  });

  it("only includes keys that differ from saved", () => {
    const saved = agentDefault();
    saved.delete("messages.send");
    const draft = new Set(saved);
    draft.add("tags.manage");
    expect(buildChangesPayload("agent", saved, draft)).toEqual({
      "tags.manage": true,
    });
  });
});

describe("rowBlockReason", () => {
  const ownerCaps = allCaps;
  const adminCaps = new Set(DEFAULT_CAPABILITIES.admin);

  it("locks every Owner row", () => {
    expect(
      rowBlockReason({
        editorRole: "owner",
        editorCaps: ownerCaps,
        targetRole: "owner",
        cap: "messages.send",
        on: true,
        saved: allCaps,
      }),
    ).toBe("owner-locked");
  });

  it("marks a role the editor cannot edit", () => {
    expect(
      rowBlockReason({
        editorRole: "admin",
        editorCaps: adminCaps,
        targetRole: "admin",
        cap: "messages.send",
        on: true,
        saved: new Set(adminCaps),
      }),
    ).toBe("role-not-editable");
  });

  it("allows turning a capability off on an editable role", () => {
    expect(
      rowBlockReason({
        editorRole: "admin",
        editorCaps: adminCaps,
        targetRole: "agent",
        cap: "messages.send",
        on: true,
        saved: agentDefault(),
      }),
    ).toBeNull();
  });

  it("refuses turning on something below the minimum role", () => {
    // inbox.shared-views needs admin; viewers/agents cannot get it.
    expect(
      rowBlockReason({
        editorRole: "owner",
        editorCaps: ownerCaps,
        targetRole: "agent",
        cap: "inbox.shared-views",
        on: false,
        saved: agentDefault(),
      }),
    ).toBe("below-min-role");
  });

  it("refuses turning on what the editor does not hold", () => {
    const lacking = new Set(adminCaps);
    lacking.delete("ai.configure");
    expect(
      rowBlockReason({
        editorRole: "admin",
        editorCaps: lacking,
        targetRole: "agent",
        cap: "ai.configure",
        on: false,
        saved: agentDefault(),
      }),
    ).toBe("editor-lacks");
  });

  it("lets a person undo an unsaved removal even if they lack the capability", () => {
    const saved = agentDefault();
    saved.add("ai.configure");
    const lacking = new Set(DEFAULT_CAPABILITIES.admin);
    lacking.delete("ai.configure");
    expect(
      rowBlockReason({
        editorRole: "admin",
        editorCaps: lacking,
        targetRole: "agent",
        cap: "ai.configure",
        on: false, // draft removed it
        saved, // but it is saved as on
      }),
    ).toBeNull();
  });
});

describe("clampDesired", () => {
  it("keeps grants the editor cannot make switched off and reports them", () => {
    const saved = agentDefault();
    saved.delete("ai.use");
    const editorCaps = new Set(DEFAULT_CAPABILITIES.admin);
    editorCaps.delete("ai.use");
    const { desired, skipped } = clampDesired({
      editorRole: "admin",
      editorCaps,
      targetRole: "agent",
      saved,
      desired: agentDefault(), // wants ai.use back on
    });
    expect(desired.has("ai.use")).toBe(false);
    expect(skipped).toEqual(["ai.use"]);
  });

  it("always lets removals through", () => {
    const saved = agentDefault();
    const { desired, skipped } = clampDesired({
      editorRole: "admin",
      editorCaps: new Set(DEFAULT_CAPABILITIES.admin),
      targetRole: "agent",
      saved,
      desired: presetCapabilities("agent", PRESETS[1]),
    });
    expect(skipped).toEqual([]);
    expect(desired.has("menu.broadcasts")).toBe(false);
  });
});

describe("filter and group", () => {
  const text = (c: { key: string }) => ({
    label: `Label of ${c.key}`,
    description: c.key === "tags.manage" ? "Create and delete labels" : "Something",
  });

  it("matches label, description and key, case-insensitively", () => {
    const draft = agentDefault();
    const byLabel = filterCapabilities({
      query: "LABEL OF MESSAGES",
      onlyChanged: false,
      role: "agent",
      draft,
      text,
    });
    expect(byLabel.map((c) => c.key)).toEqual(["messages.send"]);
    const byDesc = filterCapabilities({
      query: "delete labels",
      onlyChanged: false,
      role: "agent",
      draft,
      text,
    });
    expect(byDesc.map((c) => c.key)).toEqual(["tags.manage"]);
    const byKey = filterCapabilities({
      query: "flows.man",
      onlyChanged: false,
      role: "agent",
      draft,
      text,
    });
    expect(byKey.map((c) => c.key)).toEqual(["flows.manage"]);
  });

  it("only-changed compares with the role default", () => {
    const draft = agentDefault();
    draft.delete("messages.send");
    draft.add("tags.manage");
    const out = filterCapabilities({
      query: "",
      onlyChanged: true,
      role: "agent",
      draft,
      text,
    });
    expect(out.map((c) => c.key).sort()).toEqual(["messages.send", "tags.manage"]);
  });

  it("groups in catalogue order and drops empty groups", () => {
    const groups = groupCapabilities(
      CAPABILITIES.filter((c) => ["tags.manage", "menu.inbox", "ai.use"].includes(c.key)),
    );
    expect(groups.map((g) => g.group)).toEqual(["menus", "tags", "ai"]);
  });
});

describe("buildChangeSummary", () => {
  it("lists from -> to grouped and counts gains and losses", () => {
    const saved = agentDefault();
    const draft = new Set(saved);
    draft.delete("menu.broadcasts");
    draft.delete("broadcasts.send");
    draft.add("tags.manage");
    const s = buildChangeSummary(saved, draft);
    expect(s.items).toHaveLength(3);
    expect(s.gained).toBe(1);
    expect(s.lost).toBe(2);
    expect(s.hiddenMenus).toEqual(["menu.broadcasts"]);
    expect(s.removesRolesManage).toBe(false);
    expect(s.groups.map((g) => g.group)).toEqual(["menus", "contacts", "tags"]);
    const tag = s.items.find((i) => i.key === "tags.manage");
    expect(tag).toMatchObject({ from: false, to: true });
  });

  it("flags removal of roles.manage", () => {
    const saved = new Set(DEFAULT_CAPABILITIES.admin);
    const draft = new Set(saved);
    draft.delete("roles.manage");
    expect(buildChangeSummary(saved, draft).removesRolesManage).toBe(true);
  });

  it("is empty for identical sets", () => {
    const saved = agentDefault();
    expect(buildChangeSummary(saved, new Set(saved)).items).toEqual([]);
  });
});

describe("reverse view", () => {
  const matrix = [
    { role: "owner" as const, effective: [...allCaps] },
    { role: "admin" as const, effective: [...DEFAULT_CAPABILITIES.admin] },
    { role: "agent" as const, effective: [...DEFAULT_CAPABILITIES.agent] },
    { role: "viewer" as const, effective: [...DEFAULT_CAPABILITIES.viewer] },
  ];
  const members = [
    { user_id: "1", full_name: "Ann", email: null, role: "owner" as const },
    { user_id: "2", full_name: "Bob", email: null, role: "agent" as const },
    { user_id: "3", full_name: "Cy", email: null, role: "viewer" as const },
  ];

  it("lists roles holding a capability, owner always", () => {
    expect(rolesHolding(matrix, "tags.manage")).toEqual(["owner", "admin"]);
    expect(rolesHolding(matrix, "messages.send")).toEqual(["owner", "admin", "agent"]);
  });

  it("names the people", () => {
    expect(peopleHolding(matrix, members, "messages.send").map((m) => m.full_name)).toEqual([
      "Ann",
      "Bob",
    ]);
  });
});

describe("savedSet", () => {
  it("ignores unknown keys", () => {
    expect(savedSet(["messages.send", "bogus"]).size).toBe(1);
  });
});
