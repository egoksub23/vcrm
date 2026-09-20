import { describe, expect, it } from "vitest";

import { FIXTURE_SCHEDULES } from "./business-time.fixtures";
import {
  applyPolicy,
  newClock,
  noticeRecipients,
  onCreate,
  onFirstResponse,
  onUpdate,
  pause,
  rematch,
  restart,
  resume,
  settle,
  stop,
  sweepTicket,
  type ClockPolicy,
  type SlaClock,
} from "./state";

// The same scenarios, with the same numbers, as supabase/ci/verify-086-ticket-sla.sql.

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

const urgent: ClockPolicy = {
  id: "p-urgent",
  first_response_minutes: 30,
  resolution_minutes: 240,
  at_risk_percent: 80,
  pause_while_pending: true,
  schedule: null,
};
const catchAll: ClockPolicy = {
  id: "p-all",
  first_response_minutes: 120,
  resolution_minutes: 1440,
  at_risk_percent: 80,
  pause_while_pending: true,
  schedule: null,
};
const billingNy: ClockPolicy = {
  id: "p-bill",
  first_response_minutes: 60,
  resolution_minutes: 480,
  at_risk_percent: 80,
  pause_while_pending: true,
  schedule: FIXTURE_SCHEDULES.NY,
};

const byId = (...ps: ClockPolicy[]) => (id: string | null) => ps.find((p) => p.id === id) ?? null;

const started = (status: SlaClock["status"] = "open", createdAt = NOW, pol = urgent) =>
  onCreate(newClock({ status, createdAt }), { now: NOW, matched: pol });

const st = (c: SlaClock) => `${c.frState}/${c.resState}/${c.pausedAt !== null}`;

/** Pretend `minutes` have passed since the columns were written. */
function shift(c: SlaClock, minutes: number): SlaClock {
  const d = minutes * MIN;
  const back = (v: number | null) => (v === null ? null : v - d);
  return {
    ...c,
    pausedAt: back(c.pausedAt),
    stoppedAt: back(c.stoppedAt),
    frDueAt: back(c.frDueAt),
    frRiskAt: back(c.frRiskAt),
    resDueAt: back(c.resDueAt),
    resRiskAt: back(c.resRiskAt),
  };
}

const statusChange = (prev: SlaClock, status: SlaClock["status"], pols = [urgent]) =>
  onUpdate(prev, { ...prev, status }, {
    now: NOW,
    matched: null,
    policyById: byId(...pols),
    attributesChanged: false,
  });

describe("start", () => {
  it("24/7: due = created + target, at risk at 80 %", () => {
    const c = started();
    expect(c.policyId).toBe("p-urgent");
    expect(c.frDueAt).toBe(NOW + 30 * MIN);
    expect(c.frRiskAt).toBe(NOW + 24 * MIN);
    expect(c.resDueAt).toBe(NOW + 240 * MIN);
    expect(c.resRiskAt).toBe(NOW + 192 * MIN);
    expect(st(c)).toBe("running/running/false");
  });

  it("business hours: Monday 17:30 New York + 60 / 480 business minutes, computed from created_at", () => {
    const created = Date.parse("2026-09-14T21:30:00Z");
    const c = onCreate(newClock({ status: "open", createdAt: created }), { now: created, matched: billingNy });
    expect(new Date(c.frDueAt!).toISOString()).toBe("2026-09-15T13:30:00.000Z");
    expect(new Date(c.resDueAt!).toISOString()).toBe("2026-09-15T20:30:00.000Z");
    expect(c.frState).toBe("running");
  });

  it("an old ticket started later is breached straight away", () => {
    const c = started("open", NOW - 5 * 60 * MIN);
    expect(st(c)).toBe("breached/breached/false");
  });

  it("no policy: no SLA", () => {
    const c = onCreate(newClock({ status: "open", createdAt: NOW }), { now: NOW, matched: null });
    expect(st(c)).toBe("none/none/false");
    expect(c.policyId).toBeNull();
  });

  it("a policy with only a resolution target has no first-response clock", () => {
    const c = started("open", NOW, { ...urgent, first_response_minutes: null });
    expect(c.frState).toBe("none");
    expect(c.frDueAt).toBeNull();
    expect(c.resState).toBe("running");
  });

  it("a first response that already happened settles that target at creation", () => {
    const early = applyPolicy(newClock({ status: "open", createdAt: NOW, frAt: NOW + 10 * MIN }), urgent, NOW);
    expect(early.frState).toBe("met");
    const late = applyPolicy(newClock({ status: "open", createdAt: NOW, frAt: NOW + 45 * MIN }), urgent, NOW + 50 * MIN);
    expect(late.frState).toBe("breached");
  });

  it("created straight into pending / resolved", () => {
    expect(st(applyPolicy(newClock({ status: "pending", createdAt: NOW }), urgent, NOW))).toBe("paused/paused/true");
    expect(st(applyPolicy(newClock({ status: "resolved", createdAt: NOW, resolvedAt: NOW }), urgent, NOW))).toBe(
      "met/met/false",
    );
  });
});

