/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// The routes of the personal closure form link (migration 185) end to end, except for the database functions (their in-memory stand-in) and the send pipeline
// (injected): who may resend and withdraw, the status of the Inbox cards, the Inbox column's requests for each role, raising with the form, and the one public
// route (no login, no code, one calm answer). The SQL is proved by supabase/ci/verify-185-compliance-chat-link.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";
import { issueFormToken } from "@/lib/sign/registration/token";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { installLinkRpc } from "@/lib/compliance/chat-link/test-support";
import { mintLinkToken } from "@/lib/compliance/chat-link/token";
import { ACCOUNT, ACCOUNT_NUMBER, AGENT, HEAD, OFFICER, OPS, publicWorld } from "@/lib/compliance/test-support";
import type { PublicEnv } from "@/lib/compliance/public/service";

const h = vi.hoisted(() => ({
  db: null as unknown,
  userDb: null as unknown,
  userId: "u",
  accountId: "acct",
  caps: new Set<string>(),
  platformOn: true,
  asked: [] as string[],
  sends: [] as any[],
  windowOpen: true,
  shared: true,
  nowMs: 0,
}));

vi.mock("@/lib/auth/account", () => {
  const ctx = () => ({ userId: h.userId, accountId: h.accountId, role: "agent", supabase: (h.userDb as FakeDb).client(), platform: { status: "active", plan: "x", limits: {}, features: { compliance: h.platformOn }, suspendedReason: null, deletionDueAt: null } });
  const denied = (what: string) => Object.assign(new Error(`This action requires the '${what}' permission`), { status: 403 });
  return {
    getCurrentAccount: async () => ctx(),
    loadCapabilities: async () => h.caps,
    requireCapability: async (c: string) => {
      h.asked.push(c);
      if (!h.caps.has(c)) throw denied(c);
      return { ...ctx(), capabilities: h.caps };
    },
    requireAnyCapability: async (cs: string[]) => {
      h.asked.push(cs.join("|"));
      if (!cs.some((c) => h.caps.has(c))) throw denied(cs.join(" or "));
      return { ...ctx(), capabilities: h.caps };
    },
    toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
  };
});
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/rate-limit-shared", () => ({ checkSharedRateLimit: async () => ({ success: h.shared, remaining: 1, reset: Date.now() + 60_000 }) }));
vi.mock("@/lib/messages/window", () => ({ loadWhatsappWindowOpen: async () => h.windowOpen, isWhatsappWindowOpen: () => h.windowOpen, WHATSAPP_WINDOW_HOURS: 24 }));
vi.mock("@/lib/whatsapp/send-message", async (original) => {
  const real = await original<typeof import("@/lib/whatsapp/send-message")>();
  return {
    ...real,
    sendMessageToConversation: async (_db: unknown, accountId: string, params: any) => {
      h.sends.push({ accountId, params });
      return { messageId: "m0000000-0000-4000-8000-000000000001", whatsappMessageId: "w" };
    },
  };
});
vi.mock("@/lib/compliance/public/http", async (original) => {
  const real = await original<typeof import("@/lib/compliance/public/http")>();
  const env = (): PublicEnv => ({
    admin: (h.db as FakeDb).client(),
    now: () => new Date(h.nowMs),
    limit: async () => true,
    captcha: { enabled: false, verify: async () => true },
    notices: { mail: { emailConfigured: () => true, sendEmail: async () => undefined, loadIdentity: async () => ({}) } as never, now: () => new Date(h.nowMs) },
  });
  return { ...real, publicEnv: env };
});

import { POST as postRaise } from "./raise/route";
import { GET as getLinked } from "./linked/route";
import { GET as getCards } from "./form-links/route";
import { POST as postFormLink } from "./requests/[id]/form-link/route";
import { POST as postSubmit } from "./form-link/submit/route";

const CONV = "c1000000-0000-4000-8000-000000000001";
const CONV2 = "c1000000-0000-4000-8000-000000000002";
const CONTACT = "e1000000-0000-4000-8000-000000000001";
const REQ = "d1000000-0000-4000-8000-000000000001";
const REQ_OLD = "d1000000-0000-4000-8000-000000000002";
const REQ_OTHER = "d1000000-0000-4000-8000-000000000003";
const LINK = "b1000000-0000-4000-8000-000000000001";

let db: FakeDb;
let userDb: FakeDb;
let token: string;

