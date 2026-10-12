import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REQUEST_STATUSES, type RequestStatus, type Viewer } from "./types";
import { STEPS, TRANSITIONS, actionsFor, canMove, capabilityForMove, makerCheckerAllows, stepIndexOf, viewerMayMove, type ActionInput } from "./transitions";

const viewer = (over: Partial<Viewer> = {}): Viewer => ({ userId: "u-me", canReview: true, canApprove: false, canReveal: false, canExecute: false, canManage: false, ...over });
const input = (over: Partial<ActionInput> = {}): ActionInput => ({
  status: "received",
  viewer: viewer(),
  requiresIdentityCheck: true,
  checkDues: false,
  identity: {},
  duesOutstanding: null,
  checklistTotal: 3,
  checklistDone: 0,
  ...over,
});
const keys = (i: ActionInput) => actionsFor(i).map((a) => a.key);
const state = (i: ActionInput, key: string) => actionsFor(i).find((a) => a.key === key);

describe("the transition table", () => {
  it("is exactly the table in the database function (migration 183)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "183_compliance_requests.sql"), "utf8");
    const block = sql.slice(sql.indexOf("v_ok := CASE r.status"), sql.indexOf("ELSE FALSE", sql.indexOf("v_ok := CASE r.status")));
    const parsed: Record<string, string[]> = {};
    for (const m of block.matchAll(/WHEN '(\w+)'\s+THEN p_to IN \(([^)]*)\)/g)) parsed[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
    const mine = Object.fromEntries(Object.entries(TRANSITIONS).filter(([, to]) => to.length > 0).map(([from, to]) => [from, [...to].sort()]));
    expect(parsed).toEqual(mine);
  });

  it("covers every status, and nothing leaves closed", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...REQUEST_STATUSES].sort());
    expect(TRANSITIONS.closed).toEqual([]);
  });

  it("allows the happy path and refuses skipping", () => {
    const path: RequestStatus[] = ["received", "identity_check", "officer_review", "awaiting_signoff", "approved", "executing", "completed", "closed"];
    for (let i = 0; i < path.length - 1; i++) expect(canMove(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    expect(canMove("received", "approved")).toBe(false);
    expect(canMove("officer_review", "approved")).toBe(false);
    expect(canMove("awaiting_signoff", "executing")).toBe(false);
    expect(canMove("rejected", "approved")).toBe(false);
    expect(canMove("closed", "received")).toBe(false);
    expect(canMove("approved", "rejected")).toBe(false);
  });

  it("lets a case be sent back, and closed without a decision before the sign-off", () => {
    expect(canMove("awaiting_signoff", "officer_review")).toBe(true);
    expect(canMove("officer_review", "identity_check")).toBe(true);
    for (const s of ["received", "identity_check", "officer_review"] as const) expect(canMove(s, "closed")).toBe(true);
    expect(canMove("awaiting_signoff", "closed")).toBe(false);
  });
});

describe("the capability a move needs", () => {
  it("sign-off and send-back: approve; execution: execute; the rest: review", () => {
    expect(capabilityForMove("awaiting_signoff", "approved")).toBe("approve");
    expect(capabilityForMove("awaiting_signoff", "rejected")).toBe("approve");
    expect(capabilityForMove("awaiting_signoff", "officer_review")).toBe("approve");
    expect(capabilityForMove("approved", "executing")).toBe("execute");
    expect(capabilityForMove("executing", "completed")).toBe("execute");
    expect(capabilityForMove("received", "identity_check")).toBe("review");
    expect(capabilityForMove("received", "officer_review")).toBe("review");
    expect(capabilityForMove("officer_review", "awaiting_signoff")).toBe("review");
    expect(capabilityForMove("officer_review", "identity_check")).toBe("review");
    expect(capabilityForMove("completed", "closed")).toBe("review");
  });

  it("the Head (approve) may also do the officer's work; the officer may not sign off", () => {
    const head = viewer({ canReview: false, canApprove: true });
    const officer = viewer({ canReview: true, canApprove: false });
    expect(viewerMayMove(head, "received", "officer_review")).toBe(true);
    expect(viewerMayMove(officer, "received", "officer_review")).toBe(true);
    expect(viewerMayMove(officer, "awaiting_signoff", "approved")).toBe(false);
    expect(viewerMayMove(head, "awaiting_signoff", "approved")).toBe(true);
    expect(viewerMayMove(head, "approved", "executing")).toBe(false);
    expect(viewerMayMove(viewer({ canReview: false, canExecute: true }), "approved", "executing")).toBe(true);
  });
});