describe("pause and resume", () => {
  it("pending pauses; leaving pending gives back the remaining time", () => {
    const paused = statusChange(started("in_progress"), "pending");
    expect(st(paused)).toBe("paused/paused/true");
    const aged = shift(paused, 10); // pending for 10 minutes
    const back = onUpdate(aged, { ...aged, status: "in_progress" }, {
      now: NOW,
      matched: null,
      policyById: byId(urgent),
      attributesChanged: false,
    });
    expect(st(back)).toBe("running/running/false");
    expect(back.frDueAt).toBe(NOW + 30 * MIN);
    expect(back.frRiskAt).toBe(NOW + 24 * MIN);
    expect(back.resDueAt).toBe(NOW + 240 * MIN);
  });

  it("a policy that does not pause keeps running while pending", () => {
    const noPause = { ...urgent, pause_while_pending: false };
    const c = statusChange(started("open", NOW, noPause), "pending", [noPause]);
    expect(st(c)).toBe("running/running/false");
  });

  it("a target already late when it pauses stays breached", () => {
    const late = shift(started("open"), 60); // 60 minutes ago: first response is 30 minutes overdue
    const c = pause(late, NOW);
    expect(c.frState).toBe("breached");
    expect(c.resState).toBe("paused");
  });

  it("pause is skipped for a met first response", () => {
    const c = pause(onFirstResponse(started(), NOW + MIN), NOW);
    expect(st(c)).toBe("met/paused/true");
  });

  it("resume keeps business time: paused over a weekend, still the same business minutes left", () => {
    // Friday 15:00 New York (19:00Z), 60 business-minute first response: due 16:00 Friday
    const created = Date.parse("2026-09-11T19:00:00Z");
    const c0 = onCreate(newClock({ status: "open", createdAt: created }), {
      now: created,
      matched: { ...billingNy, first_response_minutes: 60, resolution_minutes: 480 },
    });
    // it goes pending at Friday 15:30 (30 minutes left) ...
    const pausedAt = Date.parse("2026-09-11T19:30:00Z");
    const p = pause(c0, pausedAt);
    // ... and comes back on Tuesday 10:00 (Monday 09-14 is a normal day, 09-07 is the holiday)
    const backAt = Date.parse("2026-09-15T14:00:00Z");
    const r = resume(p, { ...billingNy }, backAt);
    // 30 business minutes left -> Tuesday 10:30 EDT = 14:30Z
    expect(new Date(r.frDueAt!).toISOString()).toBe("2026-09-15T14:30:00.000Z");
    expect(r.frState).toBe("running");
  });
});

