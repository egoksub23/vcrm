// Events Halo pushes to the coach portal (optional, never needed for go-live): "an incident was filed", "a Return to Play date changed". Signed so the
// portal knows they came from Halo, retried with backoff, and carrying no names: a student id and a reference at most.
//
//   POST <the platform key's events address>
//   X-Halo-Event: incident.created | clearance.updated
//   X-Halo-Delivery: <unique id, the same on every retry>
//   X-Halo-Timestamp: <unix seconds>
//   X-Halo-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the key's signing secret>
//
// The signing secret is derived from the server secret and the key's id, so Halo stores nothing extra; an admin can show it to the portal's developer.

import { createHmac, timingSafeEqual } from "node:crypto";

import { intakeSecret, isOrigin } from "@/lib/incidents/intake/keys";

export const WEBHOOK_EVENTS = ["incident.created", "clearance.updated"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const MAX_WEBHOOK_ATTEMPTS = 6;
/** Minutes to wait after the 1st, 2nd ... failure. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

export function webhookSecret(keyId: string, serverSecret = intakeSecret()): string | null {
  if (!serverSecret) return null;
  return `whsec_${createHmac("sha256", serverSecret).update(`incident-webhook:${keyId}`).digest("base64url")}`;
}

export function signBody(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** For the portal's side (and our tests): is this signature right, and recent? */
export function verifySignature(args: { secret: string; timestamp: number; body: string; signature: string; now?: number; toleranceSeconds?: number }): boolean {
  const { secret, timestamp, body, signature } = args;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (args.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signBody(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---- where to send ----------------------------------------------------------------------------------------------

/** An address Halo will post events to: https, a real host name (not an IP address or an internal name), no credentials. Checked again just before every send. */
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The address must start with https://." };
  if (u.username || u.password) return { ok: false, error: "Leave the user name and password out of the address." };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return { ok: false, error: "Use the portal's public address, not an internal one." };
  // An IP address (private or not) is refused: a host name is checked again at send time, an address literal could point anywhere inside the network.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || host.includes(":")) return { ok: false, error: "Use the portal's host name, not an IP address." };
  if (raw.length > 500) return { ok: false, error: "That address is too long." };
  return { ok: true, url: u.toString() };
}

// ---- the events -------------------------------------------------------------------------------------------------

export interface EventEnvelope {
  id: string;
  event: WebhookEvent;
  created_at: string;
  data: Record<string, unknown>;
}

export function incidentCreatedEvent(args: { id: string; now: Date; groupId: string; reference: string; category: string; severity: string; flags: string[]; activityId: string | null; mode: "live" | "test" }): EventEnvelope {
  return {
    id: args.id,
    event: "incident.created",
    created_at: args.now.toISOString(),
    data: { group_id: args.groupId, reference: args.reference, category: args.category, severity: args.severity, flags: args.flags, activity_id: args.activityId, mode: args.mode },
  };
}

export function clearanceUpdatedEvent(args: { id: string; now: Date; groupId: string; studentId: string; type: string; notBefore: string; reference: string | null; cleared: boolean }): EventEnvelope {
  return {
    id: args.id,
    event: "clearance.updated",
    created_at: args.now.toISOString(),
    data: { group_id: args.groupId, student_id: args.studentId, type: args.type, not_before: args.notBefore, incident: args.reference, cleared: args.cleared },
  };
}

/** When to try again after `attempts` failures, or null once the attempts are used up. */
export function nextWebhookAttempt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_WEBHOOK_ATTEMPTS) return null;
  return new Date(now.getTime() + (BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? 240) * 60_000);
}

export { isOrigin };
