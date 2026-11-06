// The engine's store on Halo's PostgreSQL (admin connection: the engine runs on the server for the school, never as a browser user).

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { incidentKey } from "@/lib/incidents/types";
import type {
  DeliveryRow,
  Directory,
  EngineIncident,
  EngineStore,
  IncidentLabels,
  NewDelivery,
  OverdueStep,
} from "./engine";
import type { IncidentRule, RuleTrigger } from "./rules";
import type { DynamicPeople, DynamicPerson, Recipient } from "./roles";

/** `PgDb.rpc` returns null for no rows, a bare value for one single-column row, an object for one row, an array for several. Make it a list. */
export function rpcRows<T>(data: unknown): T[] {
  if (data == null) return [];
  return (Array.isArray(data) ? data : [data]) as T[];
}

/** Ids from a function that returns `setof uuid`, in any of the shapes `rpc` gives. */
export function rpcIds(data: unknown): string[] {
  return rpcRows<unknown>(data)
    .map((v) => (typeof v === "string" ? v : v && typeof v === "object" ? (Object.values(v as Record<string, unknown>)[0] as string) : null))
    .filter((v): v is string => typeof v === "string");
}

type Row = Record<string, unknown>;

export class PgEngineStore implements EngineStore {
  constructor(private readonly db: PgDb = createAdminPgDb()) {}

  async loadIncident(incidentId: string): Promise<EngineIncident | null> {
    const { data } = await this.db.from("incidents").select("*").eq("id", incidentId).maybeSingle();
    const r = data as Row | null;
    if (!r) return null;
    return {
      id: r.id as string,
      account_id: r.account_id as string,
      reference: incidentKey({ created_at: r.created_at as string, incident_number: r.incident_number as number }),
      category: r.incident_type as string,
      severity: r.severity as string,
      flags: (r.incident_flags as string[] | null) ?? [],
      status: r.status as string,
      escalation_level: (r.escalation_level as number) ?? 1,
      // Added in migration 210 (coach-portal test key); absent before it is applied.
      is_test: r.is_test === true,
    };
  }

  async loadRules(accountId: string, trigger: RuleTrigger): Promise<IncidentRule[]> {
    const { data } = await this.db
      .from("incident_rules")
      .select("*")
      .eq("account_id", accountId)
      .eq("trigger", trigger)
      .eq("enabled", true)
      .order("position");
    return (data ?? []) as IncidentRule[];
  }

  async loadDirectory(accountId: string): Promise<Directory> {
    const [roles, members, contacts] = await Promise.all([
      this.db.from("incident_roles").select("*").eq("account_id", accountId),
      this.db.from("incident_role_members").select("*").eq("account_id", accountId),
      this.db.from("incident_contacts").select("*").eq("account_id", accountId),
    ]);
    return {
      roles: (roles.data ?? []) as Directory["roles"],
      members: (members.data ?? []) as Directory["members"],
      contacts: (contacts.data ?? []) as Directory["contacts"],
    };
  }

  private async profile(userId: string | null | undefined): Promise<DynamicPerson | null> {
    if (!userId) return null;
    const { data } = await this.db.from("profiles").select("user_id, full_name, email").eq("user_id", userId).maybeSingle();
    const p = data as { user_id: string; full_name: string | null; email: string | null } | null;
    if (!p?.email) return null;
    return { name: p.full_name || p.email, emails: [p.email], phones: [], userId: p.user_id };
  }

  async loadDynamicPeople(incidentId: string): Promise<DynamicPeople> {
    const { data } = await this.db.from("incidents").select("*").eq("id", incidentId).maybeSingle();
    const inc = data as Row | null;
    if (!inc) return {};
    const out: DynamicPeople = {};

    const reporters: DynamicPerson[] = [];
    // People who reported through the coach portal have no login: their contact is on the incident (migration 210).
    if (typeof inc.reporter_email === "string" && inc.reporter_email.trim()) {
      reporters.push({
        name: (inc.reporter_name as string | null) || (inc.reporter_email as string),
        emails: [inc.reporter_email as string],
        phones: typeof inc.reporter_phone === "string" && inc.reporter_phone ? [inc.reporter_phone] : [],
      });
    } else {
      const p = await this.profile(inc.reporter_id as string | null);
      if (p) reporters.push(p);
    }
    if (reporters.length) out.reporter = reporters;

    const lead = await this.profile(inc.incident_lead_id as string | null);
    if (lead) out.incident_lead = [lead];

    // Parents and guardians named on the report (migration 210, snapshot of the roster the portal sent).
    const { data: involved } = await this.db.from("incident_involved").select("guardians").eq("incident_id", incidentId);
    const guardians: DynamicPerson[] = [];
    for (const row of (involved ?? []) as { guardians: { name?: string; email?: string; phone?: string }[] | null }[]) {
      for (const g of row.guardians ?? []) {
        if (!g.email && !g.phone) continue;
        guardians.push({ name: g.name || "Parent or guardian", emails: g.email ? [g.email] : [], phones: g.phone ? [g.phone] : [] });
      }
    }
    if (guardians.length) out.guardian = guardians;
    return out;
  }

