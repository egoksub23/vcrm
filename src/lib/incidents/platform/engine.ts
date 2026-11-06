// The incident notification engine. Events (a raised incident, a status change, the timer sweep) go in; message-log rows come out; the outbox sender
// hands them to channel adapters. All database access is behind `EngineStore`, so the logic is tested with an in-memory store.
//
//   event -> matching rules -> roles -> active members (order, away, backup) -> channel + address -> delivery row (queued) -> adapter.send -> sent / failed
//
// Rows are never sent twice: a rule tells the same address about the same thing once (unique key `deliveryKey`).

import { createHmac, timingSafeEqual } from "node:crypto";

import { buildNotice, type NoticeReason } from "./messages";
import type { AdapterMap } from "./adapters";
import { ruleMatches, roleForParty, STEP_ROLE, type IncidentRule, type RuleTrigger } from "./rules";
import {
  resolveRole,
  type ChannelKind,
  type DynamicPeople,
  type IncidentContact,
  type IncidentRole,
  type IncidentRoleMember,
  type Recipient,
} from "./roles";

export const MAX_ATTEMPTS = 5;

export interface EngineIncident {
  id: string;
  account_id: string;
  /** INC-2026-31 */
  reference: string;
  category: string;
  severity: string;
  flags: string[];
  status: string;
  escalation_level: number;
  is_test: boolean;
}

export interface Directory {
  roles: IncidentRole[];
  members: IncidentRoleMember[];
  contacts: IncidentContact[];
}

export interface NewDelivery {
  account_id: string;
  incident_id: string;
  rule_id: string | null;
  role_key: string;
  contact_id: string | null;
  recipient_name: string;
  channel: ChannelKind;
  address: string;
  reason: NoticeReason;
  ask_ack: boolean;
  ref_key: string;
  is_test: boolean;
}

export interface DeliveryRow extends NewDelivery {
  id: string;
  attempts: number;
  status: "queued" | "sending" | "sent" | "failed" | "skipped" | "acknowledged";
}

export interface IncidentLabels {
  categoryName: string;
  severityName: string;
}

export interface OverdueStep {
  obligationId: string;
  incidentId: string;
  party: string | null;
}

export interface EngineStore {
  loadIncident(incidentId: string): Promise<EngineIncident | null>;
  loadRules(accountId: string, trigger: RuleTrigger): Promise<IncidentRule[]>;
  loadDirectory(accountId: string): Promise<Directory>;
  loadDynamicPeople(incidentId: string): Promise<DynamicPeople>;
  /** Used for reports made with a test key: only these people are told. */
  loadTestRecipients(accountId: string): Promise<Recipient[]>;
  loadLabels(incident: EngineIncident): Promise<IncidentLabels>;
  existingKeys(incidentId: string): Promise<Set<string>>;
  insertDeliveries(rows: NewDelivery[]): Promise<DeliveryRow[]>;
  /** Marks due rows as 'sending' and returns them (so two sweeps never send the same row). */
  claimDue(now: Date, limit: number): Promise<DeliveryRow[]>;
  markSent(id: string, now: Date, providerRef: string | null): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: Date | null): Promise<void>;
  raiseEscalationLevel(incidentId: string, level: 2 | 3): Promise<boolean>;
  /** Incidents with an acknowledge-asking notice sent at or before `askedBefore`, still unacknowledged and not closed. */
  listUnacknowledged(accountId: string, askedBefore: Date, limit: number): Promise<string[]>;
  /** Incidents not closed that were raised at or before `openedBefore` (the "resolve by" timer). */
  listUnresolved(accountId: string, openedBefore: Date, limit: number): Promise<string[]>;
  /** Open required steps that became overdue at or before `dueBefore`, on incidents that are not closed. */
  listOverdueSteps(accountId: string, dueBefore: Date, limit: number): Promise<OverdueStep[]>;
  appUrl(): string | null;
  senderName(accountId: string): Promise<string | null>;
  now(): Date;
}

export const deliveryKey = (ruleId: string | null, roleKey: string, channel: string, address: string, refKey: string) =>
  `${ruleId ?? "-"}|${roleKey}|${channel}|${address.toLowerCase()}|${refKey}`;

const REASON: Record<RuleTrigger, NoticeReason> = {
  raised: "raised",
  unacknowledged: "reminder",
  step_overdue: "step_overdue",
  unresolved: "reminder",
  closed: "closed",
};

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

// ---- acknowledge links ------------------------------------------------------------------------------------------

function ackSecret(): string {
  return process.env.INCIDENT_ACK_SECRET || process.env.AUTOMATION_CRON_SECRET || process.env.AUTH_SECRET || "";
}

