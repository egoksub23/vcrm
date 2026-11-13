import { describe, expect, it } from "vitest";

import { ackToken, dispatchDue, nextAttemptAfter, notifyRole, runTrigger, sweepTimers, verifyAckToken } from "./engine";
import type { AdapterMap } from "./adapters";
import { STEP_ROLE } from "./rules";
import { NOW, member, okAdapter, ruleFromRecipe, seeded } from "./testing";

describe("runTrigger: raised", () => {
  it("tells the roles a matching rule names, one row per address, asking for acknowledgement", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    const out = await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(out.queued).toBe(2);
    expect(s.deliveries.map((d) => [d.role_key, d.address, d.ask_ack, d.reason])).toEqual([
      ["head_of_sport", "rahim@school.test", true, "raised"],
      ["school_nurse", "aminah@school.test", true, "raised"],
    ]);
  });

  it("does nothing when the rule does not match, or is switched off", async () => {
    const s = seeded();
    s.incidents.get("i1")!.flags = ["property_damage"];
    s.rules = [ruleFromRecipe("serious_injury", "r1"), ruleFromRecipe("personal_data", "r2", { enabled: false })];
    expect((await runTrigger(s, { incidentId: "i1", trigger: "raised" })).queued).toBe(0);
  });

  it("does not match a minor incident to a 'serious or worse' rule", async () => {
    const s = seeded();
    s.incidents.get("i1")!.severity = "low";
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    expect((await runTrigger(s, { incidentId: "i1", trigger: "raised" })).queued).toBe(0);
  });

  it("is idempotent: running the same event twice sends nothing new", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    const again = await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(again.queued).toBe(0);
    expect(s.deliveries).toHaveLength(2);
  });

  it("reports a role with nobody in it instead of failing, and still tells the others", async () => {
    const s = seeded();
    s.directory.members = s.directory.members.filter((m) => m.role_id !== "role-head_of_sport");
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    const out = await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(out.warnings).toEqual([{ roleKey: "head_of_sport", warning: "no_members" }]);
    expect(out.queued).toBe(1);
  });

  it("reports a rule that names a role the school does not have", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("personal_data", "r1"), ruleFromRecipe("serious_injury", "r2", { actions: [{ type: "notify", role_key: "ghost" }] })];
    s.directory.roles = s.directory.roles.filter((r) => r.key !== "dpo");
    s.incidents.get("i1")!.flags = ["injury", "personal_data"];
    const out = await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(out.warnings.map((w) => w.warning)).toEqual(["no_such_role", "no_such_role"]);
  });

  it("tells the reporter and the incident lead through per-incident roles", async () => {
    const s = seeded();
    s.dynamic = { reporter: [{ name: "Coach Rahim", emails: ["coach@club.test"], phones: [] }] };
    s.rules = [ruleFromRecipe("confirm_reporter", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(s.deliveries.map((d) => d.address)).toEqual(["coach@club.test"]);
  });

  it("sends one message to a person two rules both tell, asking for an acknowledgement if either does", async () => {
    const s = seeded();
    s.incidents.get("i1")!.flags = ["injury", "concussion"];
    s.rules = [
      ruleFromRecipe("serious_injury", "r1", { actions: [{ type: "notify", role_key: "school_nurse" }] }),
      ruleFromRecipe("concussion", "r2", { actions: [{ type: "notify", role_key: "school_nurse", ask_ack: true }, { type: "notify", role_key: "head_of_sport", ask_ack: true }] }),
    ];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(s.deliveries.map((d) => [d.address, d.ask_ack])).toEqual([["aminah@school.test", true], ["rahim@school.test", true]]);
  });

  it("sends a test-key report only to the test recipients", async () => {
    const s = seeded();
    s.incidents.get("i1")!.is_test = true;
    s.testPeople = [{ contactId: null, userId: "u1", name: "Admin", channel: "email", address: "admin@school.test", roleKey: "x" }];
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(new Set(s.deliveries.map((d) => d.address))).toEqual(new Set(["admin@school.test"]));
    expect(s.deliveries.every((d) => d.is_test && d.reason === "test")).toBe(true);
  });

  it("3.9 auto-escalates to level 2 when every notify role is empty", async () => {
    const s = seeded();
    s.directory.members = [];
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    const out = await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(out.escalatedTo).toBe(2);
    expect(s.incidents.get("i1")!.escalation_level).toBe(2);
    expect(s.deliveries).toHaveLength(0);
  });

  it("3.9 does not auto-escalate when at least one notify is delivered", async () => {
    const s = seeded();
    s.directory.members = s.directory.members.filter((m) => m.role_id !== "role-head_of_sport");
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    const out = await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(out.escalatedTo).toBe(null);
    expect(s.incidents.get("i1")!.escalation_level).toBe(1);
    expect(s.deliveries).toHaveLength(1);
  });
});

