// ============================================================
// The ticket SLA clock as a pure state machine (migration 086).
//
// This is the TypeScript twin of the SQL trigger `ticket_sla_state()` and its
// helpers (sla_t_init / settle / pause / resume / stop / restart / apply /
// rematch) and of `sla_sweep()`. The database is the source of truth for every
// real write; this file exists so the rules can be unit tested with fixed
// numbers (state.test.ts asserts the same scenarios as verify-086) and so the
// UI and reports can talk about the same states.
//
// Clock, by status (active = open, in_progress, pending):
//   create                      match a policy, start from created_at
//   active -> pending           settle, then pause running targets (if the policy pauses)
//   pending -> open/in_progress resume: remaining = business time between paused_at and
//                               due, laid out again from now
//   active -> resolved/closed   stop: running -> met (on time) or breached; paused -> met
//   resolved/closed -> active   a MET resolution restarts from the business time that was
//                               left; a breached one stays breached; first response never
//                               restarts
//   priority/type/labels/team/conversation change while active
//                               re-match; the new policy keeps the elapsed business time
//   first response recorded     the first-response target settles: met / breached
//
// A target is breached strictly AFTER its due time (an answer at exactly the
// due instant is on time). Paused targets are not settled: their clock is
// stopped.
// ============================================================

import type { TicketStatus } from "@/types";
import {
  addBusinessSeconds,
  businessSecondsBetween,
  type BusinessSchedule,
} from "./business-time";
import type { SlaTarget, SlaTargetState } from "./types";

/** Times are epoch milliseconds (null = not set). */
export interface SlaClock {
  status: TicketStatus;
  createdAt: number;
  closedAt?: number | null;
  resolvedAt?: number | null;
  policyId: string | null;
  frDueAt: number | null;
  frRiskAt: number | null;
  /** When the first response actually happened. */
  frAt: number | null;
  frState: SlaTargetState;
  resDueAt: number | null;
  resRiskAt: number | null;
  resState: SlaTargetState;
  pausedAt: number | null;
  stoppedAt: number | null;
  frRiskNotified: boolean;
  frBreachNotified: boolean;
  resRiskNotified: boolean;
  resBreachNotified: boolean;
}

/** What the clock needs to know about a policy. */
export interface ClockPolicy {
  id: string;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  at_risk_percent: number;
  pause_while_pending: boolean;
  /** null = 24/7. */
  schedule: BusinessSchedule | null;
}

export function newClock(init: Pick<SlaClock, "status" | "createdAt"> & Partial<SlaClock>): SlaClock {
  return {
    closedAt: null,
    resolvedAt: null,
    policyId: null,
    frDueAt: null,
    frRiskAt: null,
    frAt: null,
    frState: "none",
    resDueAt: null,
    resRiskAt: null,
    resState: "none",
    pausedAt: null,
    stoppedAt: null,
    frRiskNotified: false,
    frBreachNotified: false,
    resRiskNotified: false,
    resBreachNotified: false,
    ...init,
  };
}

export const isActiveStatus = (s: TicketStatus) => s === "open" || s === "in_progress" || s === "pending";

const dueOf = (sch: BusinessSchedule | null, from: number, minutes: number | null): number | null =>
  minutes === null ? null : addBusinessSeconds(sch, from, minutes * 60);

const riskOf = (sch: BusinessSchedule | null, from: number, minutes: number | null, pct: number): number | null =>
  minutes === null ? null : addBusinessSeconds(sch, from, Math.floor((minutes * 60 * pct) / 100));

const secondsBetween = (sch: BusinessSchedule | null, from: number, to: number): number =>
  businessSecondsBetween(sch, from, to) ?? 0;

// ---- The steps ---------------------------------------------------------------------

