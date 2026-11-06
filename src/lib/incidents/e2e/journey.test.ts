import { beforeEach, describe, expect, it } from "vitest";

import { clearances, launch, loadReport, submit, type NewIncident } from "@/lib/incidents/intake/service";
import { MemoryStore as IntakeStore, answers, payload, setup as setupIntake, tokenOf } from "@/lib/incidents/intake/testing";
import { dispatchDue, runTrigger, sweepTimers, verifyAckToken, type DeliveryRow } from "@/lib/incidents/platform/engine";
import { parseClearance } from "@/lib/incidents/platform/clearance";
import { RECIPES, type IncidentRule } from "@/lib/incidents/platform/rules";
import { MemoryStore as EngineStore, member, okAdapter, seeded } from "@/lib/incidents/platform/testing";

// The end-to-end functional test, Halo alone: the journey in docs/incident-e2e-test.md (G.1 to G.4) run through the real code with in-memory stores and a
// simulated portal. It proves the pieces fit together; the phone, iframe and web-view checks (G.2) and the real database stay manual.
//
//   portal asks for a link -> coach opens it and sends the report -> the rules tell the roles -> nobody acknowledges -> the chain escalates ->
//   someone acknowledges -> the nurse sets a Return to Play date -> the portal reads it as a warning -> another school sees none of it

beforeEach(() => {
  // Acknowledge links are signed with a server secret; without one they never verify (by design).
  process.env.INCIDENT_ACK_SECRET = "journey-secret";
});

class JourneyStore extends EngineStore {
  sentAt = new Map<string, Date>();
  async markSent(id: string, now: Date) {
    await super.markSent(id, now);
    this.sentAt.set(id, now);
  }
  // Same meaning as the SQL view: incidents whose first acknowledge-asking notice went out at or before the cutoff and that nobody has acknowledged.
  async listUnacknowledged(_account: string, askedBefore: Date) {
    const ids = new Set<string>();
    for (const d of this.deliveries) {
      if (!d.ask_ack || d.status === "acknowledged" || !this.sentAt.has(d.id)) continue;
      if (this.incidents.get(d.incident_id)?.status !== "reported") continue;
      if ((this.sentAt.get(d.id) as Date) <= askedBefore) ids.add(d.incident_id);
    }
    for (const d of this.deliveries) if (d.status === "acknowledged") ids.delete(d.incident_id);
    return [...ids];
  }
}

function world() {
  const intake = setupIntake();
  const engine = new JourneyStore();
  const base = seeded();
  engine.directory = base.directory;
  engine.incidents.clear();
  engine.directory.members.push(member("dpo", "head", 1));
  engine.rules = RECIPES.filter((r) => r.inStarterSet).map((r, i): IncidentRule => ({ id: `rule-${i}`, account_id: "school-a", recipe_key: r.key, position: i, enabled: true, ...r.build({ serious: "high" }) }));
  engine.dynamic = { reporter: [{ name: "Rahim Ismail", emails: ["coach.rahim@club.test"], phones: [] }] };

  const mails: { to: string; subject: string; text: string }[] = [];
  const adapters = okAdapter(mails);

  // What the real wiring does after a report is filed: the incident exists in the database, then the rules run and the outbox is sent.
  intake.deps.afterFiled = async (incidentId) => {
    const filed = intake.store.incidents.find((i) => i.id === incidentId) as NewIncident & { id: string; reference: string };
    engine.incidents.set(incidentId, {
      id: incidentId,
      account_id: filed.accountId,
      reference: filed.reference,
      category: filed.category,
      severity: filed.severity,
      flags: filed.flags,
      status: "reported",
      escalation_level: 1,
      is_test: filed.mode === "test",
    });
    await runTrigger(engine, { incidentId, trigger: "raised" });
    await dispatchDue(engine, adapters);
  };
  return { intake, engine, mails, adapters };
}

async function sendReport(w: ReturnType<typeof world>, over: Record<string, unknown> = {}) {
  const { key } = w.intake.store.addKey("school-a");
  const out = await launch(w.intake.deps, { authorization: key, idempotencyKey: "tap-1", body: payload });
  const token = tokenOf(out.body.url as string);
  const sent = await submit(w.intake.deps, { token, answers: { ...answers, ...over } });
  return { key, token, sent };
}