describe("the outbox", () => {
  it("sends a minimal notice with the reference, category, severity and links, and marks the row sent", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    const calls: { to: string; subject: string; text: string }[] = [];
    const out = await dispatchDue(s, okAdapter(calls));
    expect(out).toEqual({ sent: 2, failed: 0 });
    expect(s.deliveries.every((d) => d.status === "sent")).toBe(true);
    const first = calls[0];
    expect(first.subject).toContain("INC-2026-31");
    expect(first.text).toContain("Category: CCA / sports injury");
    expect(first.text).toContain("https://halo.test/incidents/i1");
    expect(first.text).toMatch(/https:\/\/halo\.test\/incident-ack\/[0-9a-f-]{36}\.[0-9a-f]{32}/);
    // minimal content: no names
    expect(first.text).not.toMatch(/Adam|Rahim|Aminah/);
  });

  it("records a failure with backoff and does not stop the other messages", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    const flaky: AdapterMap = {
      email: {
        channel: "email",
        async send({ to }) {
          return to.startsWith("rahim") ? { ok: false, error: "mailbox full", retryable: true } : { ok: true };
        },
      },
    };
    const out = await dispatchDue(s, flaky);
    expect(out).toEqual({ sent: 1, failed: 1 });
    const failed = s.deliveries.find((d) => d.status === "failed")!;
    expect(s.errors.get(failed.id)).toBe("mailbox full");
    expect(s.nextAt.get(failed.id)).toEqual(new Date(NOW.getTime() + 2 * 60_000));
  });

  it("gives up without retrying when there is no way to send", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("personal_data", "r1")];
    s.incidents.get("i1")!.flags = ["personal_data"];
    s.directory.members.push(member("dpo", "head"));
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    await dispatchDue(s, {});
    const row = s.deliveries[0];
    expect(row.status).toBe("failed");
    expect(s.nextAt.get(row.id)).toBeNull();
    expect(s.errors.get(row.id)).toMatch(/No way to send email/);
  });

  it("fails clearly when the Halo address is not configured", async () => {
    const s = seeded();
    s.url = null;
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    await dispatchDue(s, okAdapter());
    expect([...s.errors.values()][0]).toMatch(/NEXT_PUBLIC_SITE_URL/);
  });

  it("backs off 2, 4, 8, 16 minutes then stops", () => {
    expect([1, 2, 3, 4].map((a) => nextAttemptAfter(a, NOW)!.getTime() - NOW.getTime())).toEqual([2, 4, 8, 16].map((m) => m * 60_000));
    expect(nextAttemptAfter(5, NOW)).toBeNull();
  });
});

describe("timers", () => {
  it("escalates and tells the Principal when nobody acknowledged", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("remind_unacknowledged", "r9")];
    s.unacknowledged = ["i1"];
    const out = await sweepTimers(s, ["a1"]);
    expect(out.unacknowledged).toBe(1);
    expect(s.incidents.get("i1")!.escalation_level).toBe(2);
    expect(s.deliveries.map((d) => [d.role_key, d.reason])).toEqual([["principal", "reminder"]]);
    // a second sweep changes nothing
    expect((await sweepTimers(s, ["a1"])).unacknowledged).toBe(0);
    expect(s.deliveries).toHaveLength(1);
  });

  it("tells the incident lead and the Principal when an incident stays open, once", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("resolve_by", "r7")];
    s.dynamic = { incident_lead: [{ name: "Lead", emails: ["lead@school.test"], phones: [] }] };
    s.unresolved = ["i1"];
    const out = await sweepTimers(s, ["school-a"].map(() => "a1"));
    expect(out.unresolved).toBe(1);
    expect(s.deliveries.map((d) => [d.role_key, d.reason])).toEqual([["incident_lead", "reminder"], ["principal", "reminder"]]);
    expect((await sweepTimers(s, ["a1"])).unresolved).toBe(0);
    expect(s.deliveries).toHaveLength(2);
  });

  it("chases an overdue step once, telling the step's role (from its party) and the lead", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("step_overdue", "r8")];
    s.dynamic = { incident_lead: [{ name: "Lead", emails: ["lead@school.test"], phones: [] }] };
    s.overdue = [{ obligationId: "ob-1", incidentId: "i1", party: "school_leadership" }];
    await sweepTimers(s, ["a1"]);
    await sweepTimers(s, ["a1"]);
    expect(s.deliveries.map((d) => [d.role_key, d.address, d.ref_key])).toEqual([
      ["principal", "head@school.test", "ob-1"],
      ["incident_lead", "lead@school.test", "ob-1"],
    ]);
    expect(STEP_ROLE).toBe("$step_role");
  });

  it("falls back to the incident lead when a step names no role", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("step_overdue", "r8", { actions: [{ type: "notify", role_key: STEP_ROLE }] })];
    s.dynamic = { incident_lead: [{ name: "Lead", emails: ["lead@school.test"], phones: [] }] };
    s.overdue = [{ obligationId: "ob-2", incidentId: "i1", party: null }];
    await sweepTimers(s, ["a1"]);
    expect(s.deliveries.map((d) => d.role_key)).toEqual(["incident_lead"]);
  });
});

