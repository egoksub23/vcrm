// The webhook outbox on Halo's PostgreSQL (service connection), plus the two places events are queued from.

import { randomUUID } from "node:crypto";

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { incidentKey } from "@/lib/incidents/types";
import { rpcRows } from "@/lib/incidents/platform/pg-store";
import { MAX_WEBHOOK_ATTEMPTS, clearanceUpdatedEvent, incidentCreatedEvent, nextWebhookAttempt, type EventEnvelope } from "./core";
import type { QueuedEvent, WebhookStore, WebhookTarget } from "./sender";

export class PgWebhookStore implements WebhookStore {
  constructor(private readonly db: PgDb = createAdminPgDb()) {}

  async claimDue(_now: Date, limit: number): Promise<QueuedEvent[]> {
    const { data, error } = await this.db.rpc("claim_incident_webhook_events", { p_limit: limit });
    if (error) {
      console.error("[incident-webhooks] claim failed:", error.message);
      return [];
    }
    return rpcRows<QueuedEvent>(data);
  }

  async target(keyId: string): Promise<WebhookTarget | null> {
    const { data } = await this.db.from("incident_intake_keys").select("webhook_url, revoked_at").eq("id", keyId).maybeSingle();
    const row = data as { webhook_url: string | null; revoked_at: string | null } | null;
    return row ? { url: row.webhook_url, revoked: row.revoked_at !== null } : null;
  }

  async markSent(id: string, now: Date): Promise<void> {
    const cur = await this.db.from("incident_webhook_events").select("attempts").eq("id", id).maybeSingle();
    const attempts = ((cur.data as { attempts: number } | null)?.attempts ?? 0) + 1;
    await this.db.from("incident_webhook_events").update({ status: "sent", attempts, sent_at: now.toISOString(), last_error: null }).eq("id", id);
  }

  async markFailed(id: string, error: string, nextAt: Date | null): Promise<void> {
    const cur = await this.db.from("incident_webhook_events").select("attempts").eq("id", id).maybeSingle();
    const attempts = ((cur.data as { attempts: number } | null)?.attempts ?? 0) + 1;
    await this.db
      .from("incident_webhook_events")
      .update({ status: "failed", attempts: nextAt ? attempts : MAX_WEBHOOK_ATTEMPTS, next_attempt_at: (nextAt ?? new Date(Date.now() + 365 * 86_400_000)).toISOString(), last_error: error.slice(0, 300) })
      .eq("id", id);
  }

  now(): Date {
    return new Date();
  }
}

async function queue(db: PgDb, accountId: string, keyId: string, envelope: EventEnvelope): Promise<void> {
  await db.from("incident_webhook_events").insert({ id: envelope.id, account_id: accountId, key_id: keyId, event: envelope.event, payload: envelope, next_attempt_at: new Date().toISOString() });
}

/** After a report is filed through a key's link: tell that key's portal, if it gave an address. Best effort. */
export async function enqueueIncidentCreated(incidentId: string, db: PgDb = createAdminPgDb()): Promise<void> {
  try {
    const { data } = await db.from("incidents").select("account_id, created_at, incident_number, incident_type, severity, incident_flags, external_ref, activity, is_test, source").eq("id", incidentId).maybeSingle();
    const inc = data as { account_id: string; created_at: string; incident_number: number; incident_type: string; severity: string; incident_flags: string[] | null; external_ref: string | null; activity: { id?: string } | null; is_test: boolean; source: string } | null;
    if (!inc || inc.source !== "coach_portal" || !inc.external_ref) return;
    const { data: session } = await db.from("incident_intake_sessions").select("key_id").eq("id", inc.external_ref).maybeSingle();
    const keyId = (session as { key_id: string } | null)?.key_id;
    if (!keyId) return;
    const target = await new PgWebhookStore(db).target(keyId);
    if (!target?.url || target.revoked) return;
    await queue(db, inc.account_id, keyId, incidentCreatedEvent({ id: randomUUID(), now: new Date(), reference: incidentKey(inc), category: inc.incident_type, severity: inc.severity, flags: inc.incident_flags ?? [], activityId: inc.activity?.id ?? null, mode: inc.is_test ? "test" : "live" }));
  } catch (err) {
    console.error("[incident-webhooks] could not queue incident.created:", err);
  }
}

/** After a Return to Play date is set or cleared: tell every portal key of the school that may read clearances and has an address. Best effort. */
export async function enqueueClearanceUpdated(args: { accountId: string; studentId: string; type: string; notBefore: string; incidentId: string | null; cleared: boolean }, db: PgDb = createAdminPgDb()): Promise<void> {
  try {
    const { data: keys } = await db.from("incident_intake_keys").select("id, scopes").eq("account_id", args.accountId).is("revoked_at", null).not("webhook_url", "is", null);
    const targets = ((keys ?? []) as { id: string; scopes: string[] }[]).filter((k) => k.scopes.includes("clearances.read"));
    if (targets.length === 0) return;
    let reference: string | null = null;
    if (args.incidentId) {
      const { data } = await db.from("incidents").select("created_at, incident_number").eq("id", args.incidentId).maybeSingle();
      reference = data ? incidentKey(data as { created_at: string; incident_number: number }) : null;
    }
    for (const k of targets) {
      await queue(db, args.accountId, k.id, clearanceUpdatedEvent({ id: randomUUID(), now: new Date(), studentId: args.studentId, type: args.type, notBefore: args.notBefore, reference, cleared: args.cleared }));
    }
  } catch (err) {
    console.error("[incident-webhooks] could not queue clearance.updated:", err);
  }
}

export { nextWebhookAttempt };
