import { beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in callback (state validation), the webhook receiver's route and the
// cron route's secret check, with the collaborators replaced by doubles.

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  findPendingByState: vi.fn(),
  consumePending: vi.fn(),
  storeForPicker: vi.fn(),
  markPendingDone: vi.fn(),
  exchange: vi.fn(),
  sites: vi.fn(),
  complete: vi.fn(),
  runCron: vi.fn(),
  handle: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  requireAnyCapability: vi.fn(),
  toErrorResponse: (err: unknown) => Response.json({ error: String(err) }, { status: (err as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/jira/pending", () => ({
  findPendingByState: h.findPendingByState,
  consumePending: h.consumePending,
  storeForPicker: h.storeForPicker,
  markPendingDone: h.markPendingDone,
  createPending: vi.fn(),
  findPendingById: vi.fn(),
  readPendingTokens: vi.fn(),
}));
vi.mock("@/lib/jira/oauth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jira/oauth")>("@/lib/jira/oauth");
  return { ...actual, exchangeCodeForTokens: h.exchange, fetchAccessibleResources: h.sites };
});
vi.mock("@/lib/jira/connection", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jira/connection")>("@/lib/jira/connection");
  return { ...actual, completeConnection: h.complete, ensureWebhooks: vi.fn() };
});
vi.mock("@/lib/jira/service", () => ({
  jiraStore: () => ({ getConnection: async () => null }),
  readWebhookToken: async () => null,
  clientForConnection: vi.fn(),
  supabaseWebhookStore: () => ({}),
  cronDeps: () => ({}),
}));
vi.mock("@/lib/jira/cron", () => ({ runCron: h.runCron }));
vi.mock("@/lib/jira/webhook-handler", () => ({ handleWebhook: h.handle }));

import { GET as callback } from "./callback/route";
import { GET as cron } from "./cron/route";
import { POST as webhook } from "./webhook/[token]/route";
import { ConnectError } from "@/lib/jira/connection";
import { createOAuthState, stateSecret } from "@/lib/jira/oauth";

const ACCOUNT = "acct-1";
const USER = "user-1";
const SECRET = stateSecret();

function freshState(over: { accountId?: string; userId?: string; now?: number } = {}) {
  return createOAuthState({ accountId: over.accountId ?? ACCOUNT, userId: over.userId ?? USER }, SECRET, over.now).state;
}

const cb = (qs: Record<string, string>) => callback(new Request(`https://crm.example.com/api/integrations/jira/callback?${new URLSearchParams(qs)}`));
const where = (res: Response) => new URL(res.headers.get("location")!);

const pendingRow = (state: string, over: Record<string, unknown> = {}) => ({
  id: "pend-1",
  account_id: ACCOUNT,
  initiated_by_user_id: USER,
  state,
  status: "pending",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  sites: [],
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  process.env.JIRA_CLIENT_ID = "client-id";
  process.env.JIRA_CLIENT_SECRET = "client-secret";
  process.env.NEXT_PUBLIC_SITE_URL = "https://crm.example.com";
  h.requireCapability.mockResolvedValue({ userId: USER, accountId: ACCOUNT });
  h.consumePending.mockResolvedValue(true);
  h.markPendingDone.mockResolvedValue(undefined);
  h.storeForPicker.mockResolvedValue(undefined);
  h.exchange.mockResolvedValue({ accessToken: "A", refreshToken: "R", expiresAt: new Date(Date.now() + 3_600_000), scope: null });
  h.complete.mockResolvedValue({ connection: { id: "conn-1" }, reconnected: false });
});

