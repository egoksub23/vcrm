// Moves between statuses and what must be true first. The statuses themselves are unchanged (reported, triaged, contained, investigating, recovered,
// closed): a school adds requirements to a move ("a root cause written", "all required steps done", "the Principal approves") and may forbid moving back.
// Pure: the route gathers the facts, this decides. No requirements set means no change from how it always worked.

import { INCIDENT_STATUSES } from "@/lib/incidents/constants";

export interface Requires {
  root_cause?: boolean;
  steps_done?: boolean;
  lead_assigned?: boolean;
  /** A note of kind "closing" is written (the closing note). */
  closing_note?: boolean;
  /** The incident role that must approve before the move, for example "principal". */
  approval_role?: string | null;
}

export interface Guard {
  to_status: string;
  requires: Requires;
}

export interface MoveFacts {
  from: string;
  to: string;
  rootCause: string | null;
  leadAssigned: boolean;
  /** A closing note has been written. */
  hasClosingNote?: boolean;
  openSteps: number;
  /** Decisions on this incident, newest first. */
  approvals: { role_key: string; decision: "approved" | "rejected" | null }[];
}

export type MoveResult = { ok: true; needsApprovalFrom: null } | { ok: false; problems: string[]; needsApprovalFrom: string | null };

export function statusIndex(status: string): number {
  return INCIDENT_STATUSES.indexOf(status as (typeof INCIDENT_STATUSES)[number]);
}

/** Can the incident make this move? Lists every reason it cannot, in plain words, so the person fixes them all at once. */
export function evaluateMove(args: { facts: MoveFacts; guards: readonly Guard[]; allowBackward: boolean; roleName: (key: string) => string; statusName: (s: string) => string }): MoveResult {
  const { facts, guards, allowBackward, roleName, statusName } = args;
  if (facts.from === facts.to) return { ok: true, needsApprovalFrom: null };
  const problems: string[] = [];
  let needsApprovalFrom: string | null = null;

  const fromIdx = statusIndex(facts.from);
  const toIdx = statusIndex(facts.to);
  if (!allowBackward && fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) {
    problems.push(`This school does not allow an incident to move back from ${statusName(facts.from)} to ${statusName(facts.to)}.`);
  }

  const req = guards.find((g) => g.to_status === facts.to)?.requires ?? {};
  if (req.root_cause && !(facts.rootCause ?? "").trim()) problems.push("Write the root cause first.");
  if (req.lead_assigned && !facts.leadAssigned) problems.push("Assign an incident lead first.");
  if (req.closing_note && !facts.hasClosingNote) problems.push("Write the closing note first.");
  if (req.steps_done && facts.openSteps > 0) problems.push(`${facts.openSteps === 1 ? "1 required step is" : `${facts.openSteps} required steps are`} still open.`);
  if (req.approval_role) {
    const mine = facts.approvals.filter((a) => a.role_key === req.approval_role);
    const latest = mine[0];
    if (latest?.decision === "approved") {
      // approved: nothing to ask
    } else if (latest?.decision === "rejected") {
      problems.push(`${roleName(req.approval_role)} did not approve. Deal with their reason, then ask again.`);
      needsApprovalFrom = req.approval_role;
    } else {
      problems.push(latest ? `${roleName(req.approval_role)} has been asked and has not answered yet.` : `${roleName(req.approval_role)} must approve first. They are being asked now.`);
      needsApprovalFrom = req.approval_role;
    }
  }
  return problems.length === 0 ? { ok: true, needsApprovalFrom: null } : { ok: false, problems, needsApprovalFrom };
}

/** The requirement sets a school can switch on, as the screen lists them. */
export const REQUIREMENT_KEYS = ["root_cause", "steps_done", "lead_assigned", "closing_note"] as const;

export function parseGuards(body: unknown, knownRoles: readonly string[]): { ok: true; guards: Guard[]; allowBackward: boolean | null } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the requirements." };
  const b = body as { guards?: unknown; allow_backward?: unknown };
  if (b.allow_backward !== undefined && typeof b.allow_backward !== "boolean") return { ok: false, error: "allow_backward must be true or false." };
  if (!Array.isArray(b.guards)) return { ok: false, error: "guards must be a list." };
  const out: Guard[] = [];
  for (const raw of b.guards) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "Each requirement needs a status." };
    const g = raw as { to_status?: unknown; requires?: unknown };
    if (typeof g.to_status !== "string" || statusIndex(g.to_status) < 1) return { ok: false, error: "Requirements apply to triaged, contained, investigating, recovered or closed." };
    const r = (typeof g.requires === "object" && g.requires !== null ? g.requires : {}) as Record<string, unknown>;
    const requires: Requires = {};
    for (const k of REQUIREMENT_KEYS) if (r[k] === true) requires[k] = true;
    if (r.approval_role !== undefined && r.approval_role !== null && r.approval_role !== "") {
      if (typeof r.approval_role !== "string" || !knownRoles.includes(r.approval_role)) return { ok: false, error: `There is no role "${String(r.approval_role)}".` };
      requires.approval_role = r.approval_role;
    }
    if (Object.keys(requires).length > 0) out.push({ to_status: g.to_status, requires });
  }
  return { ok: true, guards: out, allowBackward: typeof b.allow_backward === "boolean" ? b.allow_backward : null };
}
