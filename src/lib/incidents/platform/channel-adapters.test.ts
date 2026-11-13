import { describe, expect, it, vi } from "vitest";

import { availableChannels, createPushAdapter, createSmsAdapter, createWhatsAppAdapter, internationalDigits, oneLine, shortText, urlsOf, whatsappParams } from "./channel-adapters";

const notice = {
  subject: "[P2] INC-2026-9: Aiman, twisted ankle",
  text: "An incident has been reported\nAcknowledge that you have seen this (no sign-in needed): https://halo.example/incident-ack/abc\nOpen the incident (sign-in required): https://halo.example/incidents/1",
  html: "<p>x</p>",
};

describe("text helpers", () => {
  it("flattens text to one line of single spaces and cuts it to size", () => {
    expect(oneLine("a\n\nb\t c   d", 50)).toBe("a b c d");
    expect(oneLine("x".repeat(20), 10)).toHaveLength(10);
  });
  it("finds the links, acknowledge link first", () => {
    expect(urlsOf(notice.text)).toEqual(["https://halo.example/incident-ack/abc", "https://halo.example/incidents/1"]);
  });
  it("makes the two WhatsApp template variables and a short text", () => {
    expect(whatsappParams(notice)).toEqual(["[P2] INC-2026-9: Aiman, twisted ankle", "https://halo.example/incident-ack/abc https://halo.example/incidents/1"]);
    expect(shortText(notice)).toBe("[P2] INC-2026-9: Aiman, twisted ankle https://halo.example/incident-ack/abc");
  });
  it("needs the country code on a phone number", () => {
    expect(internationalDigits("+60 12-345 6789")).toBe("60123456789");
    expect(internationalDigits("0060123456789")).toBe("60123456789");
    expect(internationalDigits("012 345 6789")).toBeNull();
    expect(internationalDigits("123")).toBeNull();
  });
  it("offers email always and the others only when they are set up", () => {
    expect(availableChannels({ whatsapp: false, sms: false, push: false })).toEqual(["email"]);
    expect(availableChannels({ whatsapp: true, sms: false, push: true })).toEqual(["email", "whatsapp", "push"]);
  });
});

describe("WhatsApp adapter", () => {
  const ok = { loadConfig: async () => ({ phoneNumberId: "p1", accessToken: "t", enabled: true }), loadTemplate: async () => ({ name: "incident_notice", language: "en" }) };

  it("sends the approved template with the headline and the links", async () => {
    const sendTemplate = vi.fn(async () => ({ messageId: "wamid.1" }));
    const r = await createWhatsAppAdapter({ ...ok, sendTemplate }).send({ accountId: "a1", to: "+60 12 345 6789", notice });
    expect(r).toEqual({ ok: true, providerRef: "wamid.1" });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: "60123456789", templateName: "incident_notice", language: "en", params: whatsappParams(notice) }));
  });

  it("says plainly, without retrying, when WhatsApp, the template or the number is missing", async () => {
    const sendTemplate = vi.fn();
    const none = await createWhatsAppAdapter({ loadConfig: async () => null, loadTemplate: async () => null, sendTemplate }).send({ accountId: "a1", to: "+60123456789", notice });
    expect(none).toMatchObject({ ok: false, retryable: false });
    const noTemplate = await createWhatsAppAdapter({ ...ok, loadTemplate: async () => null, sendTemplate }).send({ accountId: "a1", to: "+60123456789", notice });
    expect(noTemplate).toMatchObject({ ok: false, retryable: false });
    const local = await createWhatsAppAdapter({ ...ok, sendTemplate }).send({ accountId: "a1", to: "0123456789", notice });
    expect(local).toMatchObject({ ok: false, retryable: false });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("retries a server error or timeout, not a refusal", async () => {
    const mk = (message: string) => createWhatsAppAdapter({ ...ok, sendTemplate: async () => { throw new Error(message); } }).send({ accountId: "a1", to: "+60123456789", notice });
    expect(await mk("Meta API 503: unavailable")).toMatchObject({ ok: false, retryable: true });
    expect(await mk("Meta API 400: template does not exist")).toMatchObject({ ok: false, retryable: false });
  });
});

describe("SMS and push adapters", () => {
  it("posts a short text to the SMS bridge with the secret", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await createSmsAdapter({ url: "https://bridge.example/sms", secret: "s3", fetch: fetcher as unknown as typeof fetch }).send({ accountId: "a1", to: "+60 12 345 6789", notice });
    expect(r).toEqual({ ok: true });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3");
    expect(JSON.parse(String(init.body))).toMatchObject({ to: "+60123456789", account_id: "a1" });
  });

  it("is not retryable when SMS or push is not set up, and retryable on a server error", async () => {
    expect(await createSmsAdapter({ url: null, secret: null }).send({ accountId: "a1", to: "+60123456789", notice })).toMatchObject({ ok: false, retryable: false });
    expect(await createPushAdapter({ url: null, secret: null, stage: null }).send({ accountId: "a1", to: "+60123456789", notice })).toMatchObject({ ok: false, retryable: false });
    const down = vi.fn(async () => new Response("", { status: 502 }));
    expect(await createSmsAdapter({ url: "https://b.example", secret: "s", fetch: down as unknown as typeof fetch }).send({ accountId: "a1", to: "+60123456789", notice })).toMatchObject({ ok: false, retryable: true });
  });

  it("sends a push by phone number, and does not retry when nobody has the app", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 200 }));
    const push = createPushAdapter({ url: "https://push.example/alert", secret: "k", stage: "uat", fetch: fetcher as unknown as typeof fetch });
    expect(await push.send({ accountId: "a1", to: "+60 12 345 6789", notice })).toEqual({ ok: true });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-stage"]).toBe("uat");
    expect(JSON.parse(String(init.body))).toMatchObject({ mobile_number: "60123456789" });
    const none = createPushAdapter({ url: "https://push.example/alert", secret: "k", stage: "uat", fetch: (async () => new Response('{"code":"ERA03"}', { status: 404 })) as unknown as typeof fetch });
    expect(await none.send({ accountId: "a1", to: "+60123456789", notice })).toMatchObject({ ok: false, retryable: false });
  });
});