  async loadTestRecipients(accountId: string): Promise<Recipient[]> {
    const { data } = await this.db
      .from("profiles")
      .select("user_id, full_name, email, account_role")
      .eq("account_id", accountId)
      .in("account_role", ["owner", "admin"]);
    return ((data ?? []) as { user_id: string; full_name: string | null; email: string | null }[])
      .filter((p) => p.email)
      .map((p) => ({ contactId: null, userId: p.user_id, name: p.full_name || (p.email as string), channel: "email" as const, address: p.email as string, roleKey: "test" }));
  }

  async loadLabels(incident: EngineIncident): Promise<IncidentLabels> {
    const { data } = await this.db.from("incidents").select("standard_id").eq("id", incident.id).maybeSingle();
    const standardId = (data as { standard_id: string | null } | null)?.standard_id ?? null;
    let categoryName = incident.category;
    let severityName = incident.severity;
    if (standardId) {
      const [type, sev] = await Promise.all([
        this.db.from("incident_type_catalogue").select("name").eq("standard_id", standardId).eq("code", incident.category).maybeSingle(),
        this.db.from("incident_severity_levels").select("label").eq("standard_id", standardId).eq("slug", incident.severity).maybeSingle(),
      ]);
      categoryName = (type.data as { name: string } | null)?.name ?? categoryName;
      severityName = (sev.data as { label: string } | null)?.label ?? severityName;
    }
    return { categoryName, severityName };
  }

  async existingKeys(incidentId: string): Promise<Set<string>> {
    const { data } = await this.db.from("incident_deliveries").select("rule_id, role_key, channel, address, ref_key").eq("incident_id", incidentId);
    return new Set(
      ((data ?? []) as { rule_id: string | null; role_key: string; channel: string; address: string; ref_key: string }[]).map(
        (d) => `${d.rule_id ?? "-"}|${d.role_key}|${d.channel}|${d.address.toLowerCase()}|${d.ref_key}`,
      ),
    );
  }

  async insertDeliveries(rows: NewDelivery[]): Promise<DeliveryRow[]> {
    let kept: DeliveryRow[] = [];
    const batch = await this.db.from("incident_deliveries").insert(rows as unknown as Record<string, unknown>[]).select("*");
    if (!batch.error) {
      kept = (batch.data ?? []) as DeliveryRow[];
    } else {
      // A concurrent run inserted the same message first (unique index): insert one by one and keep what is new.
      for (const row of rows) {
        const one = await this.db.from("incident_deliveries").insert(row as unknown as Record<string, unknown>).select("*");
        if (!one.error && one.data) kept.push(...(one.data as DeliveryRow[]));
      }
    }
    await this.watchRecipients(kept);
    return kept;
  }

