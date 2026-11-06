// Sending the events. All database access is behind `WebhookStore` and the network behind `Fetcher`, so retries, signing and refusals are tested in memory.

import { MAX_WEBHOOK_ATTEMPTS, nextWebhookAttempt, signBody, validateWebhookUrl, webhookSecret, type EventEnvelope } from "./core";

export interface QueuedEvent {
  id: string;
  account_id: string;
  key_id: string;
  event: EventEnvelope["event"];
  payload: EventEnvelope;
  attempts: number;
}

export interface WebhookTarget {
  /** The address to post to; null when the key has none (the event is then dropped). */
  url: string | null;
  revoked: boolean;
}

export interface WebhookStore {
  /** Marks due events 'sending' and returns them (so two sweeps never send one twice). */
  claimDue(now: Date, limit: number): Promise<QueuedEvent[]>;
  target(keyId: string): Promise<WebhookTarget | null>;
  markSent(id: string, now: Date): Promise<void>;
  markFailed(id: string, error: string, nextAt: Date | null): Promise<void>;
  now(): Date;
}

export type Fetcher = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal }) => Promise<{ status: number }>;

export interface SendSummary {
  sent: number;
  failed: number;
  dropped: number;
}

/** One send, with an 8 second limit. Redirects are not followed: a portal that moves must say so in its address. */
export async function dispatchWebhooks(store: WebhookStore, fetcher: Fetcher, serverSecret?: string, limit = 25): Promise<SendSummary> {
  const out: SendSummary = { sent: 0, failed: 0, dropped: 0 };
  const now = store.now();
  for (const ev of await store.claimDue(now, limit)) {
    const attempts = ev.attempts + 1;
    const fail = async (error: string, retry = true) => {
      await store.markFailed(ev.id, error, retry ? nextWebhookAttempt(attempts, now) : null);
      out.failed += 1;
    };
    try {
      const target = await store.target(ev.key_id);
      // No address, or the key was revoked: nothing to send, and nothing to retry.
      if (!target || !target.url || target.revoked) {
        await store.markFailed(ev.id, "No address to send to", null);
        out.dropped += 1;
        continue;
      }
      const checked = validateWebhookUrl(target.url);
      if (!checked.ok) {
        await fail(checked.error, false);
        continue;
      }
      const secret = webhookSecret(ev.key_id, serverSecret);
      if (!secret) {
        await fail("The server has no signing secret set", false);
        continue;
      }
      const body = JSON.stringify(ev.payload);
      const timestamp = Math.floor(now.getTime() / 1000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let status: number;
      try {
        ({ status } = await fetcher(checked.url, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Halo-Incidents-Webhook/1",
            "X-Halo-Event": ev.event,
            "X-Halo-Delivery": ev.id,
            "X-Halo-Timestamp": String(timestamp),
            "X-Halo-Signature": signBody(secret, timestamp, body),
          },
          body,
        }));
      } finally {
        clearTimeout(timer);
      }
      if (status >= 200 && status < 300) {
        await store.markSent(ev.id, now);
        out.sent += 1;
      } else if (status >= 300 && status < 400) {
        await fail(`The portal answered with a redirect (${status}); register its final address`, false);
      } else {
        // 4xx other than 408 and 429 will not get better by trying again.
        await fail(`The portal answered ${status}`, !(status >= 400 && status < 500 && status !== 408 && status !== 429));
      }
    } catch (err) {
      await fail(err instanceof Error ? (err.name === "AbortError" ? "The portal did not answer in time" : err.message) : "Could not reach the portal");
    }
  }
  return out;
}

export { MAX_WEBHOOK_ATTEMPTS };