describe("GET /api/integrations/jira/callback: state validation", () => {
  it("a denied consent goes back to Settings with a reason, touching nothing", async () => {
    const res = await cb({ error: "access_denied" });
    expect(where(res).pathname).toBe("/settings");
    expect(where(res).searchParams.get("tab")).toBe("integrations");
    expect(where(res).searchParams.get("reason")).toBe("denied");
    expect(h.findPendingByState).not.toHaveBeenCalled();
  });

  it("needs a code and a state", async () => {
    expect(where(await cb({ state: "x" })).searchParams.get("reason")).toBe("invalid_state");
    expect(where(await cb({ code: "c" })).searchParams.get("reason")).toBe("invalid_state");
  });

  it("rejects a forged or tampered state before looking anything up", async () => {
    const good = freshState();
    const [body, sig] = good.split(".");
    const forged = `${Buffer.from(JSON.stringify({ n: "n", a: "other-acct", u: USER, e: Date.now() + 60_000 })).toString("base64url")}.${sig}`;
    for (const state of ["garbage", forged, `${body}.AAAA`]) {
      const res = await cb({ code: "c", state });
      expect(where(res).searchParams.get("jira")).toBe("error");
      expect(where(res).searchParams.get("reason")).toBe("invalid_state");
    }
    expect(h.findPendingByState).not.toHaveBeenCalled();
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("rejects an expired state", async () => {
    const old = freshState({ now: Date.now() - 3_600_000 });
    expect(where(await cb({ code: "c", state: old })).searchParams.get("reason")).toBe("invalid_state");
    expect(h.findPendingByState).not.toHaveBeenCalled();
  });

  it("rejects a valid signature with no live pending row", async () => {
    h.findPendingByState.mockResolvedValue(null);
    expect(where(await cb({ code: "c", state: freshState() })).searchParams.get("reason")).toBe("invalid_state");
    expect(h.requireCapability).not.toHaveBeenCalled();
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("rejects a pending row that belongs to someone else or is not pending any more", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state, { initiated_by_user_id: "another" }));
    expect(where(await cb({ code: "c", state })).searchParams.get("reason")).toBe("invalid_state");
    h.findPendingByState.mockResolvedValue(pendingRow(state, { status: "completed" }));
    expect(where(await cb({ code: "c", state })).searchParams.get("reason")).toBe("invalid_state");
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("rejects when a DIFFERENT person is signed in to Vircle than the one who started the sign-in", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state));
    h.requireCapability.mockResolvedValue({ userId: "someone-else", accountId: ACCOUNT });
    expect(where(await cb({ code: "c", state })).searchParams.get("reason")).toBe("invalid_state");
    expect(h.consumePending).not.toHaveBeenCalled();
  });

  it("is ONE-TIME: a replayed callback finds nothing to consume and exchanges no code", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state));
    h.consumePending.mockResolvedValue(false);
    expect(where(await cb({ code: "c", state })).searchParams.get("reason")).toBe("invalid_state");
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("requires jira.connect again at the callback", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state));
    h.requireCapability.mockRejectedValue(Object.assign(new Error("no"), { status: 403 }));
    const res = await cb({ code: "c", state });
    expect(where(res).searchParams.get("reason")).toBe("forbidden");
    expect(h.exchange).not.toHaveBeenCalled();
  });
});