describe("maker-checker", () => {
  it("refuses the person who recorded the identity check, whichever field names them", () => {
    expect(makerCheckerAllows({ verifiedBy: "u-me" }, "u-me")).toBe(false);
    expect(makerCheckerAllows({ recordedBy: "u-me" }, "u-me")).toBe(false);
    expect(makerCheckerAllows({ verifiedBy: "u-a", recordedBy: "u-me" }, "u-me")).toBe(false);
    expect(makerCheckerAllows({ verifiedBy: "u-a", recordedBy: "u-a" }, "u-me")).toBe(true);
  });
  it("lets anyone sign off a case whose identity check was not required (nobody made it)", () => {
    expect(makerCheckerAllows({}, "u-me")).toBe(true);
    expect(makerCheckerAllows({ verifiedBy: null, recordedBy: null }, "u-me")).toBe(true);
  });
});

describe("what the screen offers", () => {
  it("offers the identity check on a received case, to a reviewer; a viewer with no permission sees it switched off", () => {
    expect(keys(input())).toEqual(["start_identity_check", "record_identity_check", "close_without_decision"]);
    expect(state(input(), "record_identity_check")).toMatchObject({ enabled: true });
    expect(state(input({ viewer: viewer({ canReview: false }) }), "record_identity_check")).toMatchObject({ enabled: false, reason: "no_permission" });
  });

  it("switches sign-off off for the person who did the identity check, with the reason, and on for someone else with the permission", () => {
    const head = viewer({ canApprove: true, canReview: true });
    const base = input({ status: "awaiting_signoff", viewer: head, identity: { outcome: "pass", verifiedBy: "u-me", recordedBy: "u-me" } });
    expect(state(base, "approve")).toMatchObject({ enabled: false, reason: "maker_checker" });
    expect(state(base, "reject")).toMatchObject({ enabled: false, reason: "maker_checker" });
    expect(state(base, "send_back_to_officer")).toMatchObject({ enabled: true });
    const other = { ...base, identity: { outcome: "pass", verifiedBy: "u-x", recordedBy: "u-x" } };
    expect(state(other, "approve")).toMatchObject({ enabled: true });
    expect(state({ ...other, viewer: viewer({ canApprove: false }) }, "approve")).toMatchObject({ enabled: false, reason: "no_permission" });
  });

  it("switches approve off after a failed identity check, and while dues are outstanding until an override reason is typed", () => {
    const head = viewer({ canApprove: true });
    const a = input({ status: "awaiting_signoff", viewer: head, identity: { outcome: "fail", verifiedBy: "u-x" } });
    expect(state(a, "approve")).toMatchObject({ enabled: false, reason: "identity_not_passed" });
    expect(state(a, "reject")).toMatchObject({ enabled: true });
    const dues = input({ status: "awaiting_signoff", viewer: head, checkDues: true, duesOutstanding: true, identity: { outcome: "pass", verifiedBy: "u-x" } });
    expect(state(dues, "approve")).toMatchObject({ enabled: false, reason: "dues_outstanding" });
    expect(state({ ...dues, hasOverride: true }, "approve")).toMatchObject({ enabled: true });
    expect(state({ ...dues, duesOutstanding: false }, "approve")).toMatchObject({ enabled: true });
  });

  it("does not demand a passed identity check for a type that does not use one", () => {
    const i = input({ status: "awaiting_signoff", viewer: viewer({ canApprove: true }), requiresIdentityCheck: false, identity: { outcome: "not_required" } });
    expect(state(i, "approve")).toMatchObject({ enabled: true });
  });

  it("offers execution to the operations person and completion only when every step is ticked", () => {
    const ops = viewer({ canReview: false, canExecute: true });
    expect(keys(input({ status: "approved", viewer: ops }))).toEqual(["mark_executing"]);
    expect(keys(input({ status: "approved", viewer: ops, checklistTotal: 0 }))).toEqual(["mark_executing", "complete"]);
    expect(state(input({ status: "executing", viewer: ops, checklistTotal: 3, checklistDone: 2 }), "complete")).toMatchObject({ enabled: false, reason: "checklist_incomplete" });
    expect(state(input({ status: "executing", viewer: ops, checklistTotal: 3, checklistDone: 3 }), "complete")).toMatchObject({ enabled: true });
    expect(state(input({ status: "executing", viewer: viewer({ canExecute: false }) }), "complete")).toMatchObject({ enabled: false, reason: "no_permission" });
  });

  it("offers closing a rejected or completed case and nothing on a closed one", () => {
    expect(keys(input({ status: "rejected" }))).toEqual(["close"]);
    expect(keys(input({ status: "completed" }))).toEqual(["close"]);
    expect(keys(input({ status: "closed" }))).toEqual([]);
  });
});

describe("the step bar", () => {
  it("has six steps and puts every status on one", () => {
    expect(STEPS).toHaveLength(6);
    const at = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, stepIndexOf(s)]));
    expect(at).toEqual({ received: 0, identity_check: 1, officer_review: 2, awaiting_signoff: 3, approved: 4, rejected: 3, executing: 4, completed: 4, closed: 5 });
  });
});