describe("stop and reopen", () => {
  it("pending -> resolved counts as met", () => {
    const c = statusChange(statusChange(started(), "pending"), "resolved");
    expect(st(c)).toBe("met/met/false");
    expect(c.stoppedAt).toBe(NOW);
  });

  it("resolved late is breached, and reopening does not un-breach it", () => {
    const old = started("open", NOW - 5 * 60 * MIN);
    const resolved = statusChange(old, "resolved");
    expect(st(resolved)).toBe("breached/breached/false");
    const reopened = statusChange(resolved, "open");
    expect(st(reopened)).toBe("breached/breached/false");
    expect(reopened.stoppedAt).toBeNull();
  });

  it("resolved on time is met; closing afterwards changes nothing", () => {
    const resolved = statusChange(started(), "resolved");
    expect(st(resolved)).toBe("met/met/false");
    expect(st(statusChange(resolved, "closed"))).toBe("met/met/false");
  });

  it("reopen restarts a met resolution from what was left; first response stays met", () => {
    const closed = statusChange(statusChange(started(), "resolved"), "closed");
    const aged = shift(closed, 5);
    const open = onUpdate(aged, { ...aged, status: "open" }, {
      now: NOW,
      matched: null,
      policyById: byId(urgent),
      attributesChanged: false,
    });
    expect(open.frState).toBe("met");
    expect(open.resState).toBe("running");
    expect(open.resDueAt).toBe(NOW + 240 * MIN);
    expect(open.stoppedAt).toBeNull();
  });

  it("reopening straight into pending pauses at once", () => {
    const resolved = statusChange(started(), "resolved");
    const c = statusChange(resolved, "pending");
    expect(st(c)).toBe("met/paused/true");
  });

  it("stop / restart are exported building blocks", () => {
    const s = stop(started(), NOW);
    expect(st(s)).toBe("met/met/false");
    expect(st(restart(s, urgent, NOW))).toBe("met/running/false");
    expect(settle(started("open", NOW - 999 * MIN), NOW).resState).toBe("breached");
  });
});

describe("re-match keeps the elapsed business time", () => {
  const twentyAgo = NOW - 20 * MIN;
  const base = () => started("open", twentyAgo, catchAll);
  const attr = (c: SlaClock, next: ClockPolicy | null, pols: ClockPolicy[]) =>
    onUpdate(c, { ...c }, { now: NOW, matched: next, policyById: byId(...pols), attributesChanged: true });

  it("normal -> urgent: 30 - 20 elapsed = 10 minutes left (and 220 for the resolution)", () => {
    const c = attr(base(), urgent, [catchAll, urgent]);
    expect(c.policyId).toBe("p-urgent");
    expect(c.frDueAt).toBe(NOW + 10 * MIN);
    expect(c.frRiskAt).toBe(NOW + 4 * MIN);
    expect(c.resDueAt).toBe(NOW + 220 * MIN);
    expect(st(c)).toBe("running/running/false");
  });

  it("back to the longer target: elapsed is still 20", () => {
    const toUrgent = attr(base(), urgent, [catchAll, urgent]);
    const back = attr(toUrgent, catchAll, [catchAll, urgent]);
    expect(back.frDueAt).toBe(NOW + 100 * MIN);
    expect(back.resDueAt).toBe(NOW + 1420 * MIN);
  });

  it("the same policy again changes nothing", () => {
    const c = base();
    expect(attr(c, catchAll, [catchAll])).toEqual(c);
  });

  it("no policy matches any more: running targets end, finished ones stay", () => {
    const met = onFirstResponse(base(), NOW - 5 * MIN);
    const c = attr(met, null, [catchAll]);
    expect(c.policyId).toBeNull();
    expect(c.frState).toBe("met");
    expect(c.resState).toBe("none");
    expect(c.resDueAt).toBeNull();
  });

  it("a policy matching again restarts from created_at", () => {
    const none = attr(base(), null, [catchAll]);
    const back = attr(none, catchAll, [catchAll]);
    expect(back.frDueAt).toBe(twentyAgo + 120 * MIN);
    expect(back.policyId).toBe("p-all");
  });

  it("a stopped ticket is never re-matched", () => {
    const done = statusChange(base(), "resolved", [catchAll]);
    const c = onUpdate(done, { ...done }, {
      now: NOW,
      matched: urgent,
      policyById: byId(catchAll, urgent),
      attributesChanged: true,
    });
    expect(c.policyId).toBe("p-all");
  });

  it("while paused it measures from paused_at", () => {
    const paused = pause(base(), NOW);
    const c = rematch(paused, urgent, catchAll, NOW);
    expect(st(c)).toBe("paused/paused/true");
    expect(c.frDueAt).toBe(NOW + 10 * MIN);
  });

  it("a target the old policy lacked starts from created_at", () => {
    const onlyRes: ClockPolicy = { ...catchAll, id: "p-res", first_response_minutes: null };
    const c = rematch(started("open", twentyAgo, onlyRes), urgent, onlyRes, NOW);
    expect(c.frState).toBe("running");
    expect(c.frDueAt).toBe(twentyAgo + 30 * MIN);
  });
});