  /**
   * A person who is told about an incident and has a Halo login must be able to open it from the link: row-level security lets a watcher read an
   * incident, so recipients who are Halo users are added as watchers. Best effort; a failure only means the link asks them to ask a manager.
   */
  private async watchRecipients(rows: DeliveryRow[]): Promise<void> {
    try {
      const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => Boolean(id)))];
      if (contactIds.length === 0) return;
      const { data } = await this.db.from("incident_contacts").select("id, user_id").in("id", contactIds);
      const userOf = new Map(((data ?? []) as { id: string; user_id: string | null }[]).filter((c) => c.user_id).map((c) => [c.id, c.user_id as string]));
      const seen = new Set<string>();
      const watchers: Record<string, unknown>[] = [];
      for (const r of rows) {
        const userId = r.contact_id ? userOf.get(r.contact_id) : undefined;
        if (!userId || seen.has(`${r.incident_id}|${userId}`)) continue;
        seen.add(`${r.incident_id}|${userId}`);
        watchers.push({ incident_id: r.incident_id, user_id: userId, account_id: r.account_id });
      }
      if (watchers.length) await this.db.from("incident_watchers").upsert(watchers, { onConflict: "incident_id,user_id", ignoreDuplicates: true });
    } catch (err) {
      console.error("[incident-engine] could not add watchers:", err);
    }
  }

  async claimDue(_now: Date, limit: number): Promise<DeliveryRow[]> {
    const { data, error } = await this.db.rpc("claim_incident_deliveries", { p_limit: limit });
    if (error) {
      console.error("[incident-engine] claim failed:", error.message);
      return [];
    }
    return rpcRows<DeliveryRow>(data);
  }

  async markSent(id: string, now: Date, providerRef: string | null): Promise<void> {
    const cur = await this.db.from("incident_deliveries").select("attempts").eq("id", id).maybeSingle();
    const attempts = ((cur.data as { attempts: number } | null)?.attempts ?? 0) + 1;
    await this.db
      .from("incident_deliveries")
      .update({ status: "sent", attempts, sent_at: now.toISOString(), provider_ref: providerRef, last_error: null })
      .eq("id", id);
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date | null): Promise<void> {
    const cur = await this.db.from("incident_deliveries").select("attempts").eq("id", id).maybeSingle();
    const attempts = ((cur.data as { attempts: number } | null)?.attempts ?? 0) + 1;
    await this.db
      .from("incident_deliveries")
      .update({
        status: "failed",
        // No retry: use the attempts up so the outbox never picks the row again. A person can still retry it from the message log.
        attempts: nextAttemptAt ? attempts : Math.max(attempts, 5),
        next_attempt_at: (nextAttemptAt ?? new Date(Date.now() + 365 * 86_400_000)).toISOString(),
        last_error: error.slice(0, 500),
      })
      .eq("id", id);
  }

  async raiseEscalationLevel(incidentId: string, level: 2 | 3): Promise<boolean> {
    const { data: cur } = await this.db.from("incidents").select("account_id, escalation_level").eq("id", incidentId).maybeSingle();
    const row = cur as { account_id: string; escalation_level: number } | null;
    if (!row || row.escalation_level >= level) return false;
    const { data, error } = await this.db
      .from("incidents")
      .update({ escalation_level: level, escalation_level_entered_at: new Date().toISOString() })
      .eq("id", incidentId)
      .lt("escalation_level", level)
      .select("id");
    if (error || !data || (data as unknown[]).length === 0) return false;
    await this.db.from("incident_activity").insert({
      incident_id: incidentId,
      account_id: row.account_id,
      actor_id: null,
      event_type: "escalated",
      from_value: String(row.escalation_level),
      to_value: String(level),
    });
    return true;
  }

  async listUnacknowledged(accountId: string, askedBefore: Date, limit: number): Promise<string[]> {
    const { data } = await this.db.rpc("incident_unacknowledged", { p_account_id: accountId, p_before: askedBefore.toISOString(), p_limit: limit });
    return rpcIds(data);
  }

  async listOverdueSteps(accountId: string, dueBefore: Date, limit: number): Promise<OverdueStep[]> {
    const { data } = await this.db.rpc("incident_overdue_steps", { p_account_id: accountId, p_before: dueBefore.toISOString(), p_limit: limit });
    return rpcRows<{ obligation_id: string; incident_id: string; party: string | null }>(data).map((r) => ({
      obligationId: r.obligation_id,
      incidentId: r.incident_id,
      party: r.party,
    }));
  }

  appUrl(): string | null {
    return process.env.NEXT_PUBLIC_SITE_URL?.trim() || null;
  }

  async senderName(accountId: string): Promise<string | null> {
    const { data } = await this.db.from("accounts").select("brand_name, name").eq("id", accountId).maybeSingle();
    const a = data as { brand_name: string | null; name: string | null } | null;
    return a?.brand_name || a?.name || null;
  }

  now(): Date {
    return new Date();
  }
}

/** Accounts that have a timed rule switched on (the sweep only looks at these). */
export async function accountsWithTimedRules(db: PgDb = createAdminPgDb()): Promise<string[]> {
  const { data } = await db.rpc("incident_accounts_with_timed_rules");
  return rpcIds(data);
}
