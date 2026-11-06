import { describe, expect, it } from "vitest";

import {
  RECIPES,
  STEP_ROLE,
  describeRule,
  planRules,
  roleForParty,
  ruleMatches,
  validateRule,
  type IncidentRule,
  type Namer,
} from "./rules";
import type { ResolveResult } from "./roles";

const names: Namer = {
  role: (k) => ({ head_of_sport: "Head of Sport", school_nurse: "School nurse", principal: "Principal" })[k] ?? k,
  category: (c) => ({ CCA: "CCA / sports injury", INJ: "Injury" })[c] ?? c,
  severity: (s) => ({ high: "Serious", critical: "Critical" })[s] ?? s,
  flag: (f) => ({ injury: "someone injured", personal_data: "personal data" })[f] ?? f,
};

describe("ruleMatches", () => {
  const facts = { category: "CCA", severity: "high", flags: ["injury"] };
  it("treats empty conditions as 'always'", () => {
    expect(ruleMatches({}, facts)).toBe(true);
  });
  it("needs the category, a flag and the severity to all hold", () => {
    expect(ruleMatches({ categories: ["CCA"], flags: ["injury"], min_severity: "high" }, facts)).toBe(true);
    expect(ruleMatches({ categories: ["SEC"] }, facts)).toBe(false);
    expect(ruleMatches({ flags: ["personal_data"] }, facts)).toBe(false);
    expect(ruleMatches({ flags: ["personal_data", "injury"] }, facts)).toBe(true);
    expect(ruleMatches({ min_severity: "critical" }, facts)).toBe(false);
    expect(ruleMatches({ min_severity: "medium" }, facts)).toBe(true);
  });
  it("reads BNM severities on the same scale", () => {
    expect(ruleMatches({ min_severity: "P2" }, { category: "DB", severity: "P1", flags: [] })).toBe(true);
    expect(ruleMatches({ min_severity: "P2" }, { category: "DB", severity: "P3", flags: [] })).toBe(false);
  });
});

describe("validateRule", () => {
  const ok = { name: "x", trigger: "raised" as const, wait_minutes: null, conditions: {}, actions: [{ type: "notify" as const, role_key: "principal" }] };
  const roles = ["principal", "dpo"];
  it("accepts a good rule", () => {
    expect(validateRule(ok, roles)).toEqual([]);
  });
  it("explains each problem in plain words", () => {
    expect(validateRule({ ...ok, name: " " }, roles)).toEqual(["Give the rule a name."]);
    expect(validateRule({ ...ok, actions: [] }, roles)).toEqual(["Say what should happen."]);
    expect(validateRule({ ...ok, actions: [{ type: "notify", role_key: "ghost" }] }, roles)).toEqual(['There is no role "ghost".']);
    expect(validateRule({ ...ok, trigger: "unacknowledged", wait_minutes: null }, roles)[0]).toMatch(/how long to wait/);
    expect(validateRule({ ...ok, wait_minutes: 30 }, roles)[0]).toMatch(/Only rules that wait/);
    expect(validateRule({ ...ok, actions: [{ type: "notify", role_key: STEP_ROLE }] }, roles)[0]).toMatch(/overdue step/);
    expect(validateRule({ ...ok, trigger: "step_overdue", wait_minutes: 60, actions: [{ type: "escalate", level: 2 }] }, roles)[0]).toMatch(/cannot escalate/);
  });
});

describe("describeRule", () => {
  it("writes the serious-injury recipe as a sentence", () => {
    const draft = RECIPES.find((r) => r.key === "serious_injury")!.build({ serious: "high" });
    expect(describeRule(draft, names)).toEqual({
      when: "An incident is raised",
      onlyIf: "Only if it involves someone injured and the severity is Serious or worse",
      then: ["Tell Head of Sport by email and ask them to acknowledge", "Tell School nurse by email and ask them to acknowledge"],
    });
  });
  it("writes a timed rule with its wait and an escalation", () => {
    const draft = RECIPES.find((r) => r.key === "remind_unacknowledged")!.build({ serious: "high" });
    const s = describeRule(draft, names);
    expect(s.when).toBe("Nobody has acknowledged it within 30 minutes");
    expect(s.onlyIf).toBeNull();
    expect(s.then).toEqual(["Tell Principal by email and ask them to acknowledge", "Mark the incident Level 2"]);
  });
  it("words hours and days", () => {
    const base = { conditions: {}, actions: [] };
    expect(describeRule({ ...base, trigger: "step_overdue", wait_minutes: 120 }, names).when).toBe("A required step is overdue by 2 hours");
    expect(describeRule({ ...base, trigger: "step_overdue", wait_minutes: 1440 }, names).when).toBe("A required step is overdue by 1 day");
  });
});

describe("recipes", () => {
  it("each builds a rule that passes validation against the starter roles", () => {
    const starter = ["principal", "head_of_sport", "school_nurse", "dpo", "safeguarding_lead", "facilities_manager", "reporter", "incident_lead", "parent_guardian"];
    for (const r of RECIPES) {
      expect(validateRule(r.build({ serious: "high" }), starter), r.key).toEqual([]);
    }
  });
  it("has unique keys, and keeps the parent recipe out of the starter set", () => {
    expect(new Set(RECIPES.map((r) => r.key)).size).toBe(RECIPES.length);
    expect(RECIPES.find((r) => r.key === "tell_parents_injury")!.inStarterSet).toBe(false);
  });
});

describe("planRules (Try it)", () => {
  const rules: IncidentRule[] = ["serious_injury", "remind_unacknowledged"].map((key, i) => ({
    id: `r${i}`,
    account_id: "a1",
    recipe_key: key,
    position: i,
    enabled: true,
    ...RECIPES.find((r) => r.key === key)!.build({ serious: "high" }),
  }));
  const people = (roleKey: string): ResolveResult =>
    roleKey === "school_nurse"
      ? { recipients: [], warnings: ["no_members"] }
      : { recipients: [{ contactId: "c", userId: null, name: "X", channel: "email", address: `${roleKey}@school.test`, roleKey }], warnings: [] };

  it("lists notices in time order with the escalation, and warns about an empty role", () => {
    const plan = planRules({ rules, facts: { category: "CCA", severity: "high", flags: ["injury"] }, resolveRole: people, roleName: names.role });
    expect(plan.notices.map((n) => [n.after, n.roleKey])).toEqual([[0, "head_of_sport"], [0, "school_nurse"], [30, "principal"]]);
    expect(plan.escalations).toEqual([{ ruleId: "r1", ruleName: expect.any(String), after: 30, level: 2 }]);
    expect(plan.warnings).toEqual(["School nurse has nobody in it"]);
  });
  it("ignores switched-off rules and rules that do not match", () => {
    const plan = planRules({ rules: rules.map((r) => ({ ...r, enabled: false })), facts: { category: "CCA", severity: "high", flags: ["injury"] }, resolveRole: people, roleName: names.role });
    expect(plan.notices).toEqual([]);
    const none = planRules({ rules, facts: { category: "CCA", severity: "low", flags: [] }, resolveRole: people, roleName: names.role });
    expect(none.notices.map((n) => n.ruleId)).toEqual(["r1"]);
  });
});

describe("roleForParty", () => {
  it("maps a step's party to the role that chases it", () => {
    expect(roleForParty("school_leadership")).toBe("principal");
    expect(roleForParty("pdp_commissioner")).toBe("dpo");
    expect(roleForParty("police")).toBeNull();
    expect(roleForParty(null)).toBeNull();
  });
});
