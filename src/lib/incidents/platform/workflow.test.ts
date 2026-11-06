import { describe, expect, it } from "vitest";

import { evaluateMove, parseGuards, statusIndex, type Guard, type MoveFacts } from "./workflow";

const roleName = (k: string) => ({ principal: "The Principal", dpo: "The DPO" })[k] ?? k;
const statusName = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const facts = (over: Partial<MoveFacts> = {}): MoveFacts => ({ from: "investigating", to: "closed", rootCause: "Wet floor", leadAssigned: true, openSteps: 0, approvals: [], ...over });
const run = (f: MoveFacts, guards: Guard[], allowBackward = true) => evaluateMove({ facts: f, guards, allowBackward, roleName, statusName });
const closeNeeds = (requires: Guard["requires"]): Guard[] => [{ to_status: "closed", requires }];

describe("evaluateMove", () => {
  it("lets any move through when the school has set no requirements", () => {
    expect(run(facts({ rootCause: null, openSteps: 5, leadAssigned: false }), [])).toEqual({ ok: true, needsApprovalFrom: null });
  });

  it("needs a root cause, a lead and every required step done, and lists everything that is missing at once", () => {
    const out = run(facts({ rootCause: "  ", leadAssigned: false, openSteps: 2 }), closeNeeds({ root_cause: true, lead_assigned: true, steps_done: true }));
    expect(out).toMatchObject({ ok: false, problems: ["Write the root cause first.", "Assign an incident lead first.", "2 required steps are still open."] });
  });

  it("words a single open step in the singular and passes when everything is in order", () => {
    expect(run(facts({ openSteps: 1 }), closeNeeds({ steps_done: true }))).toMatchObject({ problems: ["1 required step is still open."] });
    expect(run(facts(), closeNeeds({ root_cause: true, lead_assigned: true, steps_done: true }))).toEqual({ ok: true, needsApprovalFrom: null });
  });

  it("applies a requirement only to the status it was set for", () => {
    expect(run(facts({ to: "recovered", rootCause: null }), closeNeeds({ root_cause: true }))).toEqual({ ok: true, needsApprovalFrom: null });
  });

  it("asks the role to approve, and says so when they have not answered or said no", () => {
    const g = closeNeeds({ approval_role: "principal" });
    expect(run(facts(), g)).toMatchObject({ ok: false, needsApprovalFrom: "principal", problems: ["The Principal must approve first. They are being asked now."] });
    expect(run(facts({ approvals: [{ role_key: "principal", decision: null }] }), g)).toMatchObject({ problems: ["The Principal has been asked and has not answered yet."] });
    expect(run(facts({ approvals: [{ role_key: "principal", decision: "rejected" }] }), g)).toMatchObject({ needsApprovalFrom: "principal", problems: [expect.stringContaining("did not approve")] });
    expect(run(facts({ approvals: [{ role_key: "principal", decision: "approved" }] }), g)).toEqual({ ok: true, needsApprovalFrom: null });
  });

  it("uses only the newest decision for a role, and ignores other roles' approvals", () => {
    const g = closeNeeds({ approval_role: "principal" });
    expect(run(facts({ approvals: [{ role_key: "principal", decision: "approved" }, { role_key: "principal", decision: "rejected" }] }), g).ok).toBe(true);
    expect(run(facts({ approvals: [{ role_key: "dpo", decision: "approved" }] }), g).ok).toBe(false);
  });

  it("can forbid moving back, but not moving forward or staying put", () => {
    expect(run(facts({ from: "recovered", to: "triaged" }), [], false)).toMatchObject({ ok: false, problems: [expect.stringContaining("does not allow an incident to move back from Recovered to Triaged")] });
    expect(run(facts({ from: "triaged", to: "recovered" }), [], false).ok).toBe(true);
    expect(run(facts({ from: "triaged", to: "triaged", rootCause: null }), closeNeeds({ root_cause: true }), false).ok).toBe(true);
  });
});

describe("parseGuards", () => {
  it("accepts requirements, drops empty ones, and reads the backward switch", () => {
    expect(parseGuards({ allow_backward: false, guards: [{ to_status: "closed", requires: { root_cause: true, steps_done: true, approval_role: "principal", junk: 1 } }, { to_status: "recovered", requires: {} }] }, ["principal"])).toEqual({
      ok: true,
      allowBackward: false,
      guards: [{ to_status: "closed", requires: { root_cause: true, steps_done: true, approval_role: "principal" } }],
    });
  });
  it("refuses a requirement on 'reported', an unknown status, an unknown role, or a malformed body", () => {
    expect(parseGuards({ guards: [{ to_status: "reported", requires: { root_cause: true } }] }, [])).toMatchObject({ ok: false });
    expect(parseGuards({ guards: [{ to_status: "archived", requires: {} }] }, [])).toMatchObject({ ok: false });
    expect(parseGuards({ guards: [{ to_status: "closed", requires: { approval_role: "ghost" } }] }, ["principal"])).toMatchObject({ ok: false, error: 'There is no role "ghost".' });
    expect(parseGuards({ guards: "x" }, [])).toMatchObject({ ok: false });
    expect(parseGuards(null, [])).toMatchObject({ ok: false });
    expect(parseGuards({ guards: [], allow_backward: "no" }, [])).toMatchObject({ ok: false });
  });
  it("knows the order of statuses", () => {
    expect(statusIndex("reported")).toBe(0);
    expect(statusIndex("closed")).toBeGreaterThan(statusIndex("investigating"));
    expect(statusIndex("nope")).toBe(-1);
  });
});