/** Start from created_at under a policy (does not settle, pause or stop). */
export function initClock(t: SlaClock, pol: ClockPolicy): SlaClock {
  const c = { ...t, policyId: pol.id, pausedAt: null, stoppedAt: null };
  if (pol.first_response_minutes === null) {
    c.frDueAt = null;
    c.frRiskAt = null;
    c.frState = "none";
  } else {
    c.frDueAt = dueOf(pol.schedule, c.createdAt, pol.first_response_minutes);
    c.frRiskAt = riskOf(pol.schedule, c.createdAt, pol.first_response_minutes, pol.at_risk_percent);
    if (c.frDueAt === null) c.frState = "none";
    else if (c.frAt !== null) c.frState = c.frAt <= c.frDueAt ? "met" : "breached";
    else c.frState = "running";
  }
  if (pol.resolution_minutes === null) {
    c.resDueAt = null;
    c.resRiskAt = null;
    c.resState = "none";
  } else {
    c.resDueAt = dueOf(pol.schedule, c.createdAt, pol.resolution_minutes);
    c.resRiskAt = riskOf(pol.schedule, c.createdAt, pol.resolution_minutes, pol.at_risk_percent);
    c.resState = c.resDueAt === null ? "none" : "running";
  }
  return c;
}

export function settle(t: SlaClock, now: number): SlaClock {
  const c = { ...t };
  if (c.frState === "running" && c.frDueAt !== null && now > c.frDueAt) c.frState = "breached";
  if (c.resState === "running" && c.resDueAt !== null && now > c.resDueAt) c.resState = "breached";
  return c;
}

export function pause(t: SlaClock, now: number): SlaClock {
  const c = settle(t, now);
  if (c.frState === "running") c.frState = "paused";
  if (c.resState === "running") c.resState = "paused";
  if (c.frState === "paused" || c.resState === "paused") c.pausedAt = now;
  return c;
}

export function resume(t: SlaClock, pol: ClockPolicy, now: number): SlaClock {
  if (t.pausedAt === null) return t;
  const c = { ...t };
  const paused = t.pausedAt;
  const shift = (due: number | null, risk: number | null) => {
    const rem = due === null ? 0 : secondsBetween(pol.schedule, paused, due);
    const newDue = addBusinessSeconds(pol.schedule, now, rem);
    const newRisk =
      risk !== null && risk > paused
        ? addBusinessSeconds(pol.schedule, now, secondsBetween(pol.schedule, paused, risk))
        : risk;
    return { newDue, newRisk };
  };
  if (c.frState === "paused") {
    const r = shift(c.frDueAt, c.frRiskAt);
    c.frDueAt = r.newDue;
    c.frRiskAt = r.newRisk;
    c.frState = r.newDue === null ? "none" : "running";
  }
  if (c.resState === "paused") {
    const r = shift(c.resDueAt, c.resRiskAt);
    c.resDueAt = r.newDue;
    c.resRiskAt = r.newRisk;
    c.resState = r.newDue === null ? "none" : "running";
  }
  c.pausedAt = null;
  return settle(c, now);
}

export function stop(t: SlaClock, now: number): SlaClock {
  const c = { ...t };
  if (c.frState === "running") c.frState = c.frDueAt === null || now <= c.frDueAt ? "met" : "breached";
  else if (c.frState === "paused") c.frState = "met";
  if (c.resState === "running") c.resState = c.resDueAt === null || now <= c.resDueAt ? "met" : "breached";
  else if (c.resState === "paused") c.resState = "met";
  c.pausedAt = null;
  c.stoppedAt = now;
  return c;
}

export function restart(t: SlaClock, pol: ClockPolicy, now: number): SlaClock {
  const c = { ...t };
  if (c.resState === "met" && c.resDueAt !== null && c.stoppedAt !== null) {
    const stopped = c.stoppedAt;
    if (c.resRiskAt !== null && c.resRiskAt > stopped) {
      c.resRiskAt = addBusinessSeconds(pol.schedule, now, secondsBetween(pol.schedule, stopped, c.resRiskAt));
    }
    c.resDueAt = addBusinessSeconds(pol.schedule, now, secondsBetween(pol.schedule, stopped, c.resDueAt));
    c.resState = c.resDueAt === null ? "none" : "running";
  }
  c.stoppedAt = null;
  return c;
}

/** Start under a policy for the ticket's CURRENT status. */
export function applyPolicy(t: SlaClock, pol: ClockPolicy, now: number): SlaClock {
  const c = settle(initClock(t, pol), now);
  if (c.status === "resolved" || c.status === "closed") {
    return stop(c, c.closedAt ?? c.resolvedAt ?? now);
  }
  if (c.status === "pending" && pol.pause_while_pending) return pause(c, now);
  return c;
}