const as = (userId: string, ...caps: string[]) => {
  h.userId = userId;
  h.caps = new Set(caps);
};
const url = (path: string) => `https://halo.test${path}`;
const jsonReq = (method: string, path: string, body?: unknown) => new Request(url(path), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const idCtx = (id: string): any => ({ params: Promise.resolve({ id }) });
const read = async (res: Response) => ({ status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> });
const links = () => db.rows("compliance_form_links") as any[];

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetRateLimitForTests();
  db = publicWorld();
  h.nowMs = Date.UTC(2026, 9, 13, 10, 0, 0);
  installLinkRpc(db, { now: () => h.nowMs });
  db.seed("contacts", [{ id: CONTACT, account_id: ACCOUNT, name: "Siti Aminah", phone: "+60123456881", email: "siti@example.test", language: "ms", deleted_at: null }]);
  db.seed("conversations", [
    { id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp", contact: { language: "ms" } },
    { id: CONV2, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "email", contact: { language: "ms" } },
  ]);
  const base = { account_id: ACCOUNT, source: "inbox", channel: "whatsapp", customer_name: "Siti Aminah", customer_email: null, customer_phone: "+60123456881", contact_id: CONTACT, identity_check: {}, data: {}, data_enc: null, customer_locale: null, retention_until: "2033-10-13T00:00:00Z" };
  db.seed("compliance_requests", [
    { ...base, id: REQ, reference: "CMP-2026-000001", type_key: "closure", status: "received", conversation_id: CONV, created_by: AGENT, created_at: "2026-10-13T09:00:00Z" },
    // another conversation of the same contact, raised by someone else
    { ...base, id: REQ_OLD, reference: "CMP-2026-000002", type_key: "phone_change", status: "officer_review", conversation_id: CONV2, created_by: OPS, created_at: "2026-10-01T09:00:00Z" },
    // another contact altogether
    { ...base, id: REQ_OTHER, reference: "CMP-2026-000003", type_key: "closure", status: "received", conversation_id: null, contact_id: "e9", created_by: OPS, created_at: "2026-10-02T09:00:00Z" },
  ]);
  userDb = new FakeDb();
  userDb.seed("conversations", [{ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp" }, { id: CONV2, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "email" }]);
  db.rpcHandlers.compliance_holders = (args) => ({ data: args.p_cap === "compliance.review" ? [HEAD] : [OFFICER, HEAD], error: null });
  h.db = db;
  h.userDb = userDb;
  h.accountId = ACCOUNT;
  h.asked = [];
  h.sends = [];
  h.windowOpen = true;
  h.shared = true;
  h.platformOn = true;
  as(AGENT, "compliance.raise");
  // a link already sent for REQ
  const m = mintLinkToken(LINK)!;
  token = m.token;
  await db.client().rpc("compliance_mint_form_link", { p_request: REQ, p_actor: AGENT, p_link: LINK, p_token_hash: m.tokenHash, p_conversation: CONV, p_channel: "whatsapp", p_locale: "ms", p_ttl_days: 14 });
  await db.client().rpc("compliance_form_link_sent", { p_link: LINK, p_actor: AGENT, p_message: null, p_delivered: true, p_resend: false, p_reason: null });
});

describe("sending the form again and withdrawing it", () => {
  it("asks for compliance.raise, review or approve, and NOT for the Compliance menu", async () => {
    await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "revoke" }), idCtx(REQ));
    expect(h.asked).toEqual(["compliance.raise|compliance.review|compliance.approve"]);
  });

  it("refuses a person who holds none of the three, even with the Compliance menu", async () => {
    as(OFFICER, "menu.compliance", "compliance.execute", "compliance.reveal", "compliance.manage");
    const r = await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "resend" }), idCtx(REQ));
    expect(r.status).toBe(403);
    expect(h.sends).toHaveLength(0);
    expect(links()).toHaveLength(1);
  });

  it("resends from the case: a new link, the card in the conversation, no address in the answer", async () => {
    const r = await read(await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "resend" }), idCtx(REQ)));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.chatLink).toMatchObject({ status: "sent", mode: "card", channel: "whatsapp" });
    expect(JSON.stringify(r.body)).not.toMatch(/https?:|\/c\/link/);
    expect(links()).toHaveLength(2);
    expect(links().filter((l) => !l.revoked_at)).toHaveLength(1);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].params.linkCard.url).toMatch(/^https:\/\/halo\.test\/c\/link\//);
  });

  it("gives the address once when the 24-hour window has closed", async () => {
    h.windowOpen = false;
    const r = await read(await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "resend" }), idCtx(REQ)));
    expect(r.body.chatLink).toMatchObject({ status: "not_sent", reason: "window_expired" });
    expect(r.body.chatLink.url).toMatch(/^https:\/\/halo\.test\/c\/link\//);
    expect(h.sends).toHaveLength(0);
  });

  it("lets a person who holds only compliance.raise act on their own case, not on another person's", async () => {
    expect((await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "revoke" }), idCtx(REQ))).status).toBe(200);
    as(OPS, "compliance.raise");
    const other = await read(await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "resend" }), idCtx(REQ)));
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("forbidden");
    expect((await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "revoke" }), idCtx(REQ))).status).toBe(403);
  });

  it("lets a reviewer act on any case", async () => {
    as(OFFICER, "compliance.review");
    const r = await read(await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "revoke" }), idCtx(REQ)));
    expect(r.body).toEqual({ revoked: true });
    expect(links()[0]).toMatchObject({ revoked_reason: "revoked", revoked_by: OFFICER });
  });

  it("withdraws the active link once", async () => {
    const first = await read(await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "revoke" }), idCtx(REQ)));
    const second = await read(await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "revoke" }), idCtx(REQ)));
    expect([first.body.revoked, second.body.revoked]).toEqual([true, false]);
  });

  it("refuses a bad id, a bad action and a case of another workspace", async () => {
    expect((await postFormLink(jsonReq("POST", "/api/compliance/requests/nope/form-link", { action: "resend" }), idCtx("nope"))).status).toBe(404);
    expect((await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "burn" }), idCtx(REQ))).status).toBe(400);
    h.accountId = "a0000000-0000-4000-8000-000000000002";
    expect((await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "resend" }), idCtx(REQ))).status).toBe(404);
  });

  it("is limited: the shared hourly budgets and the per-minute one", async () => {
    h.shared = false;
    const r = await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "resend" }), idCtx(REQ));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect(h.sends).toHaveLength(0);
    h.shared = true;
    let last = 200;
    for (let i = 0; i < 22; i++) last = (await postFormLink(jsonReq("POST", `/api/compliance/requests/${REQ}/form-link`, { action: "revoke" }), idCtx(REQ))).status;
    expect(last).toBe(429);
  });
});

