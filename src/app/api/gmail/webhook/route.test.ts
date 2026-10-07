import { beforeEach, describe, expect, it, vi } from "vitest";

// The Gmail push webhook must never turn mail Halo sent itself (Doc Sign) into a conversation of the shared inbox. These tests run the real route
// with Gmail and the database faked: a message that carries Doc Sign's header, or the label SENT, or comes from the mailbox itself, stops before any
// contact or conversation is made; an ordinary customer's message goes on to make them.

const h = vi.hoisted(() => ({
  message: null as Record<string, unknown> | null,
  config: { id: "g1", account_id: "A", connected_by_user_id: "U", email_address: "support@vircle.com", pubsub_verify_token: "secret", history_id: "100", enabled: true } as Record<string, unknown>,
  pending: [] as Promise<unknown>[],
  findContact: vi.fn(async () => null),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => Promise<unknown>) => void h.pending.push(fn()) };
});
vi.mock("@supabase/supabase-js", () => {
  const chain = (result: unknown): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve(result) : () => chain(result)),
    });
  return { createClient: () => ({ from: () => ({ select: () => chain({ data: h.config, error: null }), update: () => chain({ error: null }) }), storage: {}, rpc: async () => ({ error: null }) }) };
});
vi.mock("@/lib/gmail/token", () => ({ getValidAccessToken: async () => "tok" }));
vi.mock("@/lib/gmail/gmail-api", () => ({
  getMessage: async () => h.message,
  listHistory: async () => ({ newMessageIds: ["m1"], latestHistoryId: "101", historyExpired: false }),
  getCurrentHistoryId: async () => "100",
  downloadAttachmentBytes: async () => null,
}));
vi.mock("@/lib/meta/contact-identity", () => ({ findOrCreateContactByExternalId: (...a: unknown[]) => (h.findContact as unknown as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/whatsapp/mirror-inbound-media", () => ({ mirrorInboundMedia: async () => null }));
vi.mock("@/lib/conversations/find-or-create", () => ({ findOrCreateConversation: async () => null }));
vi.mock("@/lib/conversations/reopen", () => ({ reopenClosedConversation: async () => undefined }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/flows/engine", () => ({ dispatchInboundToFlows: async () => ({ consumed: false }) }));
vi.mock("@/lib/ai/auto-reply", () => ({ dispatchInboundToAiReply: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

import { POST } from "./route";

const customer = { id: "m1", threadId: "t1", subject: "Hello", fromAddress: "customer@example.com", fromName: "Customer", bodyText: "hi", bodyHtml: null, attachments: [], internalDate: "1", labelIds: ["INBOX"], haloSign: false };

async function push() {
  h.pending.length = 0;
  const body = { message: { data: Buffer.from(JSON.stringify({ emailAddress: "support@vircle.com", historyId: "101" })).toString("base64") } };
  const res = await POST(new Request("https://halo.test/api/gmail/webhook?token=secret", { method: "POST", body: JSON.stringify(body) }));
  expect(res.status).toBe(200);
  await Promise.all(h.pending);
}

beforeEach(() => {
  h.findContact.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("Gmail webhook: what becomes a conversation", () => {
  it("takes a customer's message as far as making the contact", async () => {
    h.message = { ...customer };
    await push();
    expect(h.findContact).toHaveBeenCalledTimes(1);
  });

  it("stops a Doc Sign message addressed to the mailbox itself (it is in INBOX and SENT)", async () => {
    h.message = { ...customer, fromAddress: "support@vircle.com", labelIds: ["INBOX", "SENT", "UNREAD"], haloSign: true };
    await push();
    expect(h.findContact).not.toHaveBeenCalled();
  });

  it("stops a message that carries Doc Sign's header, whoever it says it is from", async () => {
    h.message = { ...customer, haloSign: true };
    await push();
    expect(h.findContact).not.toHaveBeenCalled();
  });

  it("stops anything the mailbox sent, by the label SENT alone", async () => {
    h.message = { ...customer, fromAddress: "alias@vircle.com", labelIds: ["INBOX", "SENT"] };
    await push();
    expect(h.findContact).not.toHaveBeenCalled();
  });

  it("stops a message from the mailbox's own address", async () => {
    h.message = { ...customer, fromAddress: "Support@Vircle.com" };
    await push();
    expect(h.findContact).not.toHaveBeenCalled();
  });
});
