import { describe, expect, it } from "vitest";

import { conclusionsOf, isNoteKind, kindOf } from "./note-kinds";
import { evaluateMove } from "./workflow";

describe("note kinds", () => {
  it("knows the three kinds, and reads an older finding", () => {
    expect(isNoteKind("closing")).toBe(true);
    expect(isNoteKind("random")).toBe(false);
    expect(kindOf({ kind: "investigation" })).toBe("investigation");
    expect(kindOf({ is_finding: true })).toBe("finding");
    expect(kindOf({ kind: null, is_finding: false })).toBeNull();
  });

  it("orders conclusions: closing note, findings, investigation notes in time order", () => {
    const notes = [
      { body: "b", created_at: "2026-11-10T02:00:00Z", kind: "investigation" },
      { body: "a", created_at: "2026-11-10T01:00:00Z", kind: "investigation" },
      { body: "f", created_at: "2026-11-10T03:00:00Z", is_finding: true },
      { body: "c", created_at: "2026-11-10T04:00:00Z", kind: "closing" },
      { body: "plain", created_at: "2026-11-10T05:00:00Z" },
    ];
    const c = conclusionsOf(notes);
    expect(c.closing.map((n) => n.body)).toEqual(["c"]);
    expect(c.findings.map((n) => n.body)).toEqual(["f"]);
    expect(c.investigation.map((n) => n.body)).toEqual(["a", "b"]);
  });
});

describe("closing note as a requirement", () => {
  const run = (hasClosingNote: boolean, required: boolean) =>
    evaluateMove({
      facts: { from: "recovered", to: "closed", rootCause: "x", leadAssigned: true, openSteps: 0, approvals: [], hasClosingNote },
      guards: required ? [{ to_status: "closed", requires: { closing_note: true } }] : [],
      allowBackward: true,
      roleName: (k) => k,
      statusName: (s) => s,
    });

  it("holds the move back until a closing note is written, when the school asks for one", () => {
    expect(run(false, true)).toMatchObject({ ok: false, problems: ["Write the closing note first."] });
    expect(run(true, true)).toEqual({ ok: true, needsApprovalFrom: null });
    expect(run(false, false)).toEqual({ ok: true, needsApprovalFrom: null });
  });
});
