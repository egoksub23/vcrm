// ============================================================
// Compliance requests: the state machine, in one place. Pure (no I/O, no Node imports).
//
// The DATABASE is the authority: compliance_transition() (migration 183) holds the same table and refuses everything else. This module is its twin for
// the routes (to answer early, with a clear code) and for the screens (to show only what can happen and why a button is disabled). A test reads the
// migration and checks the two tables agree.
// ============================================================

import type { RequestStatus, Viewer } from "./types";

export const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  received: ["identity_check", "officer_review", "closed"],
  identity_check: ["officer_review", "closed"],
  officer_review: ["awaiting_signoff", "identity_check", "closed"],
  awaiting_signoff: ["approved", "rejected", "officer_review"],
  approved: ["executing", "completed"],
  rejected: ["closed"],
  executing: ["completed"],
  completed: ["closed"],
  closed: [],
};

export function canMove(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The capability a move needs. "review" means compliance.review OR compliance.approve (the Head may also act as officer). */
export type MoveCapability = "review" | "approve" | "execute";

export function capabilityForMove(from: RequestStatus, to: RequestStatus): MoveCapability {
  if (to === "approved" || to === "rejected") return "approve";
  if (from === "awaiting_signoff" && to === "officer_review") return "approve";
  if (to === "executing" || to === "completed") return "execute";
  return "review";
}

export function viewerMayMove(v: Pick<Viewer, "canReview" | "canApprove" | "canExecute">, from: RequestStatus, to: RequestStatus): boolean {
  switch (capabilityForMove(from, to)) {
    case "approve":
      return v.canApprove;
    case "execute":
      return v.canExecute;
    default:
      return v.canReview || v.canApprove;
  }
}

/**
 * Maker-checker: may this person sign the case off, given who recorded its identity check? The person who recorded it (verified_by or recorded_by)
 * may not. A case with no identity check recorded (a type that does not need one) has no maker, so anyone with the permission may.
 */
export function makerCheckerAllows(identity: { verifiedBy?: string | null; recordedBy?: string | null }, actorId: string): boolean {
  return identity.verifiedBy !== actorId && identity.recordedBy !== actorId;
}

/** Statuses in which the answers (and the customer's details, the request date) can still be edited; links and the assignee until closed. */
export const DATA_EDITABLE: readonly RequestStatus[] = ["received", "identity_check", "officer_review"];
export const isDataEditable = (s: RequestStatus): boolean => DATA_EDITABLE.includes(s);

// ---- what the screen offers ---------------------------------------------------------------------------------------

export type ActionKey =
  | "start_identity_check"
  | "record_identity_check"
  | "send_back_to_identity_check"
  | "submit_review"
  | "approve"
  | "reject"
  | "send_back_to_officer"
  | "mark_executing"
  | "complete"
  | "close"
  | "close_without_decision";

/** Why an action that exists is switched off (the screen words each). */
export type DisabledReason =
  | "no_permission"
  | "maker_checker"
  | "identity_not_passed"
  | "dues_outstanding"
  | "checklist_incomplete"
  | "no_recommendation";

export interface ActionState {
  key: ActionKey;
  to: RequestStatus;
  enabled: boolean;
  reason?: DisabledReason;
}

export interface ActionInput {
  status: RequestStatus;
  viewer: Viewer;
  requiresIdentityCheck: boolean;
  checkDues: boolean;
  identity: { outcome?: string | null; verifiedBy?: string | null; recordedBy?: string | null };
  /** Dues outstanding as recorded: true / false / null (not recorded). */
  duesOutstanding: boolean | null;
  /** Whether the Head has typed an override reason for outstanding dues (the screen's field); the database re-checks. */
  hasOverride?: boolean;
  recommendation?: string | null;
  checklistTotal: number;
  checklistDone: number;
}

function action(key: ActionKey, to: RequestStatus, v: ActionInput, extra?: DisabledReason | null): ActionState {
  const permitted = viewerMayMove(v.viewer, v.status, to);
  if (!permitted) return { key, to, enabled: false, reason: "no_permission" };
  if (extra) return { key, to, enabled: false, reason: extra };
  return { key, to, enabled: true };
}

/** The actions open on a case in its current status, each with whether the viewer may do it now and, if not, why. */
export function actionsFor(v: ActionInput): ActionState[] {
  const out: ActionState[] = [];
  const makerBlocked = !makerCheckerAllows({ verifiedBy: v.identity.verifiedBy, recordedBy: v.identity.recordedBy }, v.viewer.userId);
  switch (v.status) {
    case "received":
      out.push(action("start_identity_check", "identity_check", v));
      out.push(action("record_identity_check", "officer_review", v));
      out.push(action("close_without_decision", "closed", v));
      break;
    case "identity_check":
      out.push(action("record_identity_check", "officer_review", v));
      out.push(action("close_without_decision", "closed", v));
      break;
    case "officer_review":
      out.push(action("submit_review", "awaiting_signoff", v));
      out.push(action("send_back_to_identity_check", "identity_check", v));
      out.push(action("close_without_decision", "closed", v));
      break;
    case "awaiting_signoff": {
      const identityBad = v.requiresIdentityCheck && v.identity.outcome !== "pass";
      out.push(action("approve", "approved", v, makerBlocked ? "maker_checker" : identityBad ? "identity_not_passed" : v.checkDues && v.duesOutstanding === true && !v.hasOverride ? "dues_outstanding" : null));
      out.push(action("reject", "rejected", v, makerBlocked ? "maker_checker" : null));
      out.push(action("send_back_to_officer", "officer_review", v));
      break;
    }
    case "approved":
      out.push(action("mark_executing", "executing", v));
      if (v.checklistTotal === 0) out.push(action("complete", "completed", v));
      break;
    case "executing":
      out.push(action("complete", "completed", v, v.checklistDone < v.checklistTotal ? "checklist_incomplete" : null));
      break;
    case "rejected":
    case "completed":
      out.push(action("close", "closed", v));
      break;
    default:
      break;
  }
  return out;
}

/** The six steps of the step bar, in order, and where a status sits on it (0 based). */
export const STEPS = ["received", "identity_check", "officer_review", "signoff", "execution", "closed"] as const;
export type StepKey = (typeof STEPS)[number];

export function stepIndexOf(status: RequestStatus): number {
  switch (status) {
    case "received":
      return 0;
    case "identity_check":
      return 1;
    case "officer_review":
      return 2;
    case "awaiting_signoff":
    case "rejected":
      return 3;
    case "approved":
    case "executing":
    case "completed":
      return 4;
    case "closed":
      return 5;
  }
}
