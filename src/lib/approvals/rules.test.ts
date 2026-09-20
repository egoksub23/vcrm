import { describe, expect, it } from "vitest";

import {
  approvalErrorCode,
  approvalErrorStatus,
  badgeLabel,
  buildDiff,
  buildEditPatch,
  bulkApprovable,
  canWithdraw,
  changedCount,
  chipState,
  countByType,
  isUsable,
  itemKey,
  mergePendingEdit,
  stripPendingEdit,
  writeMode,
} from "./rules";
import { APPROVAL_ERROR_CODES } from "./types";

describe("writeMode: direct, propose or deny", () => {
  it("goes live for someone who can manage", () => {
    expect(writeMode(new Set(["snippets.manage", "snippets.propose"]), "snippets.manage", "snippets.propose")).toBe(
      "direct",
    );
    expect(writeMode(["tags.manage"], "tags.manage", "tags.propose")).toBe("direct");
  });

  it("proposes for someone who can only propose", () => {
    expect(writeMode(new Set(["tags.propose"]), "tags.manage", "tags.propose")).toBe("propose");
  });

  it("denies when neither is held (a Viewer, or a role with both removed)", () => {
    expect(writeMode(new Set(["reports.view"]), "tags.manage", "tags.propose")).toBe("deny");
    expect(writeMode([], "snippets.manage", "snippets.propose")).toBe("deny");
  });

  it("does not let the propose capability of the other kind count", () => {
    expect(writeMode(new Set(["snippets.propose"]), "tags.manage", "tags.propose")).toBe("deny");
  });
});

describe("mergePendingEdit", () => {
  const live = { name: "VIP", color: "#111111", description: "Gold" as string | null };

  it("lays the proposed values over the live ones and leaves the rest", () => {
    expect(mergePendingEdit(live, { name: "VIP gold" })).toEqual({
      name: "VIP gold",
      color: "#111111",
      description: "Gold",
    });
  });

  it("treats a key set to null as a real change to null", () => {
    expect(mergePendingEdit(live, { description: null })).toEqual({
      name: "VIP",
      color: "#111111",
      description: null,
    });
  });

  it("returns a copy of the live values when nothing is pending, and never mutates", () => {
    const merged = mergePendingEdit(live, null);
    expect(merged).toEqual(live);
    expect(merged).not.toBe(live);
    mergePendingEdit(live, { name: "x" });
    expect(live.name).toBe("VIP");
  });
});

describe("buildEditPatch", () => {
  const live = { name: "VIP", color: "#111111", description: null as string | null };

  it("keeps only the values that differ from the live row", () => {
    expect(buildEditPatch(live, { name: "VIP", color: "#222222", description: null })).toEqual({
      color: "#222222",
    });
  });

  it("is empty when nothing changed (nothing to propose)", () => {
    expect(buildEditPatch(live, { name: "VIP", color: "#111111" })).toEqual({});
  });

  it("notices a description that was cleared", () => {
    expect(buildEditPatch({ ...live, description: "Gold" as string | null }, { description: null })).toEqual({
      description: null,
    });
  });

  it("only looks at the requested keys", () => {
    expect(buildEditPatch(live, { name: "X", color: "#000000" }, ["color"])).toEqual({ color: "#000000" });
  });
});

describe("chipState: who sees what", () => {
  const mine = "u-proposer";
  const other = "u-other";

  it("shows Pending to the proposer and to reviewers, to nobody else", () => {
    const row = { approval_status: "pending" as const, proposed_by: mine };
    expect(chipState(row, mine, false)).toBe("pending");
    expect(chipState(row, other, true)).toBe("pending");
    expect(chipState(row, other, false)).toBeNull();
    expect(chipState(row, null, false)).toBeNull();
  });

  it("shows Rejected for a rejected creation", () => {
    expect(chipState({ approval_status: "rejected", proposed_by: mine }, mine, false)).toBe("rejected");
  });

  it("shows Pending changes on a live row with a pending edit, only to the proposer and reviewers", () => {
    const row = {
      approval_status: "approved" as const,
      proposed_by: mine,
      pending_edit: { name: "x" },
      edit_status: "pending" as const,
    };
    expect(chipState(row, mine, false)).toBe("pending_changes");
    expect(chipState(row, other, true)).toBe("pending_changes");
    expect(chipState(row, other, false)).toBeNull();
  });

  it("shows Changes rejected for a rejected edit", () => {
    expect(
      chipState(
        { approval_status: "approved", proposed_by: mine, pending_edit: { name: "x" }, edit_status: "rejected" },
        mine,
        false,
      ),
    ).toBe("changes_rejected");
  });

  it("shows nothing on an ordinary live row, even to its old proposer", () => {
    expect(chipState({ approval_status: "approved", proposed_by: mine }, mine, true)).toBeNull();
    expect(chipState({}, mine, true)).toBeNull();
  });
});