/**
 * The policy changed under an ACTIVE ticket (`next` is the policy that matches
 * now, null for none). Keeps the elapsed business time; see the file header.
 */
export function rematch(
  t: SlaClock,
  next: ClockPolicy | null,
  prev: ClockPolicy | null,
  now: number,
): SlaClock {
  if ((next?.id ?? null) === t.policyId) return t;
  const c = { ...t };

  if (next === null) {
    if (c.frState === "running" || c.frState === "paused") {
      c.frState = "none";
      c.frDueAt = null;
      c.frRiskAt = null;
    }
    if (c.resState === "running" || c.resState === "paused") {
      c.resState = "none";
      c.resDueAt = null;
      c.resRiskAt = null;
    }
    c.policyId = null;
    c.pausedAt = null;
    return c;
  }
  if (c.policyId === null) return applyPolicy(c, next, now);

  const ref = c.pausedAt ?? now;
  const retarget = (
    state: SlaTargetState,
    due: number | null,
    oldMinutes: number | null | undefined,
    newMinutes: number | null,
  ): { state: SlaTargetState; due: number | null; risk: number | null; touched: boolean } => {
    if (state === "running" || state === "paused") {
      if (newMinutes === null) return { state: "none", due: null, risk: null, touched: true };
      const tsec = newMinutes * 60;
      const elapsed =
        prev && oldMinutes != null && due !== null
          ? Math.max(0, oldMinutes * 60 - secondsBetween(prev.schedule, ref, due))
          : secondsBetween(next.schedule, c.createdAt, ref);
      const newDue = addBusinessSeconds(next.schedule, ref, Math.max(tsec - elapsed, 0));
      const newRisk = addBusinessSeconds(
        next.schedule,
        ref,
        Math.max(Math.floor((tsec * next.at_risk_percent) / 100) - elapsed, 0),
      );
      return { state: newDue === null ? "none" : state, due: newDue, risk: newRisk, touched: true };
    }
    return { state, due, risk: null, touched: false };
  };

  const fr = retarget(c.frState, c.frDueAt, prev?.first_response_minutes, next.first_response_minutes);
  if (fr.touched) {
    c.frState = fr.state;
    c.frDueAt = fr.due;
    c.frRiskAt = fr.risk;
  } else if (c.frState === "none" && next.first_response_minutes !== null) {
    c.frDueAt = dueOf(next.schedule, c.createdAt, next.first_response_minutes);
    c.frRiskAt = riskOf(next.schedule, c.createdAt, next.first_response_minutes, next.at_risk_percent);
    c.frState =
      c.frDueAt === null
        ? "none"
        : c.frAt !== null
          ? c.frAt <= c.frDueAt
            ? "met"
            : "breached"
          : c.pausedAt !== null
            ? "paused"
            : "running";
  }
  const res = retarget(c.resState, c.resDueAt, prev?.resolution_minutes, next.resolution_minutes);
  if (res.touched) {
    c.resState = res.state;
    c.resDueAt = res.due;
    c.resRiskAt = res.risk;
  } else if (c.resState === "none" && next.resolution_minutes !== null) {
    c.resDueAt = dueOf(next.schedule, c.createdAt, next.resolution_minutes);
    c.resRiskAt = riskOf(next.schedule, c.createdAt, next.resolution_minutes, next.at_risk_percent);
    c.resState = c.resDueAt === null ? "none" : c.pausedAt !== null ? "paused" : "running";
  }

  c.policyId = next.id;
  if (c.pausedAt !== null && c.frState !== "paused" && c.resState !== "paused") c.pausedAt = null;
  return settle(c, now);
}

// ---- One write, the way the trigger sees it ------------------------------------------------

export interface WriteContext {
  now: number;
  /** The policy that matches the row as it is AFTER the write (null for none). */
  matched: ClockPolicy | null;
  /** Look a policy up by id (the current one, or the one being left). */
  policyById: (id: string | null) => ClockPolicy | null;
  /** True when priority / type / labels / team / conversation changed. */
  attributesChanged: boolean;
}

