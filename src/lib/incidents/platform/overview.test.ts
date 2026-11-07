import { describe, expect, it } from "vitest";

import { buildOverview, isMyTask, isNearMissCategory, type OverviewIncident } from "./overview";

const NOW = new Date("2026-11-11T10:00:00Z");
const inc = (id: string, over: Partial<OverviewIncident> = {}): OverviewIncident => ({
  id,
  incident_number: Number(id.replace(/\D/g, "")) || 1,
  created_at: "2026-11-05T10:00:00Z",
  title: `Incident ${id}`,
  incident_type: "CCA",
  severity: "medium",
  status: "investigating",
  ...over,
});
const cats = [{ code: "CCA", name: "CCA / sports injury" }, { code: "NMS", name: "Near miss" }];

describe("buildOverview", () => {
  it("counts open incidents, overdue steps on open incidents, and incidents still waiting for an acknowledgement", () => {
    const out = buildOverview({
      incidents: [inc("a1", { status: "reported" }), inc("a2"), inc("a3", { status: "closed" })],
      steps: [
        { id: "s1", incident_id: "a2", title: "Inform principal", due_at: "2026-11-11T07:00:00Z", role_key: "principal" },
        { id: "s2", incident_id: "a2", title: "Later", due_at: "2026-11-12T07:00:00Z", role_key: null },
        { id: "s3", incident_id: "a3", title: "On a closed one", due_at: "2026-11-01T07:00:00Z", role_key: null },
      ],
      ack: [{ incident_id: "a1", first_ask_at: "2026-11-11T09:00:00Z", acknowledged: false }],
      categories: cats,
      now: NOW,
    });
    expect(out).toMatchObject({ open: 2, overdueSteps: 1, unacknowledged: 1 });
  });

  it("does not count an acknowledged incident, or one already triaged, as waiting", () => {
    const out = buildOverview({
      incidents: [inc("a1", { status: "reported" }), inc("a2", { status: "triaged" })],
      steps: [],
      ack: [
        { incident_id: "a1", first_ask_at: "2026-11-11T09:00:00Z", acknowledged: true },
        { incident_id: "a2", first_ask_at: "2026-11-11T09:00:00Z", acknowledged: false },
      ],
      categories: cats,
      now: NOW,
    });
    expect(out.unacknowledged).toBe(0);
  });

  it("counts this month's near misses only", () => {
    const out = buildOverview({
      incidents: [inc("a1", { incident_type: "NMS", created_at: "2026-11-03T00:00:00Z" }), inc("a2", { incident_type: "NMS", created_at: "2026-10-30T00:00:00Z" }), inc("a3")],
      steps: [],
      ack: [],
      categories: cats,
      now: NOW,
    });
    expect(out.nearMissesThisMonth).toBe(1);
  });

  it("puts unacknowledged serious incidents first, then overdue steps, then other serious open incidents", () => {
    const out = buildOverview({
      incidents: [inc("a1", { severity: "critical", status: "reported", title: "Intruder" }), inc("a2", { severity: "critical", status: "investigating", title: "Fire" }), inc("a3", { severity: "low" })],
      steps: [{ id: "s1", incident_id: "a3", title: "Inform principal", due_at: "2026-11-11T06:00:00Z", role_key: null }],
      ack: [{ incident_id: "a1", first_ask_at: "2026-11-11T09:00:00Z", acknowledged: false }],
      categories: cats,
      now: NOW,
    });
    expect(out.needsAction.map((n) => n.kind)).toEqual(["unacknowledged", "overdue_step", "serious_open"]);
    expect(out.needsAction[0]).toMatchObject({ incidentId: "a1", waitingMinutes: 60 });
    expect(out.needsAction[1]).toMatchObject({ overdueMinutes: 240 });
    // the dashboard's "needs action" filter keeps every incident, once each, even past the short list
    expect([...out.needsActionIds].sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("limits the list and counts categories over the last 90 days", () => {
    const many = Array.from({ length: 12 }, (_, i) => inc(`b${i}`, { severity: "critical" }));
    const out = buildOverview({ incidents: [...many, inc("old", { created_at: "2026-01-01T00:00:00Z", incident_type: "SEC" })], steps: [], ack: [], categories: cats, now: NOW, limit: 5 });
    expect(out.needsAction).toHaveLength(5);
    expect(out.byCategory).toEqual([{ code: "CCA", count: 12 }]);
  });
});

describe("tasks", () => {
  it("belongs to a role holder, or to the incident lead when the step names no role", () => {
    const lead = new Set(["i1"]);
    expect(isMyTask({ role_key: "principal", incident_id: "i9" }, ["principal"], lead)).toBe(true);
    expect(isMyTask({ role_key: "dpo", incident_id: "i1" }, ["principal"], lead)).toBe(false);
    expect(isMyTask({ role_key: null, incident_id: "i1" }, [], lead)).toBe(true);
    expect(isMyTask({ role_key: null, incident_id: "i2" }, ["principal"], lead)).toBe(false);
  });
  it("recognises near-miss categories by code or name", () => {
    expect(isNearMissCategory({ code: "NMS", name: "x" })).toBe(true);
    expect(isNearMissCategory({ code: "Z", name: "Near-miss report" })).toBe(true);
    expect(isNearMissCategory({ code: "CCA", name: "Injury" })).toBe(false);
  });
});