describe("the status of the cards in a conversation", () => {
  it("lists them with their state, and the case's id only for a person who may act", async () => {
    const mine = await read(await getCards(new Request(url(`/api/compliance/form-links?conversationId=${CONV}`))));
    expect(mine.status).toBe(200);
    expect(mine.body.links).toEqual([{ id: LINK, state: "sent", expiresAt: links()[0].expires_at, canManage: true, requestId: REQ }]);
    as(OPS, "compliance.raise");
    const theirs = await read(await getCards(new Request(url(`/api/compliance/form-links?conversationId=${CONV}&ids=${LINK}`))));
    expect(theirs.body.links).toEqual([{ id: LINK, state: "sent", expiresAt: links()[0].expires_at, canManage: false }]);
  });

  it("refuses a person with none of the three permissions, a bad id, and a conversation they cannot open", async () => {
    as(OPS, "menu.compliance");
    expect((await getCards(new Request(url(`/api/compliance/form-links?conversationId=${CONV}`)))).status).toBe(403);
    as(AGENT, "compliance.raise");
    expect((await getCards(new Request(url("/api/compliance/form-links?conversationId=nope")))).status).toBe(400);
    expect((await getCards(new Request(url("/api/compliance/form-links")))).status).toBe(400);
    expect((await getCards(new Request(url("/api/compliance/form-links?conversationId=c1000000-0000-4000-8000-0000000000ff")))).status).toBe(404);
  });
});

