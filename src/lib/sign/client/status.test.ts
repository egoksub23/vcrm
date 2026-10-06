import { describe, expect, it } from "vitest";

import { DOCUMENT_STATUSES, SIGNER_STATUSES } from "../types";
import { DOCUMENT_BADGE, SIGNER_BADGE, documentBadgeClass, documentStatusKey, signerBadgeClass, signerProgress, signerStatusKey, waitingOn, waitingSummary } from "./status";

describe("status keys", () => {
  it("has a key and a badge class for every document status", () => {
    for (const s of DOCUMENT_STATUSES) {
      expect(documentStatusKey(s)).toBe(`status.document.${s}`);
      expect(DOCUMENT_BADGE[s]).toBeTruthy();
    }
  });

  it("has a key and a badge class for every signer status", () => {
    for (const s of SIGNER_STATUSES) {
      expect(signerStatusKey(s)).toBe(`status.signer.${s}`);
      expect(SIGNER_BADGE[s]).toBeTruthy();
    }
  });

  it("reads a finished filler as filled in, not signed", () => {
    expect(signerStatusKey("signed", "filler")).toBe("status.signer.filled");
    expect(signerStatusKey("sent", "filler")).toBe("status.signer.sent");
  });

  it("does not invent a key for a status it does not know", () => {
    expect(documentStatusKey("archived")).toBe("status.unknown");
    expect(signerStatusKey("whatever")).toBe("status.unknown");
    expect(documentBadgeClass("archived")).toContain("muted");
    expect(signerBadgeClass("whatever")).toContain("muted");
  });

  it("uses tints that carry a dark-mode text colour for every coloured badge", () => {
    for (const cls of [...Object.values(DOCUMENT_BADGE), ...Object.values(SIGNER_BADGE)]) {
      if (cls.includes("muted")) continue;
      expect(cls).toMatch(/dark:text-/);
    }
  });
});

const people = [
  { full_name: "Siti", status: "viewed", order_no: 2 },
  { full_name: "Ali", status: "sent", order_no: 1 },
  { full_name: "Director", status: "pending", order_no: 3 },
  { full_name: "Done", status: "signed", order_no: 0 },
];

describe("who is waiting", () => {
  it("lists invited people who have not finished, in order", () => {
    expect(waitingOn("in_progress", people).map((p) => p.full_name)).toEqual(["Ali", "Siti"]);
  });

  it("is nobody unless the document is open", () => {
    expect(waitingOn("draft", people)).toEqual([]);
    expect(waitingOn("completed", people)).toEqual([]);
    expect(waitingOn("voided", people)).toEqual([]);
  });

  it("cuts the names and counts the rest", () => {
    const many = ["a", "b", "c", "d"].map((n, i) => ({ full_name: n, status: "sent", order_no: i + 1 }));
    expect(waitingSummary("sent", many)).toEqual({ names: ["a", "b"], more: 2 });
    expect(waitingSummary("sent", many.slice(0, 1))).toEqual({ names: ["a"], more: 0 });
    expect(waitingSummary("draft", many)).toEqual({ names: [], more: 0 });
  });

  it("counts who has signed", () => {
    expect(signerProgress(people)).toEqual({ done: 1, total: 4 });
    expect(signerProgress([])).toEqual({ done: 0, total: 0 });
  });
});