describe("GET /api/integrations/jira/callback: connecting", () => {
  it("exchanges the code against the exact registered callback address and connects the one site", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state));
    h.sites.mockResolvedValue([{ id: "11111111-2222-4333-8444-555555555555", url: "https://acme.atlassian.net", name: "Acme" }]);
    const res = await cb({ code: "the-code", state });
    expect(h.exchange).toHaveBeenCalledWith(expect.objectContaining({ code: "the-code", redirectUri: "https://crm.example.com/api/integrations/jira/callback" }));
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, userId: USER, site: expect.objectContaining({ name: "Acme" }) }));
    expect(where(res).searchParams.get("jira")).toBe("connected");
    expect(h.markPendingDone).toHaveBeenCalledWith(expect.anything(), "pend-1", "completed");
  });

  it("more than one site goes to the picker with the tokens kept only in the pending row", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state));
    h.sites.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", url: "https://a.atlassian.net", name: "A" },
      { id: "22222222-2222-4333-8444-555555555555", url: "https://b.atlassian.net", name: "B" },
    ]);
    const res = await cb({ code: "c", state });
    expect(where(res).searchParams.get("jira")).toBe("pick");
    expect(where(res).searchParams.get("pending")).toBe("pend-1");
    expect(h.storeForPicker).toHaveBeenCalledTimes(1);
    expect(h.complete).not.toHaveBeenCalled();
    // no token in the redirect
    expect(res.headers.get("location")).not.toMatch(/token|refresh|access/i);
  });

  it("shows why it failed (no sites, another site already linked) and marks the attempt failed", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state));
    h.sites.mockResolvedValue([]);
    expect(where(await cb({ code: "c", state })).searchParams.get("reason")).toBe("no_sites");

    h.sites.mockResolvedValue([{ id: "11111111-2222-4333-8444-555555555555", url: "https://a.atlassian.net", name: "A" }]);
    h.complete.mockRejectedValue(new ConnectError("site_mismatch", "linked to another site"));
    const res = await cb({ code: "c", state });
    expect(where(res).searchParams.get("reason")).toBe("site_mismatch");
    expect(h.markPendingDone).toHaveBeenCalledWith(expect.anything(), "pend-1", "failed");
  });

  it("a failing token exchange is a generic error and never echoes Atlassian's message or the code", async () => {
    const state = freshState();
    h.findPendingByState.mockResolvedValue(pendingRow(state));
    h.exchange.mockRejectedValue(new Error("secret detail invalid_grant the-code"));
    const res = await cb({ code: "the-code", state });
    expect(where(res).searchParams.get("reason")).toBe("unknown");
    expect(res.headers.get("location")).not.toContain("the-code");
    expect(res.headers.get("location")).not.toContain("secret detail");
  });
});

describe("GET /api/integrations/jira/cron", () => {
  const call = (secret?: string) => cron(new Request("https://crm.example.com/api/integrations/jira/cron", { headers: secret === undefined ? {} : { "x-cron-secret": secret } }));

  it("is not configured without AUTOMATION_CRON_SECRET, and refuses a wrong or missing secret", async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    expect((await call("anything")).status).toBe(503);
    process.env.AUTOMATION_CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("s3cre")).status).toBe(401);
    expect((await call("s3cretx")).status).toBe(401);
    expect(h.runCron).not.toHaveBeenCalled();
  });

  it("runs the queue processor with the right secret", async () => {
    process.env.AUTOMATION_CRON_SECRET = "s3cret";
    h.runCron.mockResolvedValue({ jobs: { claimed: 2 } });
    const res = await call("s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: { claimed: 2 } });
  });

  it("does nothing (and is not an error) when Jira is not configured on this server", async () => {
    process.env.AUTOMATION_CRON_SECRET = "s3cret";
    delete process.env.JIRA_CLIENT_ID;
    const res = await call("s3cret");
    expect(res.status).toBe(200);
    expect(h.runCron).not.toHaveBeenCalled();
  });
});

describe("POST /api/integrations/jira/webhook/[token]", () => {
  const post = (token: string, body = "{}", headers: Record<string, string> = {}) =>
    webhook(new Request(`https://crm.example.com/api/integrations/jira/webhook/${token}`, { method: "POST", body, headers }), { params: Promise.resolve({ token }) });

  it("hands the token, the bearer and Atlassian's delivery identifier to the receiver and relays its answer", async () => {
    process.env.JIRA_CLIENT_SECRET = "client-secret";
    h.handle.mockResolvedValue({ status: 200, body: { queued: true } });
    const res = await post("tok", '{"a":1}', { authorization: "Bearer x.y.z", "x-atlassian-webhook-identifier": "delivery-9" });
    expect(res.status).toBe(200);
    expect(h.handle.mock.calls[0][0]).toMatchObject({ pathToken: "tok", authorization: "Bearer x.y.z", identifier: "delivery-9", rawBody: '{"a":1}', clientSecret: "client-secret" });
  });

  it("answers 5xx when the receiver crashes, so Jira retries", async () => {
    h.handle.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await post("tok")).status).toBe(500);
    spy.mockRestore();
  });
});
