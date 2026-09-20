import { describe, expect, it } from "vitest";

import { buildAuditParams, entityHref, resolveRange } from "./client";
import { EMPTY_AUDIT_FILTERS } from "./types";

describe("resolveRange", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");

  it("presets look back from now and leave the end open", () => {
    expect(resolveRange("24h", undefined, now)).toEqual({ from: "2026-09-19T12:00:00.000Z", to: null });
    expect(resolveRange("7d", undefined, now).from).toBe("2026-09-13T12:00:00.000Z");
    expect(resolveRange("30d", undefined, now).from).toBe("2026-08-21T12:00:00.000Z");
  });

  it("all time has no bounds", () => {
    expect(resolveRange("all", undefined, now)).toEqual({ from: null, to: null });
  });

  it("custom dates are local days, the end date inclusive", () => {
    const r = resolveRange("custom", { from: "2026-09-01", to: "2026-09-03" }, now);
    expect(r.from).toBe(new Date(2026, 8, 1).toISOString());
    expect(r.to).toBe(new Date(2026, 8, 4).toISOString());
  });

  it("blank or invalid custom dates leave that side open", () => {
    expect(resolveRange("custom", { from: "", to: "" }, now)).toEqual({ from: null, to: null });
    expect(resolveRange("custom", { from: "soon", to: "2026-09-03" }, now).from).toBeNull();
  });
});

describe("buildAuditParams", () => {
  it("only sends what is set", () => {
    expect(buildAuditParams(EMPTY_AUDIT_FILTERS).toString()).toBe("");
    const p = buildAuditParams(
      { ...EMPTY_AUDIT_FILTERS, action: "deleted", entityType: "tag", q: "vip" },
      { limit: 50, cursor: "c1" },
    );
    expect(Object.fromEntries(p)).toEqual({
      action: "deleted",
      entity_type: "tag",
      q: "vip",
      limit: "50",
      cursor: "c1",
    });
  });
});

describe("entityHref", () => {
  const base = { entityId: "abc", entityExists: null as boolean | null };

  it("links only while the item exists", () => {
    expect(entityHref({ ...base, entityType: "article", entityExists: true })).toBe("/knowledge/abc");
    expect(entityHref({ ...base, entityType: "article", entityExists: false })).toBeNull();
    expect(entityHref({ ...base, entityType: "tag", entityExists: false })).toBeNull();
  });

  it("points settings items at their screens", () => {
    expect(entityHref({ ...base, entityType: "tag" })).toBe("/settings?tab=tags");
    expect(entityHref({ ...base, entityType: "snippet" })).toBe("/settings?tab=quick-replies");
    expect(entityHref({ ...base, entityType: "role" })).toBe("/settings?tab=roles");
    expect(entityHref({ ...base, entityType: "api_key" })).toBe("/settings?tab=api");
  });

  it("opens a conversation in the inbox and has nowhere to send a contact", () => {
    expect(entityHref({ ...base, entityType: "conversation" })).toBe("/inbox?c=abc");
    expect(entityHref({ ...base, entityType: "contact" })).toBeNull();
    expect(entityHref({ ...base, entityType: "ai_settings" })).toBeNull();
  });
});