describe("the Inbox column's requests", () => {
  it("shows a holder of a compliance permission every request linked to the conversation or its contact, with the id to open it", async () => {
    as(OFFICER, "menu.compliance", "compliance.review");
    const r = await read(await getLinked(new Request(url(`/api/compliance/linked?conversationId=${CONV}`))));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.enabled).toBe(true);
    expect(r.body.items.map((i: any) => i.reference).sort()).toEqual(["CMP-2026-000001", "CMP-2026-000002"]);
    const closure = r.body.items.find((i: any) => i.reference === "CMP-2026-000001");
    expect(closure).toMatchObject({ id: REQ, typeKey: "closure", status: "received", step: "received" });
    expect(r.body.items.find((i: any) => i.reference === "CMP-2026-000002")).toMatchObject({ status: "in_review", step: "officer_review" });
  });

  it("shows a person who holds only compliance.raise just what they raised, as the minimal projection, with no id", async () => {
    const r = await read(await getLinked(new Request(url(`/api/compliance/linked?conversationId=${CONV}`))));
    expect(r.body.items).toHaveLength(1);
    expect(Object.keys(r.body.items[0]).sort()).toEqual(["raisedAt", "reference", "status", "typeKey", "typeLabel", "typeLabelL10n"]);
    expect(r.body.items[0]).toMatchObject({ reference: "CMP-2026-000001", status: "received" });
    expect(JSON.stringify(r.body)).not.toMatch(/Siti|example\.test|\+60|d1000000/);
  });

  it("shows a person who raised nothing, and holds no permission, nothing", async () => {
    as("66666666-6666-4666-8666-666666666666");
    h.caps = new Set();
    const r = await read(await getLinked(new Request(url(`/api/compliance/linked?conversationId=${CONV}`))));
    expect(r.body).toEqual({ enabled: true, items: [] });
    // a person who raised a request for this contact still sees that one (their own), on the contact's every conversation
    as(OPS);
    h.caps = new Set();
    expect((await read(await getLinked(new Request(url(`/api/compliance/linked?conversationId=${CONV}`))))).body.items.map((i: any) => i.reference)).toEqual(["CMP-2026-000002"]);
  });

  it("answers nothing at all when the workspace has Compliance off", async () => {
    h.platformOn = false;
    as(OFFICER, "menu.compliance", "compliance.review");
    expect((await read(await getLinked(new Request(url(`/api/compliance/linked?conversationId=${CONV}`))))).body).toEqual({ enabled: false, items: [] });
  });

  it("refuses a bad id and a conversation the person cannot open", async () => {
    expect((await getLinked(new Request(url("/api/compliance/linked?conversationId=x")))).status).toBe(400);
    expect((await getLinked(new Request(url("/api/compliance/linked?conversationId=c1000000-0000-4000-8000-0000000000ff")))).status).toBe(404);
  });
});

describe("raising with the closure form", () => {
  const body = (over: Record<string, unknown> = {}) => ({ typeKey: "closure", conversationId: CONV, customerName: "Aminah", customerEmail: "aminah@example.test", customerPhone: "019 111 2222", answers: { reason: "Moving" }, sendClosureForm: true, ...over });

  beforeEach(() => {
    // REQ already stands for the contact: close it so a new request may be raised
    (db.rows("compliance_requests") as any[])[0].status = "closed";
    (userDb.rows("conversations") as any[]).forEach((c) => (c.contact_id = "e2000000-0000-4000-8000-000000000001"));
    (db.rows("conversations") as any[]).forEach((c) => (c.contact_id = "e2000000-0000-4000-8000-000000000001"));
  });

  it("makes the case and sends the card; the answer has no address", async () => {
    const r = await read(await postRaise(jsonReq("POST", "/api/compliance/raise", body())));
    expect(r.body).toMatchObject({ reference: expect.any(String) });
    expect(r.status).toBe(201);
    expect(r.body.reference).toMatch(/^CMP-/);
    expect(r.body.chatLink).toMatchObject({ status: "sent", mode: "card" });
    expect(JSON.stringify(r.body)).not.toMatch(/https?:|\/c\/link/);
    expect(h.sends).toHaveLength(1);
  });

  it("gives the address ONCE when the chat could not take it, and the case stands", async () => {
    h.windowOpen = false;
    const r = await read(await postRaise(jsonReq("POST", "/api/compliance/raise", body())));
    expect(r.status).toBe(201);
    expect(r.body.chatLink).toMatchObject({ status: "not_sent", reason: "window_expired" });
    expect(r.body.chatLink.url).toContain("/c/link/");
    expect(db.rows("compliance_requests").length).toBeGreaterThan(3);
  });

  it("is limited by an hourly budget per person when the form is sent", async () => {
    h.shared = false;
    const r = await postRaise(jsonReq("POST", "/api/compliance/raise", body()));
    expect(r.status).toBe(429);
    expect(h.sends).toHaveLength(0);
    // a raise that sends nothing is not held by it
    expect((await postRaise(jsonReq("POST", "/api/compliance/raise", body({ sendClosureForm: false, answers: { confirm_closure: true, children_finished_school: true, allowances_cancelled: true, bank_name: "Maybank", bank_account_number: ACCOUNT_NUMBER, bank_account_holder: "Aminah" } })))).status).toBe(201);
  });

  it("sends nothing unless asked", async () => {
    const r = await read(await postRaise(jsonReq("POST", "/api/compliance/raise", body({ sendClosureForm: false, answers: { confirm_closure: true, children_finished_school: true, allowances_cancelled: true, bank_name: "Maybank", bank_account_number: ACCOUNT_NUMBER, bank_account_holder: "Aminah" } }))));
    expect(r.status).toBe(201);
    expect(r.body.chatLink).toBeUndefined();
    expect(h.sends).toHaveLength(0);
  });
});