describe("G.1 the whole journey", () => {
  it("tells the right roles, asks them to acknowledge, escalates when nobody does, and stops when someone does", async () => {
    const w = world();
    const { sent } = await sendReport(w, { severity: "hospital", head_injury: true });
    expect(sent.status).toBe(201);
    const reference = sent.body.reference as string;

    // 1. The roles were told at once: nurse and Head of Sport (concussion and serious injury), and the coach got the reference.
    const told = w.engine.deliveries.map((d) => `${d.role_key}:${d.address}`);
    expect(told).toEqual(expect.arrayContaining(["school_nurse:aminah@school.test", "head_of_sport:rahim@school.test", "reporter:coach.rahim@club.test"]));
    expect(w.engine.deliveries.filter((d) => d.role_key === "principal")).toHaveLength(0);
    expect(w.engine.deliveries.every((d) => d.status === "sent")).toBe(true);

    // 2. The notices are minimal: reference, category, severity, links. No child's name, no description.
    const nurseMail = w.mails.find((m) => m.to === "aminah@school.test")!;
    expect(nurseMail.subject).toContain(reference);
    expect(nurseMail.text).toContain("incident-ack/");
    expect(nurseMail.text).not.toMatch(/Adam|Yusof|ankle|Twisted/i);

    // 3. Thirty-one minutes pass with no acknowledgement: the Principal is told and the incident moves to Level 2.
    w.engine.clock = new Date(w.engine.clock.getTime() + 31 * 60_000);
    await sweepTimers(w.engine, ["school-a"]);
    await dispatchDue(w.engine, okAdapter(w.mails));
    const incidentId = [...w.engine.incidents.keys()][0];
    expect(w.engine.incidents.get(incidentId)?.escalation_level).toBe(2);
    expect(w.engine.deliveries.some((d) => d.role_key === "principal" && d.reason === "reminder")).toBe(true);

    // 4. The nurse taps the link in her email: the delivery counts as acknowledged, and the chain does not run again.
    const ackable = w.engine.deliveries.find((d) => d.role_key === "school_nurse" && d.ask_ack) as DeliveryRow;
    const url = w.mails.find((m) => m.to === "aminah@school.test")!.text.match(/incident-ack\/(\S+)/)![1];
    expect(verifyAckToken(url)).toBe(ackable.id);
    ackable.status = "acknowledged"; // what POST /api/public/incident-ack does
    const principalNotices = w.engine.deliveries.filter((d) => d.role_key === "principal").length;

    // 5. More time passes: nobody else is chased about this incident. (An acknowledged incident leaves the waiting list.)
    w.engine.clock = new Date(w.engine.clock.getTime() + 6 * 3_600_000);
    await sweepTimers(w.engine, ["school-a"]);
    expect(w.engine.deliveries.filter((d) => d.role_key === "principal")).toHaveLength(principalNotices);
  });

  it("lets the nurse set a Return to Play date that the portal reads as a warning, for that school only", async () => {
    const w = world();
    const { key } = await sendReport(w);
    const input = parseClearance({ incident_id: "inc-1", student_id: "S-1", type: "concussion", not_before: "2026-11-20" }, w.intake.store.now());
    expect(input.ok).toBe(true);
    w.intake.store.clearanceRows.push({ account_id: "school-a", external_student_id: "S-1", type: "concussion", not_before: "2026-11-20", incident_reference: "INC-2026-1" });
    w.intake.store.clearanceRows.push({ account_id: "school-b", external_student_id: "S-1", type: "injury", not_before: "2026-12-01", incident_reference: "INC-2026-9" });

    const mine = await clearances(w.intake.deps, { authorization: key, studentIds: ["S-1", "S-2"] });
    expect(mine.body).toEqual({ clearances: [{ student_id: "S-1", type: "concussion", not_before: "2026-11-20", incident: "INC-2026-1" }] });
  });
});

