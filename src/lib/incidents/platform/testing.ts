// Shared in-memory pieces for the engine's tests: a store that keeps everything in arrays, a small school (roles, people, rules) and an email adapter that records.
import type { AdapterMap, ChannelAdapter } from "./adapters";
import type { DeliveryRow, Directory, EngineIncident, EngineStore, NewDelivery, OverdueStep } from "./engine";
import { RECIPES, type IncidentRule } from "./rules";
import type { DynamicPeople, IncidentContact, IncidentRole, IncidentRoleMember, Recipient } from "./roles";

export const NOW = new Date("2026-11-11T10:00:00Z");

export const role = (key: string, over: Partial<IncidentRole> = {}): IncidentRole => ({
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
export const contact = (id: string, over: Partial<IncidentContact> = {}): IncidentContact => ({
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
export const member = (roleKey: string, contactId: string, position = 1): IncidentRoleMember => ({
  id: `m-${roleKey}-${contactId}`,
  account_id: "a1",
  role_id: `role-${roleKey}`,
  contact_id: contactId,
  position,
  away_from: null,
  away_to: null,
  is_backup: false,
});

export function ruleFromRecipe(key: string, id: string, over: Partial<IncidentRule> = {}): IncidentRule {
  const draft = RECIPES.find((r) => r.key === key)!.build({ serious: "high" });
  return { id, account_id: "a1", recipe_key: key, position: 0, enabled: true, ...draft, ...over };
}

export class MemoryStore implements EngineStore {
  incidents = new Map<string, EngineIncident>();
  rules: IncidentRule[] = [];
  directory: Directory = { roles: [], members: [], contacts: [] };
  dynamic: DynamicPeople = {};
  testPeople: Recipient[] = [];
  deliveries: DeliveryRow[] = [];
  errors = new Map<string, string>();
  nextAt = new Map<string, Date | null>();
  unacknowledged: string[] = [];
  unresolved: string[] = [];
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
  async markSent(id: string, _now?: Date) {
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
  async listUnacknowledged(_account?: string, _askedBefore?: Date) {
    return this.unacknowledged;
  }
  async listUnresolved() {
    return this.unresolved;
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
  /** Tests move this to let time pass. */
  clock = new Date(NOW);
  now() {
    return new Date(this.clock);
  }
}

export function seeded(): MemoryStore {
  const s = new MemoryStore();
  s.incidents.set("i1", { id: "i1", account_id: "a1", reference: "INC-2026-31", category: "CCA", severity: "high", flags: ["injury", "child_involved"], status: "reported", escalation_level: 1, is_test: false });
  s.directory = {
    roles: [role("head_of_sport"), role("school_nurse"), role("principal"), role("incident_lead", { kind: "per_incident", dynamic_source: "incident_lead" }), role("reporter", { kind: "per_incident", dynamic_source: "reporter" }), role("dpo")],
    members: [member("head_of_sport", "rahim"), member("school_nurse", "aminah"), member("principal", "head")],
    contacts: [contact("rahim"), contact("aminah"), contact("head")],
  };
  return s;
}

export const okAdapter = (calls: { to: string; subject: string; text: string }[] = []): AdapterMap => ({
  email: {
    channel: "email",
    async send({ to, notice }) {
      calls.push({ to, subject: notice.subject, text: notice.text });
      return { ok: true, providerRef: "test" };
    },
  } satisfies ChannelAdapter,
});