describe("the public route", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    linkToken: token,
    token: issueFormToken(LINK, new Date(h.nowMs - 60_000)),
    email: "siti.typed@example.test",
    locale: "en",
    wantClose: "yes",
    name: "Siti Aminah",
    phone: "",
    childrenFinished: true,
    allowancesStopped: true,
    bankChoice: "Maybank",
    accountNumber: ACCOUNT_NUMBER,
    accountHolder: "Siti Aminah",
    declaration: true,
    website: "",
    ...over,
  });
  const form = (over: Record<string, unknown> = {}, files: Record<string, Uint8Array> = {}) => {
    const f = new FormData();
    f.set("payload", JSON.stringify(payload(over)));
    for (const [k, v] of Object.entries(files)) f.set(k, new File([v as BlobPart], `${k}.pdf`, { type: "application/pdf" }));
    return f;
  };
  const post = (f: FormData | string, headers: Record<string, string> = {}) => postSubmit(new Request(url("/api/compliance/form-link/submit"), { method: "POST", headers: { "x-forwarded-for": "203.0.113.9", ...headers }, body: f }));

  it("takes the form with no login, no cookie and no code, and updates the existing case", async () => {
    const r = await read(await post(form()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, reference: "CMP-2026-000001" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("set-cookie")).toBeNull();
    const c = (db.rows("compliance_requests") as any[]).find((x) => x.id === REQ);
    expect(c).toMatchObject({ customer_email: "siti.typed@example.test", status: "received", identity_check: {} });
    expect(db.rows("compliance_requests")).toHaveLength(3);
  });

  it("answers an unusable link with one 404 that says nothing more, whichever way it is unusable", async () => {
    const wrong = await read(await post(form({ linkToken: `${token.split(".")[0]}.${"A".repeat(43)}` })));
    const garbage = await read(await post(form({ linkToken: "x" })));
    await post(form());
    const used = await read(await post(form()));
    for (const r of [wrong, garbage, used]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ code: "not_found" });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("reports what is wrong with the details by field, and a fresh token when the page's own token is no good", async () => {
    const bad = await read(await post(form({ childrenFinished: false, email: "x" })));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ code: "invalid", problems: { childrenFinished: "must_acknowledge", email: "invalid" } });
    const retry = await read(await post(form({ token: undefined })));
    expect(retry.status).toBe(400);
    expect(retry.body.code).toBe("token_invalid");
    expect(retry.body.token).toContain(LINK);
  });

  it("refuses what is not a multipart post, and a post that is too large", async () => {
    expect((await post(JSON.stringify(payload()), { "content-type": "application/json" })).status).toBe(400);
    // a body that declares itself larger than the cap is refused before it is read
    expect((await post(form(), { "content-length": String(30 * 1024 * 1024) })).status).toBe(413);
  });

  it("has a cheap ceiling per caller before anything is looked up", async () => {
    let last = 200;
    for (let i = 0; i < 92; i++) last = (await post(form({ linkToken: "x" }))).status;
    expect(last).toBe(429);
  });

  it("never carries the link, a stored answer or the parent's typing back", async () => {
    const r = await post(form());
    const text = await r.text();
    expect(text).not.toMatch(/siti\.typed|example\.test|8800|Maybank|\/c\/link|b1000000/);
  });
});
