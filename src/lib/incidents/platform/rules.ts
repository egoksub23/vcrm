// Incident notification rules (migration 209). A rule reads as one sentence: WHEN something happens, ONLY IF the incident matches, THEN tell a role.
// Pure: matching, wording, the recipe library and the "Try it" plan are all functions of their inputs, so they are tested without a database.

import { severityRank } from "@/lib/incidents/constants";
import type { ResolveResult, ResolveWarning } from "./roles";

export const RULE_TRIGGERS = ["raised", "unacknowledged", "step_overdue", "closed"] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

/** The role a step's `party` points at: used by the rule "tell the step's role". */
export const STEP_ROLE = "$step_role";

export interface RuleConditions {
  /** Any of these category codes. Empty or missing = any category. */
  categories?: string[];
  /** This severity or worse (by the template's scale). Missing = any severity. */
  min_severity?: string | null;
  /** Any of these flags (injury, personal_data ...). Empty or missing = no flag needed. */
  flags?: string[];
}

export type RuleAction =
  | { type: "notify"; role_key: string; ask_ack?: boolean }
  | { type: "escalate"; level: 2 | 3 };

export interface IncidentRule {
  id: string;
  account_id: string;
  recipe_key: string | null;
  name: string;
  trigger: RuleTrigger;
  /** Minutes after the trigger moment: used by unacknowledged and step_overdue. */
  wait_minutes: number | null;
  conditions: RuleConditions;
  actions: RuleAction[];
  enabled: boolean;
  position: number;
}

/** What a rule looks at on an incident. */
export interface IncidentFacts {
  category: string;
  severity: string;
  flags: readonly string[];
}

export function ruleMatches(conditions: RuleConditions, facts: IncidentFacts): boolean {
  const cats = conditions.categories ?? [];
  if (cats.length > 0 && !cats.includes(facts.category)) return false;
  const flags = conditions.flags ?? [];
  if (flags.length > 0 && !flags.some((f) => facts.flags.includes(f))) return false;
  if (conditions.min_severity) {
    if (severityRank(facts.severity) > severityRank(conditions.min_severity)) return false;
  }
  return true;
}

// ---- validation -------------------------------------------------------------------------------------------------

export interface RuleDraft {
  name: string;
  trigger: RuleTrigger;
  wait_minutes: number | null;
  conditions: RuleConditions;
  actions: RuleAction[];
}

/** Plain-words problems with a rule, empty when it is fine. `knownRoles` are the keys of the school's roles. */
export function validateRule(draft: RuleDraft, knownRoles: readonly string[]): string[] {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push("Give the rule a name.");
  if (!RULE_TRIGGERS.includes(draft.trigger)) problems.push("Pick when the rule applies.");
  const timed = draft.trigger === "unacknowledged" || draft.trigger === "step_overdue";
  if (timed) {
    const w = draft.wait_minutes;
    if (w == null || !Number.isInteger(w) || w < 1 || w > 60 * 24 * 30) problems.push("Say how long to wait, between 1 minute and 30 days.");
  } else if (draft.wait_minutes != null) {
    problems.push("Only rules that wait for something have a wait time.");
  }
  if (draft.actions.length === 0) problems.push("Say what should happen.");
  for (const a of draft.actions) {
    if (a.type === "notify") {
      if (a.role_key !== STEP_ROLE && !knownRoles.includes(a.role_key)) problems.push(`There is no role "${a.role_key}".`);
      if (a.role_key === STEP_ROLE && draft.trigger !== "step_overdue") problems.push("\"The step's role\" only makes sense for an overdue step.");
    } else if (a.type === "escalate") {
      if (a.level !== 2 && a.level !== 3) problems.push("Escalate to level 2 or 3.");
      if (draft.trigger === "step_overdue") problems.push("An overdue step cannot escalate the incident.");
    } else {
      problems.push("Unknown action.");
    }
  }
  return problems;
}

// ---- the sentence -----------------------------------------------------------------------------------------------

export interface Namer {
  role: (key: string) => string;
  category: (code: string) => string;
  severity: (slug: string) => string;
  flag: (flag: string) => string;
}

