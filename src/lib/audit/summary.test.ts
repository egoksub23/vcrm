import { describe, expect, it } from "vitest";

import { describeSummary, summaryToText } from "./summary";

describe("describeSummary", () => {
  it("returns nothing without a summary", () => {
    expect(describeSummary("created", null)).toEqual([]);
    expect(describeSummary("updated", undefined)).toEqual([]);
    expect(describeSummary("updated", {})).toEqual([]);
  });

  it("describes a rename and a colour change", () => {
    const parts = describeSummary("updated", {
      changes: {
        name: { from: "VIP", to: "VIP gold" },
        color: { from: "#f00", to: "#0f0" },
      },
    });
    expect(parts).toEqual([
      { type: "renamed", from: "VIP", to: "VIP gold" },
      { type: "changed", field: "color", from: "#f00", to: "#0f0" },
    ]);
    expect(summaryToText("updated", { changes: { name: { from: "VIP", to: "VIP gold" } } })).toBe(
      'renamed "VIP" to "VIP gold"',
    );
  });

  it("treats a title change as a rename and lists names-only fields", () => {
    expect(
      describeSummary("updated", {
        changes: { title: { from: "A", to: "B" } },
        changed: ["content", "collection"],
      }),
    ).toEqual([
      { type: "renamed", from: "A", to: "B" },
      { type: "edited", fields: ["content", "collection"] },
    ]);
  });

  it("marks a publish and a translation language", () => {
    expect(describeSummary("updated", { published: true, language: "ms" })).toEqual([
      { type: "published" },
      { type: "language", language: "ms" },
    ]);
  });

  it("describes applied and removed labels and tags", () => {
    expect(describeSummary("applied", { label: "VIP", tag_id: "x" })).toEqual([
      { type: "tagApplied", name: "VIP" },
    ]);
    expect(describeSummary("removed", { tag: "Lead" })).toEqual([{ type: "tagApplied", name: "Lead" }]);
  });

  it("describes role and capability changes", () => {
    expect(describeSummary("role_changed", { from: "agent", to: "admin" })).toEqual([
      { type: "roleChange", from: "agent", to: "admin" },
    ]);
    expect(
      describeSummary("capability_changed", { capability: "audit.view", from: false, to: true }),
    ).toEqual([{ type: "capability", capability: "audit.view", granted: true }]);
    expect(summaryToText("capability_changed", { capability: "audit.view", to: false })).toBe(
      "audit.view revoked",
    );
  });

  it("describes invitations, team members and members leaving", () => {
    expect(describeSummary("invited", { role: "agent" })).toEqual([{ type: "invitedRole", role: "agent" }]);
    expect(describeSummary("team_member_added", { member: "Maya" })).toEqual([
      { type: "person", name: "Maya" },
    ]);
    expect(describeSummary("member_removed", { self: true })).toEqual([{ type: "left" }]);
    expect(describeSummary("member_removed", { self: false })).toEqual([]);
  });

  it("reports what a tag deletion took with it, only when something did", () => {
    expect(
      describeSummary("deleted", { contacts_untagged: 3, conversations_unlabelled: 0 }),
    ).toEqual([{ type: "untagged", contacts: 3, conversations: 0 }]);
    expect(describeSummary("deleted", { contacts_untagged: 0, conversations_unlabelled: 0 })).toEqual([]);
  });

  it("ignores garbage instead of throwing", () => {
    expect(describeSummary("updated", { changes: "oops", changed: 5 } as never)).toEqual([]);
    expect(describeSummary("updated", { changes: { name: "x" } } as never)).toEqual([]);
  });
});