/** A signed token for one delivery: `<id>.<hmac>`. Nothing secret is stored; the link works for people with no login. */
export function ackToken(deliveryId: string, secret = ackSecret()): string {
  const mac = createHmac("sha256", secret).update(`incident-ack:${deliveryId}`).digest("hex").slice(0, 32);
  return `${deliveryId}.${mac}`;
}

/** The delivery id a token names, or null when the token is not one we signed (or no secret is set). */
export function verifyAckToken(token: string, secret = ackSecret()): string | null {
  if (!secret) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = Buffer.from(ackToken(id, secret));
  const given = Buffer.from(token);
  if (expected.length !== given.length) return null;
  return timingSafeEqual(expected, given) ? id : null;
}

// ---- running a trigger ------------------------------------------------------------------------------------------

export interface TriggerResult {
  /** New message-log rows. */
  queued: number;
  /** Roles that could not be told, with the reason, so the incident can show it. */
  warnings: { roleKey: string; warning: string }[];
  escalatedTo: number | null;
}

/**
 * Apply every enabled rule for `trigger` to one incident. `only` limits it to one rule (the sweep runs timed rules one at a time). `refKey` and
 * `stepParty` identify an overdue step, so each step is chased once per rule and the step's role is told.
 */
export async function runTrigger(
  store: EngineStore,
  args: { incidentId: string; trigger: RuleTrigger; only?: string; refKey?: string; stepParty?: string | null },
): Promise<TriggerResult> {
  const result: TriggerResult = { queued: 0, warnings: [], escalatedTo: null };
  const incident = await store.loadIncident(args.incidentId);
  if (!incident) return result;

  const rules = (await store.loadRules(incident.account_id, args.trigger)).filter((r) => r.enabled && (!args.only || r.id === args.only));
  const facts = { category: incident.category, severity: incident.severity, flags: incident.flags };
  const matching = rules.filter((r) => ruleMatches(r.conditions, facts));
  if (matching.length === 0) return result;

  const [directory, dynamic, existing] = await Promise.all([
    store.loadDirectory(incident.account_id),
    store.loadDynamicPeople(incident.id),
    store.existingKeys(incident.id),
  ]);
  const testPeople = incident.is_test ? await store.loadTestRecipients(incident.account_id) : null;
  const today = dayOf(store.now());
  const refKey = args.refKey ?? "";
  const rows: NewDelivery[] = [];
  // One notice per address per event: two rules that both tell the nurse (a concussion and a serious injury) send her one message, which asks for an
  // acknowledgement if either rule does.
  const byAddress = new Map<string, NewDelivery>();

  for (const rule of matching) {
    for (const action of rule.actions) {
      if (action.type === "escalate") {
        const raised = await store.raiseEscalationLevel(incident.id, action.level);
        if (raised) result.escalatedTo = Math.max(result.escalatedTo ?? 0, action.level);
        continue;
      }
      const roleKey = action.role_key === STEP_ROLE ? (roleForParty(args.stepParty) ?? "incident_lead") : action.role_key;
      const role = directory.roles.find((r) => r.key === roleKey);
      if (!role) {
        result.warnings.push({ roleKey, warning: "no_such_role" });
        continue;
      }
      const resolved = testPeople
        ? { recipients: testPeople.map((p) => ({ ...p, roleKey })), warnings: [] }
        : resolveRole({ role, members: directory.members.filter((m) => m.role_id === role.id), contacts: directory.contacts, dynamic, today });
      for (const w of resolved.warnings) result.warnings.push({ roleKey, warning: w });
      for (const rcpt of resolved.recipients) {
        const key = deliveryKey(rule.id, roleKey, rcpt.channel, rcpt.address, refKey);
        if (existing.has(key)) continue;
        existing.add(key);
        const sameAddress = byAddress.get(`${rcpt.channel}|${rcpt.address.toLowerCase()}`);
        if (sameAddress) {
          sameAddress.ask_ack = sameAddress.ask_ack || Boolean(action.ask_ack);
          continue;
        }
        const row: NewDelivery = {
          account_id: incident.account_id,
          incident_id: incident.id,
          rule_id: rule.id,
          role_key: roleKey,
          contact_id: rcpt.contactId,
          recipient_name: rcpt.name,
          channel: rcpt.channel,
          address: rcpt.address,
          reason: incident.is_test ? "test" : REASON[args.trigger],
          ask_ack: Boolean(action.ask_ack),
          ref_key: refKey,
          is_test: incident.is_test,
        };
        byAddress.set(`${rcpt.channel}|${rcpt.address.toLowerCase()}`, row);
        rows.push(row);
      }
    }
  }
  if (rows.length > 0) result.queued = (await store.insertDeliveries(rows)).length;
  return result;
}

// ---- the outbox -------------------------------------------------------------------------------------------------

export interface DispatchSummary {
  sent: number;
  failed: number;
}