describe("first response", () => {
  it("only the first one counts", () => {
    const c = onFirstResponse(started(), NOW + 5 * MIN);
    expect(c.frAt).toBe(NOW + 5 * MIN);
    expect(c.frState).toBe("met");
    expect(onFirstResponse(c, NOW + 500 * MIN).frAt).toBe(NOW + 5 * MIN);
  });

  it("a late one is breached, one while paused is met", () => {
    expect(onFirstResponse(started("open", NOW - 3 * 60 * MIN), NOW).frState).toBe("breached");
    expect(onFirstResponse(pause(started(), NOW), NOW).frState).toBe("met");
  });

  it("an answer at exactly the due instant is on time", () => {
    expect(onFirstResponse(started(), NOW + 30 * MIN).frState).toBe("met");
    expect(onFirstResponse(started(), NOW + 30 * MIN + 1).frState).toBe("breached");
  });
});

describe("sweep and once-only notices", () => {
  const risky = (): SlaClock => ({
    ...started(),
    frDueAt: NOW - MIN,
    frRiskAt: NOW - 10 * MIN,
    resDueAt: NOW + 60 * MIN,
    resRiskAt: NOW - MIN,
  });

  it("marks breached and announces each (target, kind) once", () => {
    const first = sweepTicket(risky(), NOW);
    expect(first.clock.frState).toBe("breached");
    expect(first.notices).toEqual([
      { target: "first_response", kind: "breached" },
      { target: "resolution", kind: "at_risk" },
    ]);
    const second = sweepTicket(first.clock, NOW + MIN);
    expect(second.notices).toEqual([]);
    const third = sweepTicket(second.clock, NOW + 2 * MIN);
    expect(third.notices).toEqual([]);
  });

  it("a breach settles the at-risk notice: never 'at risk' after 'breached'", () => {
    const c: SlaClock = { ...started(), resDueAt: NOW - MIN, resRiskAt: NOW - 5 * MIN };
    const out = sweepTicket(c, NOW);
    expect(out.notices).toEqual([{ target: "resolution", kind: "breached" }]);
    expect(out.clock.resRiskNotified).toBe(true);
  });

  it("does not touch paused or finished tickets", () => {
    const paused = { ...pause(started(), NOW), frDueAt: NOW - MIN, resDueAt: NOW - MIN };
    expect(sweepTicket(paused, NOW + 60 * MIN)).toEqual({ clock: paused, notices: [] });
    const done = { ...statusChange(started(), "resolved"), frDueAt: NOW - MIN };
    expect(sweepTicket(done, NOW).notices).toEqual([]);
  });

  it("a reopened, already-notified ticket is not announced again", () => {
    const swept = sweepTicket(risky(), NOW).clock;
    const resolved = statusChange(swept, "resolved");
    const reopened = statusChange(resolved, "open");
    expect(sweepTicket(reopened, NOW + MIN).notices).toEqual([]);
  });

  it("at risk before due, nothing before that", () => {
    const c = started();
    expect(sweepTicket(c, NOW + 10 * MIN).notices).toEqual([]);
    expect(sweepTicket(c, NOW + 25 * MIN).notices).toEqual([{ target: "first_response", kind: "at_risk" }]);
  });
});

describe("who is told", () => {
  const members = new Set(["a", "b", "o1", "o2", "w1"]);
  it("the assignee plus watchers", () => {
    expect(
      noticeRecipients({ assigneeId: "a", ownersAndAdmins: ["o1"], watchers: ["a", "w1"], members }).sort(),
    ).toEqual(["a", "w1"]);
  });
  it("every owner and admin when unassigned", () => {
    expect(
      noticeRecipients({ assigneeId: null, ownersAndAdmins: ["o1", "o2"], watchers: [], members }).sort(),
    ).toEqual(["o1", "o2"]);
  });
  it("only people who are still members", () => {
    expect(
      noticeRecipients({ assigneeId: "gone", ownersAndAdmins: [], watchers: ["b", "ghost"], members }),
    ).toEqual(["b"]);
  });
});