export interface Sentence {
  when: string;
  onlyIf: string | null;
  then: string[];
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function minutesText(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} ${m / 1440 === 1 ? "day" : "days"}`;
  if (m % 60 === 0) return `${m / 60} ${m / 60 === 1 ? "hour" : "hours"}`;
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

/** The rule as three short lines of plain words. */
export function describeRule(rule: Pick<IncidentRule, "trigger" | "wait_minutes" | "conditions" | "actions">, names: Namer): Sentence {
  const w = rule.wait_minutes ?? 0;
  const when =
    rule.trigger === "raised"
      ? "An incident is raised"
      : rule.trigger === "closed"
        ? "An incident is closed"
        : rule.trigger === "unacknowledged"
          ? `Nobody has acknowledged it within ${minutesText(w)}`
          : `A required step is overdue by ${minutesText(w)}`;

  const parts: string[] = [];
  const c = rule.conditions;
  if (c.categories?.length) parts.push(`the category is ${list(c.categories.map(names.category))}`);
  if (c.flags?.length) parts.push(`it involves ${list(c.flags.map(names.flag).map((f) => f.toLowerCase()))}`);
  if (c.min_severity) parts.push(`the severity is ${names.severity(c.min_severity)} or worse`);
  const onlyIf = parts.length ? `Only if ${parts.join(" and ")}` : null;

  const then = rule.actions.map((a) => {
    if (a.type === "notify") {
      const who = a.role_key === STEP_ROLE ? "the role named on the step" : names.role(a.role_key);
      return a.ask_ack ? `Tell ${who} by email and ask them to acknowledge` : `Tell ${who} by email`;
    }
    return `Mark the incident Level ${a.level}`;
  });
  return { when, onlyIf, then };
}

// ---- recipes ----------------------------------------------------------------------------------------------------

export interface Recipe {
  key: string;
  name: string;
  description: string;
  /** The starter set switches on the ones marked true. Others are offered but stay off until the school chooses. */
  inStarterSet: boolean;
  /** Plain note shown on the recipe when it needs something the school may not have yet. */
  needs?: string;
  build: (scale: { serious: string }) => RuleDraft;
}

export const RECIPES: readonly Recipe[] = [
  {
    key: "serious_injury",
    name: "Tell Head of Sport and the nurse about serious injuries",
    description: "As soon as a serious injury is reported, the two people who act on it are told and asked to acknowledge.",
    inStarterSet: true,
    build: ({ serious }) => ({
      name: "Serious injuries: tell Head of Sport and the nurse",
      trigger: "raised",
      wait_minutes: null,
      conditions: { flags: ["injury"], min_severity: serious },
      actions: [
        { type: "notify", role_key: "head_of_sport", ask_ack: true },
        { type: "notify", role_key: "school_nurse", ask_ack: true },
      ],
    }),
  },
  {
    key: "remind_unacknowledged",
    name: "Remind me if nobody acknowledges",
    description: "If a notice is not acknowledged in 30 minutes, tell the Principal and raise the incident to Level 2.",
    inStarterSet: true,
    build: () => ({
      name: "Nobody acknowledged: tell the Principal",
      trigger: "unacknowledged",
      wait_minutes: 30,
      conditions: {},
      actions: [
        { type: "notify", role_key: "principal", ask_ack: true },
        { type: "escalate", level: 2 },
      ],
    }),
  },
  {
    key: "personal_data",
    name: "Tell the data protection officer about personal-data incidents",
    description: "Anything that involves personal data goes to the DPO straight away, because the PDPA clocks start at once.",
    inStarterSet: true,
    build: () => ({
      name: "Personal data: tell the DPO",
      trigger: "raised",
      wait_minutes: null,
      conditions: { flags: ["personal_data"] },
      actions: [{ type: "notify", role_key: "dpo", ask_ack: true }],
    }),
  },
  {
    key: "property_damage",
    name: "Tell the facilities manager about property damage",
    description: "Damage to school property goes to the person who arranges the repair.",
    inStarterSet: true,
    build: () => ({
      name: "Property damage: tell facilities",
      trigger: "raised",
      wait_minutes: null,
      conditions: { flags: ["property_damage"] },
      actions: [{ type: "notify", role_key: "facilities_manager" }],
    }),
  },
  {
    key: "safeguarding",
    name: "Tell the safeguarding lead and the Principal about child-protection concerns",
    description: "A safeguarding concern is never left waiting.",
    inStarterSet: true,
    build: () => ({
      name: "Safeguarding: tell the lead and the Principal",
      trigger: "raised",
      wait_minutes: null,
      conditions: { flags: ["safeguarding"] },
      actions: [
        { type: "notify", role_key: "safeguarding_lead", ask_ack: true },
        { type: "notify", role_key: "principal", ask_ack: true },
      ],
    }),
  },
  {
    key: "confirm_reporter",
    name: "Confirm to the reporter",
    description: "The person who reported it gets the reference number by email.",
    inStarterSet: true,
    build: () => ({
      name: "Confirm to the reporter",
      trigger: "raised",
      wait_minutes: null,
      conditions: {},
      actions: [{ type: "notify", role_key: "reporter" }],
    }),
  },
  {
    key: "step_overdue",
    name: "Chase overdue required steps",
    description: "One hour after a step is overdue, tell the role it was given to and the incident lead.",
    inStarterSet: true,
    build: () => ({
      name: "Overdue step: tell its role and the lead",
      trigger: "step_overdue",
      wait_minutes: 60,
      conditions: {},
      actions: [
        { type: "notify", role_key: STEP_ROLE },
        { type: "notify", role_key: "incident_lead" },
      ],
    }),
  },
  {
    key: "tell_parents_injury",
    name: "Tell parents about injuries",
    description: "Sends parents or guardians a short notice when a student is injured.",
    inStarterSet: false,
    needs: "Needs parent or guardian email addresses from the coach portal. Until they arrive, staff tell parents and this rule stays off.",
    build: () => ({
      name: "Injury: tell the parent or guardian",
      trigger: "raised",
      wait_minutes: null,
      conditions: { flags: ["injury", "child_involved"] },
      actions: [{ type: "notify", role_key: "parent_guardian" }],
    }),
  },
  {
    key: "closed_review",
    name: "Tell the Principal when a serious incident is closed",
    description: "A closing note for the person who has to answer for the incident.",
    inStarterSet: false,
    build: ({ serious }) => ({
      name: "Serious incident closed: tell the Principal",
      trigger: "closed",
      wait_minutes: null,
      conditions: { min_severity: serious },
      actions: [{ type: "notify", role_key: "principal" }],
    }),
  },
];

export function recipeByKey(key: string): Recipe | undefined {
  return RECIPES.find((r) => r.key === key);
}

// ---- Try it: what would happen --------------------------------------------------------------------------------

export interface PlannedNotice {
  ruleId: string;
  ruleName: string;
  /** "now" for a rule that fires on the event; otherwise the wait in minutes after the event. */
  after: number;
  roleKey: string;
  askAck: boolean;
  resolve: ResolveResult;
}
export interface PlannedEscalation {
  ruleId: string;
  ruleName: string;
  after: number;
  level: 2 | 3;
}
export interface Plan {
  notices: PlannedNotice[];
  escalations: PlannedEscalation[];
  /** Plain-words warnings, for example "Head of Sport has nobody in it". */
  warnings: string[];
}

export const WARNING_TEXT: Record<ResolveWarning, string> = {
  no_members: "has nobody in it",
  everyone_away: "has everyone away today and no backup",
  no_address: "has someone with no email address",
  no_people_on_incident: "has nobody on this incident",
};

/**
 * What the enabled rules would do for an incident, without sending anything. `trigger` is the moment being tried: a raised incident shows the
 * immediate notices and the timed ones that would follow. `resolveRole` turns a role key into the people who would be told now.
 */
export function planRules(args: {
  rules: readonly IncidentRule[];
  facts: IncidentFacts;
  resolveRole: (roleKey: string) => ResolveResult;
  roleName: (roleKey: string) => string;
  stepRoleKey?: string | null;
}): Plan {
  const plan: Plan = { notices: [], escalations: [], warnings: [] };
  const seen = new Set<string>();
  const ordered = [...args.rules].filter((r) => r.enabled).sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    // Tried against a freshly raised incident: "raised" fires now, "unacknowledged" and "step_overdue" follow later. "closed" is a different moment.
    if (rule.trigger === "closed") continue;
    if (!ruleMatches(rule.conditions, args.facts)) continue;
    const after = rule.trigger === "raised" ? 0 : (rule.wait_minutes ?? 0);
    for (const action of rule.actions) {
      if (action.type === "escalate") {
        plan.escalations.push({ ruleId: rule.id, ruleName: rule.name, after, level: action.level });
        continue;
      }
      const roleKey = action.role_key === STEP_ROLE ? (args.stepRoleKey ?? "incident_lead") : action.role_key;
      const resolve = args.resolveRole(roleKey);
      plan.notices.push({ ruleId: rule.id, ruleName: rule.name, after, roleKey, askAck: Boolean(action.ask_ack), resolve });
      for (const w of resolve.warnings) {
        const text = `${args.roleName(roleKey)} ${WARNING_TEXT[w]}`;
        if (!seen.has(text)) {
          seen.add(text);
          plan.warnings.push(text);
        }
      }
    }
  }
  plan.notices.sort((a, b) => a.after - b.after);
  plan.escalations.sort((a, b) => a.after - b.after);
  return plan;
}

/** Map a required step's `party` (migration 206) to the role that should chase it. */
export function roleForParty(party: string | null | undefined): string | null {
  switch (party) {
    case "school_leadership":
      return "principal";
    case "parent_guardian":
      return "parent_guardian";
    case "pdp_commissioner":
    case "data_subjects":
      return "dpo";
    default:
      return null;
  }
}
