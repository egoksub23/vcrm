import { describe, expect, it, vi } from "vitest";

import { CCA_FORM, type RosterEntry } from "./form-schema";
import { clearDraft, draftKey, firstStepWithProblem, loadDraft, memoryStorage, notifyParent, parentMessage, pickStorage, saveDraft, stepProblems } from "./report-client";

const roster: RosterEntry[] = [{ student_id: "S-1", name: "Adam" }];

describe("drafts", () => {
  it("saves and restores a draft, and clears it after sending", () => {
    const s = memoryStorage();
    expect(loadDraft(s, "tok")).toBeNull();
    saveDraft(s, "tok", { answers: { kind: "injury" }, step: 1, pending: false });
    expect(loadDraft(s, "tok")).toEqual({ answers: { kind: "injury" }, step: 1, pending: false });
    clearDraft(s, "tok");
    expect(loadDraft(s, "tok")).toBeNull();
  });

  it("keeps a separate draft per link and never puts a child's name in the key", () => {
    expect(draftKey("abc.def")).not.toBe(draftKey("xyz.def"));
    expect(draftKey("abc.def")).toBe("halo-report:abc.def");
  });

  it("ignores a damaged draft", () => {
    const s = memoryStorage();
    s.setItem(draftKey("tok"), "{not json");
    expect(loadDraft(s, "tok")).toBeNull();
    s.setItem(draftKey("tok"), JSON.stringify({ answers: [] }));
    expect(loadDraft(s, "tok")).toBeNull();
    s.setItem(draftKey("tok"), JSON.stringify({ answers: { a: 1 } }));
    expect(loadDraft(s, "tok")).toEqual({ answers: { a: 1 }, step: 0, pending: false });
  });

  it("falls back to memory when the browser's storage is missing or throws", () => {
    const blocked = pickStorage(() => {
      throw new Error("SecurityError");
    });
    saveDraft(blocked, "tok", { answers: { x: 1 }, step: 0, pending: true });
    expect(loadDraft(blocked, "tok")?.pending).toBe(true);
    expect(pickStorage(() => null)).toBeTruthy();
    const throwsOnWrite = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => {} };
    expect(() => saveDraft(throwsOnWrite, "tok", { answers: {}, step: 0, pending: false })).not.toThrow();
    expect(pickStorage(() => throwsOnWrite)).not.toBe(throwsOnWrite);
  });
});

describe("messages to the framing page", () => {
  it("has exactly the four messages the hand-off guide documents, with no personal data", () => {
    expect(parentMessage.ready()).toEqual({ source: "halo-incident", type: "ready" });
    expect(parentMessage.resize(640.4)).toEqual({ source: "halo-incident", type: "resize", height: 640 });
    expect(parentMessage.submitted("INC-2026-31")).toEqual({ source: "halo-incident", type: "submitted", reference: "INC-2026-31" });
    expect(parentMessage.error("link_expired")).toEqual({ source: "halo-incident", type: "error", code: "link_expired" });
  });

  it("posts to each registered origin and never to '*'", () => {
    const post = vi.fn();
    const self = {};
    const win = { parent: { postMessage: post } };
    const n = notifyParent(win, self, ["https://a.example", "https://b.example"], parentMessage.ready());
    expect(n).toBe(2);
    expect(post.mock.calls.map((c) => c[1])).toEqual(["https://a.example", "https://b.example"]);
    expect(post.mock.calls.some((c) => c[1] === "*")).toBe(false);
  });

  it("does nothing when the report is not framed, or no origin is registered", () => {
    const self = {};
    expect(notifyParent({ parent: self }, self, ["https://a.example"], parentMessage.ready())).toBe(0);
    expect(notifyParent({ parent: { postMessage: vi.fn() } }, self, [], parentMessage.ready())).toBe(0);
  });

  it("survives a parent that throws", () => {
    const win = { parent: { postMessage: () => { throw new Error("blocked"); } } };
    expect(notifyParent(win, {}, ["https://a.example"], parentMessage.ready())).toBe(0);
  });
});

describe("steps", () => {
  it("reports problems for the current step only", () => {
    const [who, what] = CCA_FORM.steps;
    expect(Object.keys(stepProblems(CCA_FORM, who, {}, roster))).toEqual(["involved"]);
    expect(Object.keys(stepProblems(CCA_FORM, what, { involved: { ids: ["S-1"], others: [] } }, roster)).sort()).toEqual(["kind", "what"]);
  });
  it("finds the first step that has a problem", () => {
    expect(firstStepWithProblem(CCA_FORM, { severity: "Choose one." })).toBe(2);
    expect(firstStepWithProblem(CCA_FORM, { involved: "x", severity: "y" })).toBe(0);
    expect(firstStepWithProblem(CCA_FORM, {})).toBe(0);
  });
});