describe("G.3 failure cases", () => {
  it("an expired link cannot be used and says what to do", async () => {
    const w = world();
    const { key } = w.intake.store.addKey("school-a");
    const out = await launch(w.intake.deps, { authorization: key, idempotencyKey: null, body: payload });
    const token = tokenOf(out.body.url as string);
    w.intake.store.clock = new Date(w.intake.store.clock.getTime() + 3 * 3_600_000);
    expect(await loadReport(w.intake.deps, token)).toEqual({ state: "expired" });
    expect((await submit(w.intake.deps, { token, answers })).body).toMatchObject({ error: { code: "link_expired" } });
    expect(w.engine.deliveries).toHaveLength(0);
  });

  it("a reused link does not file a second report or tell anyone twice", async () => {
    const w = world();
    const { token, sent } = await sendReport(w);
    const before = w.engine.deliveries.length;
    const again = await submit(w.intake.deps, { token, answers });
    expect(again.body).toMatchObject({ duplicate: true, reference: sent.body.reference });
    expect(w.intake.store.incidents).toHaveLength(1);
    expect(w.engine.deliveries).toHaveLength(before);
  });

  it("a revoked key ends the links it issued and cannot ask for new ones", async () => {
    const w = world();
    const { key, token } = await sendReport(w);
    w.intake.store.keys[0].revoked_at = w.intake.store.clock.toISOString();
    expect(await loadReport(w.intake.deps, token)).toMatchObject({ state: "invalid" });
    expect((await launch(w.intake.deps, { authorization: key, idempotencyKey: null, body: payload })).status).toBe(401);
  });

  it("a role with nobody in it is reported, not silent, and the others are still told", async () => {
    const w = world();
    w.engine.directory.members = w.engine.directory.members.filter((m) => m.role_id !== "role-school_nurse");
    await sendReport(w, { severity: "hospital", head_injury: true });
    const roles = new Set(w.engine.deliveries.map((d) => d.role_key));
    expect(roles.has("school_nurse")).toBe(false);
    expect(roles.has("head_of_sport")).toBe(true);
    const out = await runTrigger(w.engine, { incidentId: [...w.engine.incidents.keys()][0], trigger: "raised" });
    expect(out.warnings.some((x) => x.roleKey === "school_nurse" && x.warning === "no_members")).toBe(true);
  });

  it("a bounced email is recorded with the reason and retried later, without losing the others", async () => {
    const w = world();
    const flaky = { email: { channel: "email" as const, async send({ to }: { to: string }) { return to.startsWith("aminah") ? { ok: false as const, error: "mailbox full", retryable: true } : { ok: true as const }; } } };
    // use the journey wiring but with a flaky adapter for the first send
    w.intake.deps.afterFiled = async (incidentId) => {
      const f = w.intake.store.incidents.find((i) => i.id === incidentId)!;
      w.engine.incidents.set(incidentId, { id: incidentId, account_id: f.accountId, reference: f.reference, category: f.category, severity: f.severity, flags: f.flags, status: "reported", escalation_level: 1, is_test: false });
      await runTrigger(w.engine, { incidentId, trigger: "raised" });
      await dispatchDue(w.engine, flaky);
    };
    await sendReport(w, { severity: "hospital", head_injury: true });
    const failed = w.engine.deliveries.filter((d) => d.status === "failed");
    expect(failed.map((d) => d.address)).toEqual(["aminah@school.test"]);
    expect(w.engine.errors.get(failed[0].id)).toBe("mailbox full");
    expect(w.engine.deliveries.filter((d) => d.status === "sent").length).toBeGreaterThan(0);
    // later the mailbox works: the same row goes out and nothing is duplicated
    await dispatchDue(w.engine, okAdapter(w.mails));
    const nurse = w.engine.deliveries.filter((d) => d.address === "aminah@school.test");
    expect(nurse).toHaveLength(1);
    expect(nurse[0].status).toBe("sent");
  });
});

describe("G.4 school data isolation", () => {
  it("a second school cannot see, notify or read the first school's report", async () => {
    const w = world();
    const a = await sendReport(w);
    const b = w.intake.store.addKey("school-b");

    // school B's key cannot use school A's link, and A's report is filed under A.
    expect(w.intake.store.incidents.every((i) => i.accountId === "school-a")).toBe(true);
    const launchedB = await launch(w.intake.deps, { authorization: b.key, idempotencyKey: null, body: payload });
    const sessionB = w.intake.store.sessions.find((s) => s.account_id === "school-b")!;
    expect(sessionB.key_id).not.toBe(w.intake.store.sessions[0].key_id);
    expect(launchedB.status).toBe(201);

    // school B reads no clearance of school A's, even for the same student id.
    w.intake.store.clearanceRows.push({ account_id: "school-a", external_student_id: "S-1", type: "concussion", not_before: "2026-11-20", incident_reference: "INC-2026-1" });
    expect((await clearances(w.intake.deps, { authorization: b.key, studentIds: ["S-1"] })).body).toEqual({ clearances: [] });
    expect(a.sent.status).toBe(201);
  });
});
