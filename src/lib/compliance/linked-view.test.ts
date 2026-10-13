import { describe, expect, it } from "vitest";

import type { RaisedItem } from "./raise-types";
import { complianceSectionVisible, isOpenStatus, LINKED_POLL_MS, linkedCounts, linkedRow, linkedRows, linkedTypeLabel, OPEN_STATUSES, type LinkedInput } from "./linked-view";

// The pure parts of the "Compliance requests" section of the Inbox ticket column (migration 185). The markup is covered by
// src/components/inbox/link-card-render.test.tsx.

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const item = (over: Partial<LinkedInput> = {}): LinkedInput => ({
  reference: "CMP-2026-000014",
  typeKey: "closure",
  typeLabel: "Account closure",
  typeLabelL10n: { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지" },
  status: "in_review",
  raisedAt: "2026-10-12T08:00:00Z",
  ...over,
});

describe("open statuses and counts", () => {
  it("counts received, in review and in progress as open, and the other three as not", () => {
    expect([...OPEN_STATUSES]).toEqual(["received", "in_review", "in_progress"]);
    const all: RaisedItem["status"][] = ["received", "in_review", "in_progress", "done", "not_approved", "closed"];
    expect(all.filter(isOpenStatus)).toEqual(["received", "in_review", "in_progress"]);
  });

  it("totals the requests and the open ones", () => {
    expect(linkedCounts([])).toEqual({ total: 0, open: 0 });
    expect(linkedCounts([item(), item({ status: "done" }), item({ status: "received" }), item({ status: "closed" })])).toEqual({ total: 4, open: 2 });
    expect(linkedCounts([item({ status: "not_approved" })])).toEqual({ total: 1, open: 0 });
  });
});

describe("whether the section is drawn", () => {
  it("needs the workspace flag AND the server not to say it is off", () => {
    expect(complianceSectionVisible(true, true)).toBe(true);
    expect(complianceSectionVisible(true, null)).toBe(true); // waiting for the first answer
    expect(complianceSectionVisible(true, false)).toBe(false); // the server says Compliance is off
    expect(complianceSectionVisible(false, true)).toBe(false); // the browser's platform flag is off
    expect(complianceSectionVisible(false, null)).toBe(false);
    expect(complianceSectionVisible(false, false)).toBe(false);
  });
});

describe("the type in the person's language", () => {
  it("uses the translated label and falls back to the English one", () => {
    expect(linkedTypeLabel(item(), "ms")).toBe("Penutupan akaun");
    expect(linkedTypeLabel(item(), "zh")).toBe("关闭账户");
    expect(linkedTypeLabel(item(), "en")).toBe("Account closure");
    expect(linkedTypeLabel(item({ typeLabelL10n: {} }), "ko")).toBe("Account closure");
    expect(linkedTypeLabel(item({ typeLabelL10n: { ko: "  " } }), "ko")).toBe("Account closure");
    expect(linkedTypeLabel(item({ typeLabelL10n: undefined as never }), "ms")).toBe("Account closure");
  });
});

describe("a row", () => {
  it("links to the case only when the person may open it AND the server gave the id", () => {
    expect(linkedRow(item({ id: ID }), "en", true).href).toBe(`/compliance/${ID}`);
    expect(linkedRow(item({ id: ID }), "en", false).href).toBeNull(); // no Compliance menu
    expect(linkedRow(item(), "en", true).href).toBeNull(); // the raiser's projection has no id
    expect(linkedRow(item({ id: "../../etc" }), "en", true).href).toBeNull(); // anything that is not an id is never put in an address
  });

  it("carries only the reference, the type, the status and the time", () => {
    // a server that sent more (the case's own step, a customer) cannot get it onto the screen
    const decorated = { ...item({ id: ID }), step: "awaiting_signoff", customerName: "Siti Aminah", customerPhone: "+60123456789" } as LinkedInput;
    const row = linkedRow(decorated, "ms", false);
    expect(Object.keys(row).sort()).toEqual(["href", "key", "raisedAt", "reference", "status", "typeLabel"]);
    expect(JSON.stringify(row)).not.toContain("Siti");
    expect(JSON.stringify(row)).not.toContain("awaiting_signoff");
    expect(row.typeLabel).toBe("Penutupan akaun");
  });

  it("keeps the order of the answer (newest first)", () => {
    const rows = linkedRows([item({ reference: "CMP-2026-000015" }), item({ reference: "CMP-2026-000014" })], "en", false);
    expect(rows.map((r) => r.reference)).toEqual(["CMP-2026-000015", "CMP-2026-000014"]);
  });
});

describe("polling", () => {
  it("asks again every minute", () => {
    expect(LINKED_POLL_MS).toBe(60_000);
  });
});