/** Backoff after a failed attempt: 2, 4, 8, 16 minutes. Null once the attempts are used up. */
export function nextAttemptAfter(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + 2 ** attempts * 60_000);
}

/** Send what is due. A failure is recorded on the row and retried with backoff; nothing here throws. */
export async function dispatchDue(store: EngineStore, adapters: AdapterMap, limit = 50): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, failed: 0 };
  const now = store.now();
  const due = await store.claimDue(now, limit);
  const base = store.appUrl();
  const incidentCache = new Map<string, { incident: EngineIncident; labels: IncidentLabels } | null>();

  for (const row of due) {
    const attempts = row.attempts + 1;
    const fail = async (error: string, retryable = true) => {
      await store.markFailed(row.id, error, retryable ? nextAttemptAfter(attempts, now) : null);
      summary.failed += 1;
    };
    try {
      const adapter = adapters[row.channel];
      if (!adapter) {
        await fail(`No way to send ${row.channel} messages yet`, false);
        continue;
      }
      if (!base) {
        await fail("The Halo address is not set (NEXT_PUBLIC_SITE_URL), so links cannot be built", false);
        continue;
      }
      let cached = incidentCache.get(row.incident_id);
      if (cached === undefined) {
        const incident = await store.loadIncident(row.incident_id);
        cached = incident ? { incident, labels: await store.loadLabels(incident) } : null;
        incidentCache.set(row.incident_id, cached);
      }
      if (!cached) {
        await fail("The incident no longer exists", false);
        continue;
      }
      const root = base.replace(/\/+$/, "");
      const notice = buildNotice({
        reference: cached.incident.reference,
        categoryName: cached.labels.categoryName,
        severityName: cached.labels.severityName,
        reason: row.reason,
        incidentUrl: `${root}/incidents/${row.incident_id}`,
        ackUrl: row.ask_ack ? `${root}/incident-ack/${ackToken(row.id)}` : null,
        isTest: row.is_test,
        senderName: await store.senderName(row.account_id),
      });
      const sent = await adapter.send({ accountId: row.account_id, to: row.address, notice });
      if (sent.ok) {
        await store.markSent(row.id, store.now(), sent.providerRef ?? null);
        summary.sent += 1;
      } else {
        await fail(sent.error, sent.retryable);
      }
    } catch (err) {
      await fail(err instanceof Error ? err.message : "Unexpected error while sending");
    }
  }
  return summary;
}

// ---- timers -----------------------------------------------------------------------------------------------------

export interface SweepSummary {
  unacknowledged: number;
  overdueSteps: number;
  unresolved: number;
}

/** Run the rules that wait for something: nobody acknowledged in time, a required step overdue. Safe to run every minute. */
export async function sweepTimers(store: EngineStore, accountIdsWithRules: readonly string[], limit = 100): Promise<SweepSummary> {
  const summary: SweepSummary = { unacknowledged: 0, overdueSteps: 0, unresolved: 0 };
  const now = store.now();

  for (const accountId of accountIdsWithRules) {
    const unack = (await store.loadRules(accountId, "unacknowledged")).filter((r) => r.enabled);
    for (const rule of unack) {
      const askedBefore = new Date(now.getTime() - (rule.wait_minutes ?? 0) * 60_000);
      const ids = await store.listUnacknowledged(accountId, askedBefore, limit);
      for (const incidentId of ids) {
        const out = await runTrigger(store, { incidentId, trigger: "unacknowledged", only: rule.id });
        if (out.queued > 0 || out.escalatedTo) summary.unacknowledged += 1;
      }
    }
    const unresolved = (await store.loadRules(accountId, "unresolved")).filter((r) => r.enabled);
    for (const rule of unresolved) {
      const openedBefore = new Date(now.getTime() - (rule.wait_minutes ?? 0) * 60_000);
      for (const incidentId of await store.listUnresolved(accountId, openedBefore, limit)) {
        const out = await runTrigger(store, { incidentId, trigger: "unresolved", only: rule.id });
        if (out.queued > 0 || out.escalatedTo) summary.unresolved += 1;
      }
    }
    const overdue = (await store.loadRules(accountId, "step_overdue")).filter((r) => r.enabled);
    for (const rule of overdue) {
      const dueBefore = new Date(now.getTime() - (rule.wait_minutes ?? 0) * 60_000);
      const steps = await store.listOverdueSteps(accountId, dueBefore, limit);
      for (const step of steps) {
        const out = await runTrigger(store, {
          incidentId: step.incidentId,
          trigger: "step_overdue",
          only: rule.id,
          refKey: step.obligationId,
          stepParty: step.party,
        });
        if (out.queued > 0) summary.overdueSteps += 1;
      }
    }
  }
  return summary;
}
