// ============================================================
// The webhook receiver's logic (the route file only wires it to HTTP).
//
//   1. find the connection by the random token in the URL path
//   2. authorise: path token (constant time) + the signed bearer when present
//   3. parse; cross-check the site the payload names against the connection
//   4. de-duplicate by Atlassian's delivery identifier
//   5. drop events for issues nobody linked
//   6. queue "sync issue X" (never acting on the payload's content) and answer
//
// It answers 200 fast; the work happens in the queue. The payload only ever
// names an issue: the worker re-reads it from Jira.
// ============================================================

import { checkRateLimit } from "@/lib/rate-limit";

import { normalizeSettings } from "./settings";
import type { JiraStore } from "./store";
import type { JiraConnectionRow } from "./types";
import {
  authorizeWebhook,
  deliveryKey,
  HANDLED_EVENTS,
  parseWebhookPayload,
  payloadMatchesSite,
} from "./webhook";

export interface WebhookStore {
  /** The connection and its stored token for a URL token, or null. */
  connectionByToken(token: string): Promise<{ connection: JiraConnectionRow; expectedToken: string } | null>;
  /** True if newly recorded, false if this delivery was seen before. */
  recordDelivery(connectionId: string, deliveryId: string, event: string): Promise<boolean>;
}

export interface WebhookRequest {
  pathToken: string;
  authorization: string | null;
  identifier: string | null;
  rawBody: string;
  clientSecret: string | null;
  verifyMode?: string | null;
  now?: number;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export const MAX_BODY_BYTES = 1_000_000;

// Log the "token only" uncertainty once a day per connection, not per delivery.
const noted = new Map<string, number>();

export async function handleWebhook(
  req: WebhookRequest,
  deps: { hooks: WebhookStore; store: JiraStore; limit?: typeof checkRateLimit },
): Promise<WebhookResult> {
  const now = req.now ?? Date.now();
  const limiter = deps.limit ?? checkRateLimit;

  // A path token of the wrong shape is never looked up.
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(req.pathToken)) return { status: 404, body: { error: "not_found" } };
  const rl = limiter(`jira:webhook:${req.pathToken.slice(0, 16)}`, { limit: 900, windowMs: 60_000 });
  if (!rl.success) return { status: 429, body: { error: "rate_limited" } };
  if (Buffer.byteLength(req.rawBody) > MAX_BODY_BYTES) return { status: 413, body: { error: "too_large" } };

  const found = await deps.hooks.connectionByToken(req.pathToken);
  if (!found) return { status: 404, body: { error: "not_found" } };
  const { connection } = found;

  const auth = authorizeWebhook({
    pathToken: req.pathToken,
    expectedToken: found.expectedToken,
    authorization: req.authorization,
    clientSecret: req.clientSecret,
    verifyMode: req.verifyMode,
    requireSigned: normalizeSettings(connection.settings).webhook.require_signed,
    now,
  });
  if (!auth.ok) {
    if (auth.reason === "unsigned") {
      // "Require signed deliveries" is on and this one carried no verifiable bearer: refused, and counted.
      await deps.store.bumpWebhookStat(connection.id, "rejected_unsigned");
      await noteOnce(deps.store, connection, "webhook_unsigned_rejected", "warn", "A webhook was refused because \"Require signed deliveries\" is on and it carried no bearer token that verifies with the app secret. If real deliveries are unsigned, turn that setting off (Settings > Integrations > Jira > Direction).", now);
    }
    if (auth.reason === "bad_bearer") {
      await noteOnce(deps.store, connection, "webhook_bearer_rejected", "warn", "A webhook was rejected: its signed bearer token did not verify with the app secret. If Jira really sends these, set JIRA_WEBHOOK_VERIFY=path-only (see docs/jira-setup.md).", now);
    }
    return { status: 401, body: { error: "unauthorized" } };
  }
  // Which mode real deliveries use: the owner reads it in Diagnostics.
  await deps.store.bumpWebhookStat(connection.id, auth.level === "jwt" ? "signed" : "unsigned");
  if (auth.level === "token_only") {
    await noteOnce(deps.store, connection, "webhook_token_only", "info", "Webhooks are accepted on the secret address alone: no signed bearer token came with them. The payload is never trusted; the issue is re-read from Jira.", now);
  }

  if (connection.status !== "active") return { status: 200, body: { ignored: "connection_inactive" } };

  let json: unknown;
  try {
    json = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }
  const evt = parseWebhookPayload(json);
  if (!HANDLED_EVENTS.has(evt.event)) return { status: 200, body: { ignored: "event" } };
  if (!payloadMatchesSite(evt.self, connection.site_url, connection.cloud_id)) {
    await deps.store.logEvent({
      accountId: connection.account_id,
      connectionId: connection.id,
      level: "warn",
      kind: "webhook_wrong_site",
      message: "A webhook named an issue on another site and was dropped",
    });
    return { status: 200, body: { ignored: "site" } };
  }

  // De-duplicate (Atlassian retries; the identifier is stable across retries).
  const fresh = await deps.hooks.recordDelivery(connection.id, deliveryKey(req.identifier, req.rawBody), evt.event);
  if (!fresh) return { status: 200, body: { duplicate: true } };

  // Which linked issue? By permanent id when the payload has it, else by key.
  let issueId = evt.issueId;
  if (!issueId && evt.issueKey) {
    const byKey = (await deps.store.linksForConnection(connection.id)).find((l) => l.issue_key === evt.issueKey);
    issueId = byKey?.issue_id ?? null;
  }
  if (!issueId) return { status: 200, body: { ignored: "no_issue" } };

  // A project-wide webhook also delivers issues nobody linked: those are dropped here.
  const links = await deps.store.linksForIssue(connection.id, issueId);
  if (links.length === 0) return { status: 200, body: { ignored: "not_linked" } };

  await deps.store.enqueue({
    accountId: connection.account_id,
    connectionId: connection.id,
    kind: "sync_issue",
    payload: {
      issue_id: issueId,
      event: evt.event,
      // Comment events (and a status change) read the comments too; everything else can skip that call.
      comments: evt.event.startsWith("comment_") || evt.event === "jira:issue_deleted" ? true : false,
    },
    dedupeKey: `sync:${issueId}`,
  });
  return { status: 200, body: { queued: true } };
}

async function noteOnce(
  store: JiraStore,
  connection: JiraConnectionRow,
  kind: string,
  level: "info" | "warn",
  message: string,
  now: number,
): Promise<void> {
  const key = `${connection.id}:${kind}`;
  const last = noted.get(key) ?? 0;
  if (now - last < 24 * 3_600_000) return;
  noted.set(key, now);
  console.warn(`[jira webhook] ${message}`);
  await store.logEvent({ accountId: connection.account_id, connectionId: connection.id, level, kind, message });
}

export function __resetWebhookNotesForTests(): void {
  noted.clear();
}