/** A new ticket. */
export function onCreate(row: SlaClock, ctx: Pick<WriteContext, "now" | "matched">): SlaClock {
  if (!ctx.matched) return row;
  return applyPolicy(row, ctx.matched, ctx.now);
}

/** A status change and/or an attribute change on an existing ticket. */
export function onUpdate(prev: SlaClock, next: SlaClock, ctx: WriteContext): SlaClock {
  let c = { ...next };
  const wasActive = isActiveStatus(prev.status);
  const isActive = isActiveStatus(c.status);
  const pol = ctx.policyById(c.policyId);

  if (c.status !== prev.status && pol) {
    if (!wasActive && isActive) {
      c = restart(c, pol, ctx.now);
      if (c.status === "pending" && pol.pause_while_pending) c = pause(c, ctx.now);
    } else if (wasActive && !isActive) {
      c = stop(c, ctx.now);
    } else if (c.status === "pending" && prev.status !== "pending" && pol.pause_while_pending) {
      c = pause(c, ctx.now);
    } else if (prev.status === "pending" && c.status !== "pending") {
      c = resume(c, pol, ctx.now);
    }
  }

  if (isActive && ctx.attributesChanged) {
    c = rematch(c, ctx.matched, ctx.policyById(c.policyId), ctx.now);
  }
  return c;
}

/** The first response was recorded at `at` (only the first one counts). */
export function onFirstResponse(t: SlaClock, at: number): SlaClock {
  if (t.frAt !== null) return t;
  const c = { ...t, frAt: at };
  if (c.frState === "paused") c.frState = "met";
  else if (c.frState === "running") c.frState = c.frDueAt === null || at <= c.frDueAt ? "met" : "breached";
  return c;
}

// ---- The sweep -----------------------------------------------------------------------------

export interface SlaNotice {
  target: SlaTarget;
  kind: "at_risk" | "breached";
}

/**
 * What `sla_sweep()` does to one active ticket: running targets past due
 * become breached, then each (target, kind) is announced ONCE (the notified
 * flag is set in the same step). A breach also settles the at-risk notice, so
 * nobody is told "at risk" after "breached". Paused targets are left alone.
 */
export function sweepTicket(t: SlaClock, now: number): { clock: SlaClock; notices: SlaNotice[] } {
  if (!isActiveStatus(t.status)) return { clock: t, notices: [] };
  const c = { ...t };
  if (c.frState === "running" && c.frDueAt !== null && c.frDueAt < now) c.frState = "breached";
  if (c.resState === "running" && c.resDueAt !== null && c.resDueAt < now) c.resState = "breached";
  const notices: SlaNotice[] = [];

  if (c.frState === "breached" && !c.frBreachNotified) {
    notices.push({ target: "first_response", kind: "breached" });
    c.frBreachNotified = true;
    c.frRiskNotified = true;
  } else if (c.frState === "running" && c.frRiskAt !== null && c.frRiskAt <= now && !c.frRiskNotified) {
    notices.push({ target: "first_response", kind: "at_risk" });
    c.frRiskNotified = true;
  }
  if (c.resState === "breached" && !c.resBreachNotified) {
    notices.push({ target: "resolution", kind: "breached" });
    c.resBreachNotified = true;
    c.resRiskNotified = true;
  } else if (c.resState === "running" && c.resRiskAt !== null && c.resRiskAt <= now && !c.resRiskNotified) {
    notices.push({ target: "resolution", kind: "at_risk" });
    c.resRiskNotified = true;
  }
  return { clock: c, notices };
}

/** Who hears about it: the assignee, or every owner/admin when unassigned, plus watchers. */
export function noticeRecipients(input: {
  assigneeId: string | null;
  ownersAndAdmins: readonly string[];
  watchers: readonly string[];
  members: ReadonlySet<string>;
}): string[] {
  const set = new Set<string>();
  if (input.assigneeId) set.add(input.assigneeId);
  else for (const u of input.ownersAndAdmins) set.add(u);
  for (const u of input.watchers) set.add(u);
  return [...set].filter((u) => input.members.has(u));
}
