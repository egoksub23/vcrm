/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// GET and POST /api/sign/settings/email: the capability (sign.settings), what the routes answer, and the test email's own rate limit.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRateLimitForTests } from "@/lib/rate-limit";

const h = vi.hoisted(() => ({
  denied: false,
  asked: [] as string[],
  status: { via: "mailbox", provider: "microsoft365", address: "support@vircle.com", problem: null, fromName: "Vircle" } as Record<string, unknown>,
  tests: 0,
  testError: null as Error | null,
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    h.asked.push(capability);
    if (h.denied) throw Object.assign(new Error(`missing ${capability}`), { status: 403 });
    return { userId: "user-1", accountId: "acct-1" };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/sign/notify", () => ({ realDeps: {} }));
vi.mock("@/lib/sign/service/email-status", () => ({
  describeEmail: async () => h.status,
  sendTestEmail: async () => {
    h.tests++;
    if (h.testError) throw h.testError;
    return { sent: true, via: "mailbox", provider: "microsoft365", from: "support@vircle.com", to: "me@vircle.com", reason: null, detail: null };
  },
}));

import { GET, POST } from "./route";

const req = (method: string) => new Request("https://halo.test/api/sign/settings/email", { method });

beforeEach(() => {
  __resetRateLimitForTests();
  h.denied = false;
  h.asked.length = 0;
  h.tests = 0;
  h.testError = null;
});

describe("GET /api/sign/settings/email", () => {
  it("answers which way email goes, under sign.settings", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).email).toEqual(h.status);
    expect(h.asked).toEqual(["sign.settings"]);
  });

  it("is refused to someone without the capability", async () => {
    h.denied = true;
    expect((await GET(req("GET"))).status).toBe(403);
  });
});

describe("POST /api/sign/settings/email", () => {
  it("sends the test and answers with its outcome, under sign.settings", async () => {
    const res = await POST(req("POST"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result).toMatchObject({ sent: true, from: "support@vircle.com" });
    expect(h.asked).toEqual(["sign.settings"]);
  });

  it("is refused to someone without the capability, and sends nothing", async () => {
    h.denied = true;
    expect((await POST(req("POST"))).status).toBe(403);
    expect(h.tests).toBe(0);
  });

  it("allows five an hour and then answers 429 without sending", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(req("POST"))).status).toBe(200);
    const res = await POST(req("POST"));
    expect(res.status).toBe(429);
    expect(h.tests).toBe(5);
    // reading the status is not held back by the test email's budget
    expect((await GET(req("GET"))).status).toBe(200);
  });

  it("answers a person with no email address with its code, not a crash", async () => {
    const { SignError } = await import("@/lib/sign/service/errors");
    h.testError = new SignError("no_email", "Your profile has no email address to send the test to.", 400);
    const res = await POST(req("POST"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("no_email");
  });
});
