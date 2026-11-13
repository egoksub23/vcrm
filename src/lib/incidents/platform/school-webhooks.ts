// School-level webhook subscriptions (Phase 3.6).
//
// Each subscription is an HTTPS endpoint the school registers. Halo posts a signed JSON payload when
// a subscribed incident event fires. The signing envelope matches migration 217 (coach-portal webhooks):
//
//   POST <url>
//   Content-Type: application/json
//   X-Halo-Event:      incident.filed | incident.closed | incident.escalated | incident.status_changed
//   X-Halo-Delivery:   <random UUID>
//   X-Halo-Timestamp:  <unix seconds>
//   X-Halo-Signature:  sha256=<hmac-sha256("<timestamp>.<body>", signingSecret)>
//
// Body: { id, event, timestamp (ISO), incident_id, reference, ...event-specific fields }
//
// deliverSchoolWebhookEvent() is fire-and-forget: failures are recorded in last_status_code but never
// propagate to the caller.

import { createHmac, randomUUID } from "node:crypto";

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { validateWebhookUrl } from "@/lib/incidents/webhooks/core";

import { SCHOOL_WEBHOOK_EVENTS, type SchoolWebhookEvent, type SchoolWebhookRow, type SchoolWebhookView } from "./school-webhook-types";

export { SCHOOL_WEBHOOK_EVENTS };
export type { SchoolWebhookEvent, SchoolWebhookRow, SchoolWebhookView };

// ----- CRUD --------------------------------------------------------------------

export async function listSchoolWebhooks(db: PgDb, accountId: string): Promise<SchoolWebhookView[]> {
  const { data } = await db
    .from("incident_school_webhooks")
    .select("id, account_id, url, events, label, enabled, created_at, last_called_at, last_status_code")
    .eq("account_id", accountId)
    .order("created_at");
  return ((data ?? []) as SchoolWebhookRow[]).map((r) => ({ ...r, url_host: safeHost(r.url) }));
}

export async function createSchoolWebhook(
  db: PgDb,
  accountId: string,
  args: { url: string; events: SchoolWebhookEvent[]; label: string | null },
): Promise<{ row: SchoolWebhookView; signing_secret: string } | { error: string }> {
  const check = validateWebhookUrl(args.url);
  if (!check.ok) return { error: check.error };
  if (args.events.length === 0) return { error: "Pick at least one event." };
  const invalid = args.events.filter((e) => !(SCHOOL_WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length > 0) return { error: `Unknown event: ${invalid[0]}` };

  const signing_secret = `whsec_${randomUUID().replace(/-/g, "")}`;
  const { data, error } = await db
    .from("incident_school_webhooks")
    .insert({ account_id: accountId, url: check.url, events: args.events, label: args.label || null, signing_secret })
    .select("id, account_id, url, events, label, enabled, created_at, last_called_at, last_status_code")
    .single();
  if (error || !data) return { error: "Could not save the webhook." };
  const row = data as SchoolWebhookRow;
  return { row: { ...row, url_host: safeHost(row.url) }, signing_secret };
}

export async function updateSchoolWebhook(
  db: PgDb,
  accountId: string,
  id: string,
  patch: { url?: string; events?: SchoolWebhookEvent[]; label?: string | null; enabled?: boolean },
): Promise<SchoolWebhookView | { error: string }> {
  if (patch.url !== undefined) {
    const check = validateWebhookUrl(patch.url);
    if (!check.ok) return { error: check.error };
    patch.url = check.url;
  }
  if (patch.events !== undefined) {
    if (patch.events.length === 0) return { error: "Pick at least one event." };
    const invalid = patch.events.filter((e) => !(SCHOOL_WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (invalid.length > 0) return { error: `Unknown event: ${invalid[0]}` };
  }
  const { data, error } = await db
    .from("incident_school_webhooks")
    .update(patch as Record<string, unknown>)
    .eq("id", id)
    .eq("account_id", accountId)
    .select("id, account_id, url, events, label, enabled, created_at, last_called_at, last_status_code")
    .single();
  if (error || !data) return { error: "Could not update the webhook." };
  const row = data as SchoolWebhookRow;
  return { ...row, url_host: safeHost(row.url) };
}

export async function deleteSchoolWebhook(db: PgDb, accountId: string, id: string): Promise<boolean> {
  const { error } = await db.from("incident_school_webhooks").delete().eq("id", id).eq("account_id", accountId);
  return !error;
}

// ----- delivery ----------------------------------------------------------------

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function signBody(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function sendToEndpoint(
  row: { id: string; url: string; signing_secret: string },
  event: SchoolWebhookEvent,
  payload: Record<string, unknown>,
  db: PgDb,
): Promise<void> {
  const deliveryId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: deliveryId, event, timestamp: new Date().toISOString(), ...payload });
  const signature = signBody(row.signing_secret, timestamp, body);

  let statusCode: number | null = null;
  try {
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Halo-Event": event,
        "X-Halo-Delivery": deliveryId,
        "X-Halo-Timestamp": String(timestamp),
        "X-Halo-Signature": signature,
        "User-Agent": "Halo-Webhook/1.0",
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    statusCode = res.status;
  } catch {
    statusCode = null;
  }

  await db
    .from("incident_school_webhooks")
    .update({ last_called_at: new Date().toISOString(), last_status_code: statusCode })
    .eq("id", row.id)
    .catch(() => {});
}

/** Deliver a school-level webhook event to all matching enabled subscriptions. Fire-and-forget. */
export function deliverSchoolWebhookEvent(
  accountId: string,
  event: SchoolWebhookEvent,
  payload: Record<string, unknown>,
  db: PgDb = createAdminPgDb(),
): void {
  void (async () => {
    try {
      const { data } = await db
        .from("incident_school_webhooks")
        .select("id, url, signing_secret, events")
        .eq("account_id", accountId)
        .eq("enabled", true);
      const rows = (data ?? []) as { id: string; url: string; signing_secret: string; events: string[] }[];
      const matching = rows.filter((r) => r.events.includes(event));
      await Promise.allSettled(matching.map((r) => sendToEndpoint(r, event, payload, db)));
    } catch {
      // never propagate
    }
  })();
}
