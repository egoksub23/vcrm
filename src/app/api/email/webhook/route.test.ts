import { beforeEach, describe, expect, it, vi } from "vitest";

// The Microsoft 365 change-notification webhook must never turn mail Halo sent itself (Doc Sign) into a conversation of the shared inbox. These tests
// run the real route with Graph and the database faked: a message that carries Doc Sign's header (or quotes it, as a delivery-failure notice does), or
// comes from the mailbox itself, stops before any contact or conversation is made; an ordinary customer's message goes on to make them.

const h = vi.hoisted(() => ({
  message: null as Record<string, unknown> | null,
  config: { id: "e1", account_id: "A", connected_by_user_id: "U", mailbox_address: "support@vircle.com", subscription_id: "sub1", client_state: "enc:state", enabled: true } as Record<string, unknown>,
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
  return { createClient: () => ({ from: () => ({ select: () => chain({ data: [h.config], error: null }) }), storage: {}, rpc: async () => ({ error: null }) }) };
});
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (v: string) => v.replace(/^enc:/, "") }));
vi.mock("@/lib/ms365/token", () => ({ getValidAccessToken: async () => "tok" }));
vi.mock("@/lib/ms365/mail-api", () => ({ getMessage: async () => h.message, listAttachments: async () => [], downloadAttachmentBytes: async () => null }));
vi.mock("@/lib/meta/contact-identity", () => ({ findOrCreateContactByExternalId: (...a: unknown[]) => (h.findContact as unknown as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/whatsapp/mirror-inbound-media", () => ({ mirrorInboundMedia: async () => null }));
vi.mock("@/lib/conversations/find-or-create", () => ({ findOrCreateConversation: async () => null }));
vi.mock("@/lib/conversations/reopen", () => ({ reopenClosedConversation: async () => undefined }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/flows/engine", () => ({ dispatchInboundToFlows: async () => ({ consumed: false }) }));
vi.mock("@/lib/ai/auto-reply", () => ({ dispatchInboundToAiReply: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

import { POST } from "./route";

const customer = {
  id: "m1",
  subject: "Hello",
  fromAddress: "customer@example.com",
  fromName: "Customer",
  senderAddress: "customer@example.com",
  bodyText: "hi",
  bodyHtml: null,
  hasAttachments: false,
  receivedDateTime: "2026-10-07T01:00:00Z",
  headers: [{ name: "Message-ID", value: "<x@y>" }],
};

async function notify() {
  h.pending.length = 0;
  const res = await POST(new Request("https://halo.test/api/email/webhook", { method: "POST", body: JSON.stringify({ value: [{ subscriptionId: "sub1", clientState: "state", resourceData: { id: "graph-id" } }] }) }));
  expect(res.status).toBe(202);
  await Promise.all(h.pending);
}

beforeEach(() => {
  h.findContact.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("Microsoft 365 webhook: what becomes a conversation", () => {
  it("takes a customer's message as far as making the contact", async () => {
    h.message = { ...customer };
    await notify();
    expect(h.findContact).toHaveBeenCalledTimes(1);
  });

  it("stops a Doc Sign message addressed to the mailbox itself", async () => {
    h.message = { ...customer, fromAddress: "support@vircle.com", senderAddress: "support@vircle.com", headers: [{ name: "X-Halo-Sign", value: "1" }] };
    await notify();
    expect(h.findContact).not.toHaveBeenCalled();
  });

  it("stops a message that carries Doc Sign's header, whoever it says it is from", async () => {
    h.message = { ...customer, headers: [{ name: "X-Halo-Sign", value: "1" }] };
    await notify();
    expect(h.findContact).not.toHaveBeenCalled();
  });

  it("stops the delivery-failure notice of a Doc Sign message (its body quotes the original's headers)", async () => {
    h.message = { ...customer, fromAddress: "postmaster@vircle.onmicrosoft.com", senderAddress: null, headers: [], bodyText: "Delivery has failed.\r\nX-Halo-Sign: 1\r\nSubject: Please sign" };
    await notify();
    expect(h.findContact).not.toHaveBeenCalled();
  });

  it("stops a message from the mailbox's own address", async () => {
    h.message = { ...customer, fromAddress: "SUPPORT@vircle.com" };
    await notify();
    expect(h.findContact).not.toHaveBeenCalled();
  });
});