describe("isUsable, stripPendingEdit and canWithdraw", () => {
  it("only an approved row (or one from before migration 084) may be applied or sent", () => {
    expect(isUsable({})).toBe(true);
    expect(isUsable({ approval_status: "approved" })).toBe(true);
    expect(isUsable({ approval_status: "pending" })).toBe(false);
    expect(isUsable({ approval_status: "rejected" })).toBe(false);
  });

  it("never lets a pending edit reach someone who may not see it", () => {
    const row = { approval_status: "approved" as const, proposed_by: "p", pending_edit: { name: "x" }, edit_status: "pending" as const };
    expect(stripPendingEdit(row, "someone", false).pending_edit).toBeNull();
    expect(stripPendingEdit(row, "someone", false).edit_status).toBeNull();
    expect(stripPendingEdit(row, "p", false).pending_edit).toEqual({ name: "x" });
    expect(stripPendingEdit(row, "someone", true).pending_edit).toEqual({ name: "x" });
  });

  it("lets a proposer withdraw only their own open proposals", () => {
    const pending = { approval_status: "pending" as const, proposed_by: "p" };
    expect(canWithdraw(pending, "p")).toBe(true);
    expect(canWithdraw(pending, "q")).toBe(false);
    expect(canWithdraw(pending, null)).toBe(false);
    expect(canWithdraw({ approval_status: "approved", proposed_by: "p" }, "p")).toBe(false);
  });
});

describe("buildDiff", () => {
  it("marks the changed fields of an edit", () => {
    const rows = buildDiff(
      "tag",
      { name: "VIP", color: "#111111", description: null, for_contacts: true, for_conversations: true },
      { name: "VIP gold", color: "#111111", description: null, for_contacts: true, for_conversations: true },
    );
    expect(rows.map((r) => r.field)).toEqual(["name", "color", "description", "for_contacts", "for_conversations"]);
    expect(rows.filter((r) => r.changed).map((r) => r.field)).toEqual(["name"]);
    expect(changedCount(rows)).toBe(1);
    expect(rows[0]).toMatchObject({ from: "VIP", to: "VIP gold", changed: true });
  });

  it("previews a new item: every filled value, none empty", () => {
    const rows = buildDiff("tag", null, {
      name: "Wholesale",
      color: "#ff8800",
      description: null,
      for_contacts: true,
      for_conversations: false,
    });
    expect(rows.map((r) => r.field)).toEqual(["name", "color", "for_contacts", "for_conversations"]);
    expect(rows.every((r) => r.changed)).toBe(true);
  });

  it("shows only the body that matches a snippet's kind", () => {
    const text = buildDiff("snippet", null, {
      title: "Hours",
      kind: "text",
      content_text: "We open at 9",
      interactive_payload: null,
    });
    expect(text.map((r) => r.field)).toEqual(["title", "kind", "content_text"]);
    const interactive = buildDiff(
      "snippet",
      { title: "Menu", kind: "text", content_text: "Old", interactive_payload: null },
      { title: "Menu", kind: "interactive", content_text: null, interactive_payload: { kind: "buttons" } },
    );
    expect(interactive.filter((r) => r.changed).map((r) => r.field)).toEqual([
      "kind",
      "content_text",
      "interactive_payload",
    ]);
  });

  it("previews an article by its title, language and text", () => {
    const rows = buildDiff("article", null, { title: "Returns", language: "en", content_text: "14 days" });
    expect(rows.map((r) => r.field)).toEqual(["title", "language", "content_text"]);
  });
});

describe("badges and lists", () => {
  it("caps the badge at 9+ and hides zero", () => {
    expect(badgeLabel(0)).toBe("");
    expect(badgeLabel(null)).toBe("");
    expect(badgeLabel(undefined)).toBe("");
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
    expect(badgeLabel(250)).toBe("9+");
  });

  it("counts a page of the queue by type", () => {
    expect(
      countByType([
        { entity_type: "tag" },
        { entity_type: "tag" },
        { entity_type: "snippet" },
        { entity_type: "article" },
      ]),
    ).toEqual({ tag: 2, snippet: 1, article: 1 });
  });

  it("keys a row by type, id and action, and bulk-approves only pending rows", () => {
    expect(itemKey({ entity_type: "tag", entity_id: "1", action: "edit" })).toBe("tag:1:edit");
    expect(bulkApprovable([{ status: "pending" }, { status: "approved" }, { status: "rejected" }])).toEqual([
      { status: "pending" },
    ]);
  });
});

describe("error codes", () => {
  it("reads the code from an RPC error message", () => {
    expect(approvalErrorCode({ message: "name_conflict", code: "23505" })).toBe("name_conflict");
    expect(approvalErrorCode({ message: "note_required", code: "22023" })).toBe("note_required");
    expect(approvalErrorCode({ message: "not_pending", code: "P0001" })).toBe("not_pending");
  });

  it("falls back to the SQLSTATE", () => {
    expect(approvalErrorCode({ message: "duplicate key value", code: "23505" })).toBe("name_conflict");
    expect(approvalErrorCode({ message: "This action requires the 'tags.propose' permission", code: "42501" })).toBe(
      "forbidden",
    );
    expect(approvalErrorCode({ message: "boom", code: "XX000" })).toBe("unknown");
    expect(approvalErrorCode(null)).toBe("unknown");
  });

  it("maps every code to a sensible status", () => {
    expect(approvalErrorStatus("forbidden")).toBe(403);
    expect(approvalErrorStatus("own_proposal")).toBe(403);
    expect(approvalErrorStatus("not_found")).toBe(404);
    expect(approvalErrorStatus("name_conflict")).toBe(409);
    expect(approvalErrorStatus("edit_pending")).toBe(409);
    expect(approvalErrorStatus("invalid_name")).toBe(400);
    expect(approvalErrorStatus("unknown")).toBe(500);
    for (const c of APPROVAL_ERROR_CODES) {
      expect([400, 403, 404, 409, 500]).toContain(approvalErrorStatus(c));
    }
  });
});
