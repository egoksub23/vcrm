import { describe, expect, it } from "vitest";

import type { AdapterMap, ChannelAdapter } from "./adapters";
import {
  ackToken,
  dispatchDue,
  nextAttemptAfter,
  runTrigger,
  sweepTimers,
  verifyAckToken,
  type DeliveryRow,
  type Directory,
  type EngineIncident,
  type EngineStore,
  type NewDelivery,
  type OverdueStep,
} from "./engine";
import { RECIPES, STEP_ROLE, type IncidentRule } from "./rules";
import type { DynamicPeople, IncidentContact, IncidentRole, IncidentRoleMember, Recipient } from "./roles";

const NOW = new Date("2026-11-11T10:00:00Z");

const role = (key: string, over: Partial<IncidentRole> = {}): IncidentRole => ({
  id: `role-${key}`,
  account_id: "a1",
  key,
  name: { en: key },
  description: null,
  kind: "fixed",
  dynamic_source: null,
  notify_mode: "all",
  sort_order: 0,
  is_system: true,
  ...over,
});
const contact = (id: string, over: Partial<IncidentContact> = {}): IncidentContact => ({
  id,
  account_id: "a1",
  user_id: null,
  name: id,
  kind: "staff",
  emails: [`${id}@school.test`],
  phones: [],
  preferred_channels: ["email"],
  is_active: true,
  ...over,
});
const member = (roleKey: string, contactId: string, position = 1): IncidentRoleMember => ({
  id: `m-${roleKey}-${contactId}`,
  account_id: "a1",
  role_id: `role-${roleKey}`,
  contact_id: contactId,
  position,
  away_from: null,
  away_to: null,
  is_backup: false,
});

function ruleFromRecipe(key: string, id: string, over: Partial<IncidentRule> = {}): IncidentRule {
  const draft = RECIPES.find((r) => r.key === key)!.build({ serious: "high" });
  return { id, account_id: "a1", recipe_key: key, position: 0, enabled: true, ...draft, ...over };
}

class MemoryStore implements EngineStore {
  incidents = new Map<string, EngineIncident>();
  rules: IncidentRule[] = [];
  directory: Directory = { roles: [], members: [], contacts: [] };
  dynamic: DynamicPeople = {};
  testPeople: Recipient[] = [];
  deliveries: DeliveryRow[] = [];
  errors = new Map<string, string>();
  nextAt = new Map<string, Date | null>();
  unacknowledged: string[] = [];
  overdue: OverdueStep[] = [];
  url: string | null = "https://halo.test";
  private n = 0;

  async loadIncident(id: string) {
    return this.incidents.get(id) ?? null;
  }
  async loadRules(_a: string, trigger: string) {
    return this.rules.filter((r) => r.trigger === trigger);
  }
  async loadDirectory() {
    return this.directory;
  }
  async loadDynamicPeople() {
    return this.dynamic;
  }
  async loadTestRecipients() {
    return this.testPeople;
  }
  async loadLabels() {
    return { categoryName: "CCA / sports injury", severityName: "Serious" };
  }
  async existingKeys(incidentId: string) {
    return new Set(this.deliveries.filter((d) => d.incident_id === incidentId).map((d) => `${d.rule_id ?? "-"}|${d.role_key}|${d.channel}|${d.address.toLowerCase()}|${d.ref_key}`));
  }
  async insertDeliveries(rows: NewDelivery[]) {
    const out = rows.map((r) => ({ ...r, id: `00000000-0000-0000-0000-${String(++this.n).padStart(12, "0")}`, attempts: 0, status: "queued" as const }));
    this.deliveries.push(...out);
    return out;
  }
  async claimDue() {
    const due = this.deliveries.filter((d) => d.status === "queued" || (d.status === "failed" && d.attempts < 5));
    due.forEach((d) => (d.status = "sending"));
    return due.map((d) => ({ ...d }));
  }
  async markSent(id: string) {
    const d = this.deliveries.find((x) => x.id === id)!;
    d.status = "sent";
    d.attempts += 1;
  }
  async markFailed(id: string, error: string, next: Date | null) {
    const d = this.deliveries.find((x) => x.id === id)!;
    d.status = "failed";
    d.attempts += 1;
    this.errors.set(id, error);
    this.nextAt.set(id, next);
  }
  async raiseEscalationLevel(incidentId: string, level: 2 | 3) {
    const i = this.incidents.get(incidentId)!;
    if (i.escalation_level >= level) return false;
    i.escalation_level = level;
    return true;
  }
  async listUnacknowledged() {
    return this.unacknowledged;
  }
  async listOverdueSteps() {
    return this.overdue;
  }
  appUrl() {
    return this.url;
  }
  async senderName() {
    return "Test School";
  }
  now() {
    return NOW;
  }
}

function seeded(): MemoryStore {
  const s = new MemoryStore();
  s.incidents.set("i1", { id: "i1", account_id: "a1", reference: "INC-2026-31", category: "CCA", severity: "high", flags: ["injury", "child_involved"], status: "reported", escalation_level: 1, is_test: false });
  s.directory = {
    roles: [role("head_of_sport"), role("school_nurse"), role("principal"), role("incident_lead", { kind: "per_incident", dynamic_source: "incident_lead" }), role("reporter", { kind: "per_incident", dynamic_source: "reporter" }), role("dpo")],
    members: [member("head_of_sport", "rahim"), member("school_nurse", "aminah"), member("principal", "head")],
    contacts: [contact("rahim"), contact("aminah"), contact("head")],
  };
  return s;
}

const okAdapter = (calls: { to: string; subject: string; text: string }[] = []): AdapterMap => ({
  email: {
    channel: "email",
    async send({ to, notice }) {
      calls.push({ to, subject: notice.subject, text: notice.text });
      return { ok: true, providerRef: "test" };
    },
  } satisfies ChannelAdapter,
});

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

  it("sends a test-key report only to the test recipients", async () => {
    const s = seeded();
    s.incidents.get("i1")!.is_test = true;
    s.testPeople = [{ contactId: null, userId: "u1", name: "Admin", channel: "email", address: "admin@school.test", roleKey: "x" }];
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(new Set(s.deliveries.map((d) => d.address))).toEqual(new Set(["admin@school.test"]));
    expect(s.deliveries.every((d) => d.is_test && d.reason === "test")).toBe(true);
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