describe("acknowledge tokens", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  it("verify for the delivery they were made for, and nothing else", () => {
    const token = ackToken(id, "s3cret");
    expect(verifyAckToken(token, "s3cret")).toBe(id);
    expect(verifyAckToken(token, "other")).toBeNull();
    expect(verifyAckToken(`${id}.${"0".repeat(32)}`, "s3cret")).toBeNull();
    expect(verifyAckToken("garbage", "s3cret")).toBeNull();
    expect(verifyAckToken(token.replace(id, "99999999-2222-3333-4444-555555555555"), "s3cret")).toBeNull();
  });
  it("never verifies when no secret is configured", () => {
    expect(verifyAckToken(ackToken(id, ""), "")).toBeNull();
  });
});

describe("notifyRole (one-off notices such as an approval request)", () => {
  it("tells the role once for the same thing, and says why when nobody can be told", async () => {
    const s = seeded();
    const first = await notifyRole(s, { incidentId: "i1", roleKey: "principal", reason: "approval", refKey: "approval:1" });
    const again = await notifyRole(s, { incidentId: "i1", roleKey: "principal", reason: "approval", refKey: "approval:1" });
    expect(first.queued).toBe(1);
    expect(again.queued).toBe(0);
    expect(s.deliveries.map((d) => [d.role_key, d.reason, d.rule_id, d.ref_key])).toEqual([["principal", "approval", null, "approval:1"]]);
    s.directory.members = s.directory.members.filter((m) => m.role_id !== "role-principal");
    expect(await notifyRole(s, { incidentId: "i1", roleKey: "principal", reason: "approval", refKey: "approval:2" })).toEqual({ queued: 0, warnings: ["no_members"] });
    expect(await notifyRole(s, { incidentId: "i1", roleKey: "ghost", reason: "approval", refKey: "x" })).toEqual({ queued: 0, warnings: ["no_such_role"] });
  });
});

describe("runTrigger: escalated (escalation goes through the roles)", () => {
  it("tells the role a rule names when an incident is escalated, saying it is an escalation", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("escalated_2", "re1")];
    s.incidents.get("i1")!.escalation_level = 2;
    const out = await runTrigger(s, { incidentId: "i1", trigger: "escalated" });
    expect(out.queued).toBe(1);
    expect(s.deliveries.map((d) => [d.role_key, d.ask_ack, d.reason])).toEqual([["principal", true, "escalated"]]);
  });

  it("does nothing for a school with no rule for escalation", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    expect((await runTrigger(s, { incidentId: "i1", trigger: "escalated" })).queued).toBe(0);
  });

  it("runs the escalation rules when another rule raises the level, once, and never loops", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("remind_unacknowledged", "r9"), ruleFromRecipe("escalated_2", "re1")];
    s.unacknowledged = ["i1"];
    await sweepTimers(s, ["a1"]);
    expect(s.incidents.get("i1")!.escalation_level).toBe(2);
    // the nobody-acknowledged rule tells the Principal (a reminder); the escalation rule tells the Principal too (an escalation), as a separate notice
    expect(s.deliveries.map((d) => d.reason).sort()).toEqual(["escalated", "reminder"]);
    await sweepTimers(s, ["a1"]);
    expect(s.deliveries).toHaveLength(2);
  });
});

describe("escalation rules by level", () => {
  it("runs the rule for the level reached, and not the one for another level", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("escalated_2", "l2"), ruleFromRecipe("escalated_3", "l3")];
    s.incidents.get("i1")!.escalation_level = 2;
    await runTrigger(s, { incidentId: "i1", trigger: "escalated" });
    expect([...new Set(s.deliveries.map((d) => d.rule_id))]).toEqual(["l2"]);
    s.incidents.get("i1")!.escalation_level = 3;
    await runTrigger(s, { incidentId: "i1", trigger: "escalated" });
    expect([...new Set(s.deliveries.map((d) => d.rule_id))].sort()).toEqual(["l2", "l3"]);
  });
});
