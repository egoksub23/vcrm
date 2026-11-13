import { describe, expect, it, vi } from "vitest";

import { clearanceUpdatedEvent, incidentCreatedEvent, nextWebhookAttempt, signBody, validateWebhookUrl, verifySignature, webhookSecret } from "./core";
import { dispatchWebhooks, type Fetcher, type QueuedEvent, type WebhookStore, type WebhookTarget } from "./sender";

const NOW = new Date("2026-11-11T10:00:00Z");

describe("signing", () => {
  it("derives a stable secret per key and nothing without a server secret", () => {
    expect(webhookSecret("key-1", "s3cret")).toBe(webhookSecret("key-1", "s3cret"));
    expect(webhookSecret("key-1", "s3cret")).not.toBe(webhookSecret("key-2", "s3cret"));
    expect(webhookSecret("key-1", "other")).not.toBe(webhookSecret("key-1", "s3cret"));
    expect(webhookSecret("key-1", "")).toBeNull();
    expect(webhookSecret("key-1", "s3cret")).toMatch(/^whsec_[A-Za-z0-9_-]+$/);
  });
  it("signs timestamp and body together, and the portal can verify it (and refuses a stale or altered one)", () => {
    const secret = "whsec_x";
    const body = '{"a":1}';
    const sig = signBody(secret, 1_800_000_000, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    const base = { secret, timestamp: 1_800_000_000, body, signature: sig, now: 1_800_000_100 };
    expect(verifySignature(base)).toBe(true);
    expect(verifySignature({ ...base, body: '{"a":2}' })).toBe(false);
    expect(verifySignature({ ...base, secret: "whsec_y" })).toBe(false);
    expect(verifySignature({ ...base, now: 1_800_001_000 })).toBe(false);
    expect(verifySignature({ ...base, signature: "sha256=00" })).toBe(false);
  });
});

describe("addresses", () => {
  it("accepts a public https address and nothing else", () => {
    expect(validateWebhookUrl("https://coach.example.edu.my/hooks/halo")).toMatchObject({ ok: true });
    for (const bad of ["http://coach.example.edu.my/x", "https://localhost/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://printer.local/x", "https://intranet/x", "https://user:pw@coach.example.edu.my/x", "ftp://x.example/y", "not a url"]) {
      expect(validateWebhookUrl(bad), bad).toMatchObject({ ok: false });
    }
  });
});

describe("events and retries", () => {
  it("carry the Vircle Group ID, a reference and codes, never names", () => {
    const created = incidentCreatedEvent({ id: "e1", now: NOW, groupId: "G-1", reference: "INC-2026-31", category: "CCA", severity: "high", flags: ["injury"], activityId: "A-1", mode: "live" });
    expect(created).toEqual({ id: "e1", event: "incident.created", created_at: NOW.toISOString(), data: { group_id: "G-1", reference: "INC-2026-31", category: "CCA", severity: "high", flags: ["injury"], activity_id: "A-1", mode: "live" } });
    const cl = clearanceUpdatedEvent({ id: "e2", now: NOW, groupId: "G-1", studentId: "S-1", type: "concussion", notBefore: "2026-11-20", reference: "INC-2026-31", cleared: false });
    expect(JSON.stringify(cl)).not.toMatch(/name/i);
  });
  it("waits 1, 5, 15, 60, 240 minutes, then stops after six attempts", () => {
    expect([1, 2, 3, 4, 5].map((n) => nextWebhookAttempt(n, NOW)!.getTime() - NOW.getTime())).toEqual([1, 5, 15, 60, 240].map((m) => m * 60_000));
    expect(nextWebhookAttempt(6, NOW)).toBeNull();
  });
});

class MemoryWebhookStore implements WebhookStore {
  events: QueuedEvent[] = [];
  targets = new Map<string, WebhookTarget>();
  sent: string[] = [];
  failures = new Map<string, { error: string; next: Date | null }>();
  async claimDue() {
    return this.events.filter((e) => !this.sent.includes(e.id) && !this.failures.has(e.id));
  }
  async target(keyId: string) {
    return this.targets.get(keyId) ?? null;
  }
  async markSent(id: string) {
    this.sent.push(id);
  }
  async markFailed(id: string, error: string, next: Date | null) {
    this.failures.set(id, { error, next });
  }
  now() {
    return NOW;
  }
}

const event = (id = "d1"): QueuedEvent => ({ id, account_id: "a1", key_id: "k1", event: "incident.created", attempts: 0, payload: incidentCreatedEvent({ id, now: NOW, groupId: "G-1", reference: "INC-2026-1", category: "CCA", severity: "low", flags: [], activityId: null, mode: "test" }) });

describe("dispatchWebhooks", () => {
  const setup = () => {
    const store = new MemoryWebhookStore();
    store.events = [event()];
    store.targets.set("k1", { url: "https://coach.example.edu.my/hooks", revoked: false });
    return store;
  };

  it("posts a signed event to the key's address, and does not follow redirects", async () => {
    const store = setup();
    const fetcher = vi.fn<Fetcher>(async () => ({ status: 204 }));
    const out = await dispatchWebhooks(store, fetcher, "server-secret");
    expect(out).toEqual({ sent: 1, failed: 0, dropped: 0 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://coach.example.edu.my/hooks");
    expect(init.redirect).toBe("manual");
    expect(init.headers["X-Halo-Event"]).toBe("incident.created");
    expect(init.headers["X-Halo-Delivery"]).toBe("d1");
    const secret = webhookSecret("k1", "server-secret")!;
    expect(verifySignature({ secret, timestamp: Number(init.headers["X-Halo-Timestamp"]), body: init.body, signature: init.headers["X-Halo-Signature"], now: Math.floor(NOW.getTime() / 1000) })).toBe(true);
    expect(store.sent).toEqual(["d1"]);
  });

  it("retries a server error with backoff, but not a client error, a redirect or a bad address", async () => {
    for (const [status, retry] of [[500, true], [503, true], [429, true], [408, true], [400, false], [404, false], [301, false]] as const) {
      const store = setup();
      await dispatchWebhooks(store, async () => ({ status }), "server-secret");
      const f = store.failures.get("d1")!;
      expect(f.error, String(status)).toContain(String(status));
      expect(f.next === null, String(status)).toBe(!retry);
    }
    const store = setup();
    store.targets.set("k1", { url: "http://10.0.0.1/x", revoked: false });
    await dispatchWebhooks(store, async () => ({ status: 200 }), "server-secret");
    expect(store.failures.get("d1")).toMatchObject({ next: null });
  });

  it("drops an event whose key has no address or was revoked, and never sends it", async () => {
    const fetcher = vi.fn<Fetcher>(async () => ({ status: 200 }));
    const none = setup();
    none.targets.set("k1", { url: null, revoked: false });
    expect(await dispatchWebhooks(none, fetcher, "s")).toEqual({ sent: 0, failed: 0, dropped: 1 });
    const revoked = setup();
    revoked.targets.set("k1", { url: "https://coach.example.edu.my/hooks", revoked: true });
    expect((await dispatchWebhooks(revoked, fetcher, "s")).dropped).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("records a network failure and a timeout without throwing, and refuses to send without a signing secret", async () => {
    const down = setup();
    await dispatchWebhooks(down, async () => { throw new Error("connect ECONNREFUSED"); }, "s");
    expect(down.failures.get("d1")).toMatchObject({ error: "connect ECONNREFUSED" });
    const slow = setup();
    await dispatchWebhooks(slow, async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, "s");
    expect(slow.failures.get("d1")?.error).toBe("The portal did not answer in time");
    const unsigned = setup();
    await dispatchWebhooks(unsigned, async () => ({ status: 200 }), "");
    expect(unsigned.failures.get("d1")).toMatchObject({ error: "The server has no signing secret set", next: null });
  });
});
