/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// The Part B staff routes end to end except for the database function bodies and the network: raising from the Inbox and from tickets (compliance.raise
// and NOT menu.compliance), the raiser's minimal projection, the customer-email route, the public forms' settings, the reports and their export, the badge,
// the sign-off's new fields, and the job that now also emails the clock alerts. The database is the in-memory FakeDb; the SQL is proved by
// supabase/ci/verify-184-compliance-intake.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { ACCOUNT, ACCOUNT_NUMBER, AGENT, CLOSURE_ANSWERS, HEAD, OFFICER, OPS, publicWorld } from "@/lib/compliance/test-support";

const h = vi.hoisted(() => ({
  db: null as unknown,
  userDb: null as unknown,
  userId: "u",
  accountId: "acct",
  caps: new Set<string>(),
  asked: [] as string[],
  sent: [] as { to: string; subject: string }[],
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    h.asked.push(capability);
    if (!h.caps.has(capability)) throw Object.assign(new Error(`This action requires the '${capability}' permission`), { status: 403 });
    return { userId: h.userId, accountId: h.accountId, role: "agent", capabilities: h.caps, supabase: (h.userDb as FakeDb).client() };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/email/workspace-mail", async (original) => {
  const real = await original<typeof import("@/lib/email/workspace-mail")>();
  return {
    ...real,
    // every email the routes send goes to the test's list
    realWorkspaceMailDeps: { emailConfigured: () => true, sendEmail: async (m: any) => void h.sent.push({ to: m.to, subject: m.subject }), loadIdentity: async () => ({}) },
  };
});

import { POST as postRaise } from "./raise/route";
import { GET as getContext } from "./raise/context/route";
import { GET as getRaised } from "./raised/route";
import { POST as postNotices } from "./requests/[id]/notices/route";
import { POST as postTransition } from "./requests/[id]/transition/route";
import { POST as postCreate } from "./requests/route";
import { GET as getForms, PATCH as patchForms } from "./public-forms/route";
import { GET as getReport } from "./reports/route";
import { GET as getExport } from "./reports/export/route";
import { GET as getBadge } from "./badge/route";
import { GET as getCron } from "./clock-cron/route";

const MENU = "menu.compliance";
const CONV = "c1000000-0000-4000-8000-000000000001";
const CONTACT = "e1000000-0000-4000-8000-000000000001";

let db: FakeDb;
let userDb: FakeDb;
const as = (userId: string, ...caps: string[]) => {
  h.userId = userId;
  h.caps = new Set(caps);
};
const url = (path: string) => `https://halo.test${path}`;
const jsonReq = (method: string, path: string, body?: unknown) => new Request(url(path), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const idCtx = (id: string): any => ({ params: Promise.resolve({ id }) });
const read = async (res: Response) => ({ status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetRateLimitForTests();
  db = publicWorld();
  db.seed("contacts", [{ id: CONTACT, account_id: ACCOUNT, name: "Siti Aminah", phone: "012-334 4556", email: "siti@example.test", language: "ms", deleted_at: null }]);
  db.seed("conversations", [{ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp" }]);
  db.rpcHandlers.compliance_holders = (args) => ({ data: args.p_cap === "compliance.approve" ? [HEAD] : [OFFICER, HEAD], error: null });
  userDb = new FakeDb();
  userDb.seed("conversations", [{ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp" }]);
  h.db = db;
  h.userDb = userDb;
  h.accountId = ACCOUNT;
  h.asked = [];
  h.sent = [];
  as(AGENT, "compliance.raise");
});

const raiseBody = (over: Record<string, unknown> = {}) => ({
  typeKey: "phone_change",
  conversationId: CONV,
  customerName: "Siti Aminah",
  customerPhone: "012-334 4556",
  channel: "whatsapp",
  answers: { current_phone: "012-334 4556", new_phone: "019 888 7766" },
  note: "Verified by call back",
  ...over,
});

describe("raising needs compliance.raise and nothing else", () => {
  it("asks only for compliance.raise, never menu.compliance, on all three routes", async () => {
    await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody()));
    await getContext(new Request(url(`/api/compliance/raise/context?conversationId=${CONV}`)));
    await getRaised(new Request(url("/api/compliance/raised")));
    expect(h.asked).toEqual(["compliance.raise", "compliance.raise", "compliance.raise"]);
  });

  it("refuses a person who holds the Compliance menu and every work permission but not compliance.raise (a workspace with the flag off loses all of them)", async () => {
    as(OFFICER, MENU, "compliance.review", "compliance.approve");
    const rs = [
      await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody())),
      await getContext(new Request(url(`/api/compliance/raise/context?conversationId=${CONV}`))),
      await getRaised(new Request(url("/api/compliance/raised"))),
    ];
    expect(rs.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("raises from a conversation: 201 with the reference and the status, and nothing else for a person without a compliance permission", async () => {
    const r = await read(await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody())));
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.body).sort()).toEqual(["reference", "status"]);
    expect(r.body.reference).toMatch(/^CMP-\d{4}-\d{6}$/);
    expect(db.rows("compliance_requests")[0]).toMatchObject({ source: "inbox", created_by: AGENT, conversation_id: CONV, contact_id: CONTACT });
    expect(db.rows("messages")[0]).toMatchObject({ content_text: `Compliance request ${r.body.reference} raised`, is_internal: true });
  });

  it("gives a person who also holds a compliance permission the case's id", async () => {
    as(OFFICER, "compliance.raise", "compliance.review");
    const r = await read(await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody())));
    expect(r.body.id).toBe((db.rows("compliance_requests")[0] as any).id);
  });

  it("answers a duplicate with 409 and no reference for a plain raiser", async () => {
    await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody()));
    const again = await read(await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody())));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "duplicate_open", code: "duplicate_open" });
    expect(JSON.stringify(again.body)).not.toContain("CMP-");
    as(OFFICER, "compliance.raise", "compliance.review");
    const named = await read(await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody())));
    expect(named.body.issues).toEqual([{ field: "reference", code: expect.stringMatching(/^CMP-/) }]);
  });

  it("validates the body: one target, a type, and answers that fit", async () => {
    expect((await postRaise(jsonReq("POST", "/x", raiseBody({ conversationId: undefined })))).status).toBe(400);
    expect((await postRaise(jsonReq("POST", "/x", raiseBody({ ticketId: "t", conversationId: CONV })))).status).toBe(400);
    expect((await postRaise(jsonReq("POST", "/x", raiseBody({ typeKey: undefined })))).status).toBe(400);
    expect((await read(await postRaise(jsonReq("POST", "/x", raiseBody({ answers: { current_phone: "x", new_phone: "y" } }))))).body.code).toBe("validation_failed");
    expect((await read(await postRaise(jsonReq("POST", "/x", raiseBody({ conversationId: "c1000000-0000-4000-8000-0000000000ff" }))))).body.code).toBe("not_found");
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("is limited per person", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await postRaise(jsonReq("POST", "/x", raiseBody({ typeKey: "nope" })))).status;
    expect(last).toBe(429);
  });
});

describe("the dialog's context and the raiser's own list", () => {
  it("gives the contact to prefill, the types with their staff fields and which types are already open (no reference)", async () => {
    await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody()));
    const r = await read(await getContext(new Request(url(`/api/compliance/raise/context?conversationId=${CONV}`))));
    expect(r.status).toBe(200);
    expect(r.body.contact).toMatchObject({ name: "Siti Aminah", email: "siti@example.test", language: "ms" });
    expect(r.body.types.map((t: any) => t.key)).toEqual(["closure", "withdrawal", "phone_change"]);
    expect(r.body.open).toEqual(["phone_change"]);
    expect(JSON.stringify(r.body)).not.toContain("CMP-");
    expect((await getContext(new Request(url("/api/compliance/raise/context")))).status).toBe(400);
  });

  it("lists only what the person raised, as reference, type and status: never the customer, a bank detail or a reason", async () => {
    await postRaise(jsonReq("POST", "/api/compliance/raise", raiseBody()));
    db.seed("compliance_requests", [{ id: "other-1", account_id: ACCOUNT, reference: "CMP-2026-000500", type_key: "closure", source: "inbox", status: "received", customer_name: "Someone Else", created_by: OFFICER }]);
    const r = await read(await getRaised(new Request(url("/api/compliance/raised"))));
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(Object.keys(r.body.items[0]).sort()).toEqual(["raisedAt", "reference", "status", "typeKey", "typeLabel", "typeLabelL10n"]);
    expect(JSON.stringify(r.body)).not.toMatch(/Siti|Someone|siti@|0123|8800/);
    const scoped = await read(await getRaised(new Request(url(`/api/compliance/raised?conversationId=${CONV}`))));
    expect(scoped.body.items).toHaveLength(1);
    const none = await read(await getRaised(new Request(url("/api/compliance/raised?conversationId=c1000000-0000-4000-8000-0000000000ee"))));
    expect(none.body.items).toHaveLength(0);
    expect((await getRaised(new Request(url("/api/compliance/raised?conversationId=bad")))).status).toBe(400);
  });
});

describe("the customer-email route", () => {
  async function aCase() {
    as(OFFICER, MENU, "compliance.review");
    const r = await read(await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "closure", customerName: "Siti Aminah", customerEmail: "siti@example.test", customerPhone: "012 345 6789", notify: false, answers: CLOSURE_ANSWERS })));
    expect(r.status).toBe(201);
    return r.body.id as string;
  }

  it("needs review or approve; previews without sending; sends the one a person writes, once per nonce; refuses a bank detail", async () => {
    const id = await aCase();
    const post = (body: Record<string, unknown>) => postNotices(jsonReq("POST", "/x", body), idCtx(id));
    const preview = await read(await post({ action: "preview", kind: "more_info", text: "Please send the letter again." }));
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ language: "en", hasAddress: true });
    expect(preview.body.preview.body).toContain("Please send the letter again.");
    expect(h.sent).toHaveLength(0);

    const sent = await read(await post({ action: "send", kind: "more_info", text: "Please send the letter again.", nonce: "nonce-route-1" }));
    expect(sent.body).toEqual({ notice: { status: "sent", language: "en" } });
    expect(h.sent).toHaveLength(1);
    expect((await read(await post({ action: "send", kind: "more_info", text: "Please send the letter again.", nonce: "nonce-route-1" }))).body.notice.status).toBe("duplicate");
    expect(h.sent).toHaveLength(1);

    expect((await read(await post({ action: "send", kind: "more_info", text: `my account ${ACCOUNT_NUMBER}`, nonce: "nonce-route-2" }))).body.code).toBe("validation_failed");
    // a notice a move sends is not sent by hand, except again after it failed
    expect((await post({ action: "send", kind: "completed" })).status).toBe(400);
    expect((await post({ action: "send", kind: "unknown", text: "x" })).status).toBe(400);
    expect((await post({ action: "nope", kind: "more_info" })).status).toBe(400);
    expect(JSON.stringify(sent.body)).not.toContain("siti@example.test");

    as(OPS, MENU, "compliance.execute");
    expect((await post({ action: "preview", kind: "completed" })).status).toBe(403);
  });

  it("a staff-made case emails the confirmation unless asked not to, and says what happened", async () => {
    as(OFFICER, MENU, "compliance.review");
    const body = { typeKey: "closure", customerName: "Siti Aminah", customerEmail: "siti@example.test", answers: CLOSURE_ANSWERS };
    const a = await read(await postCreate(jsonReq("POST", "/x", body)));
    expect(a.body.notice).toMatchObject({ status: "sent" });
    expect(h.sent).toHaveLength(1);
    const b = await read(await postCreate(jsonReq("POST", "/x", { ...body, customerEmail: "b@example.test", notify: false })));
    expect(b.body.notice).toBeUndefined();
    const c = await read(await postCreate(jsonReq("POST", "/x", { ...body, customerEmail: undefined })));
    expect(c.body.notice).toBeUndefined();
    expect(h.sent).toHaveLength(1);
  });
});

describe("the sign-off's new fields", () => {
  it("a rejection without a category or the customer's words is refused before anything moves; with both it passes them to the database", async () => {
    as(OFFICER, MENU, "compliance.review");
    const made = await read(await postCreate(jsonReq("POST", "/x", { typeKey: "closure", customerName: "Siti", notify: false, answers: CLOSURE_ANSWERS })));
    const id = made.body.id as string;
    (db.rows("compliance_requests").find((r: any) => r.id === id) as any).status = "awaiting_signoff";
    const calls: any[] = [];
    db.rpcHandlers.compliance_transition = (args) => {
      calls.push(args);
      return { data: {}, error: null };
    };
    as(HEAD, MENU, "compliance.review", "compliance.approve");
    const reject = (b: Record<string, unknown>) => postTransition(jsonReq("POST", "/x", { to: "rejected", note: "Mismatch", ...b }), idCtx(id));
    expect((await read(await reject({}))).body.code).toBe("category_required");
    expect((await read(await reject({ reasonCategory: "duplicate" }))).body.code).toBe("customer_reason_required");
    expect(calls).toHaveLength(0);
    const ok = await read(await reject({ reasonCategory: "duplicate", customerReason: "We already have this request.", notify: false }));
    expect(ok.status).toBe(200);
    expect(calls[0].p_payload).toEqual({ reason_category: "duplicate", customer_reason: "We already have this request." });
    expect(ok.body.notice).toBeUndefined();
  });
});

describe("the public forms' settings", () => {
  it("need compliance.manage; list both forms; and the first save makes the address", async () => {
    db.tables.compliance_public_forms = [];
    as(OFFICER, MENU, "compliance.review");
    expect((await getForms()).status).toBe(403);
    expect((await patchForms(jsonReq("PATCH", "/x", { typeKey: "closure", enabled: true }))).status).toBe(403);
    as(OFFICER, MENU, "compliance.manage");
    const list = await read(await getForms());
    expect(list.body.forms.map((f: any) => [f.typeKey, f.exists, f.enabled, f.ready])).toEqual([["closure", false, false, true], ["withdrawal", false, false, true]]);
    const saved = await read(await patchForms(jsonReq("PATCH", "/x", { typeKey: "closure", enabled: true, notice: { en: "Read this", ms: "Baca ini" }, banks: "Maybank\nCIMB Bank" })));
    expect(saved.status).toBe(200);
    const f = saved.body.forms.find((x: any) => x.typeKey === "closure");
    expect(f).toMatchObject({ exists: true, enabled: true, notice: { en: "Read this", ms: "Baca ini" }, banks: ["Maybank", "CIMB Bank"], maxAmount: 10000 });
    expect(f.slug).toMatch(/^[a-z0-9][a-z0-9-]{4,38}[a-z0-9]$/);
  });

  it("refuses to switch a form on when its type lacks the fields, never offers a phone change, and renews the address on request", async () => {
    as(OFFICER, MENU, "compliance.manage");
    const closure = db.rows("compliance_request_types").find((t: any) => t.key === "closure") as any;
    const fields = closure.fields;
    closure.fields = fields.filter((f: any) => f.key !== "declaration");
    expect((await read(await patchForms(jsonReq("PATCH", "/x", { typeKey: "closure", enabled: true })))).body.code).toBe("type_unavailable");
    closure.fields = fields;
    expect((await read(await patchForms(jsonReq("PATCH", "/x", { typeKey: "phone_change", enabled: true })))).body.code).toBe("invalid_request");
    const before = (await read(await getForms())).body.forms[0].slug;
    const after = (await read(await patchForms(jsonReq("PATCH", "/x", { typeKey: "closure", regenerateSlug: true })))).body.forms[0].slug;
    expect(after).not.toBe(before);
    expect((await read(await patchForms(jsonReq("PATCH", "/x", { typeKey: "withdrawal", maxAmount: -5 })))).body.code).toBe("validation_failed");
    expect((await read(await patchForms(jsonReq("PATCH", "/x", { typeKey: "withdrawal", maxAmount: 2500.5 })))).body.forms[1].maxAmount).toBe(2500.5);
  });
});

describe("the reports and the badge", () => {
  beforeEach(() => {
    db.seed("compliance_requests", [
      { id: "r1", account_id: ACCOUNT, reference: "CMP-2026-000001", type_key: "closure", source: "form", status: "completed", received_at: "2026-09-20T00:00:00.000Z", target_due_at: "2026-10-04T00:00:00.000Z", hard_stop_at: "2026-10-20T00:00:00.000Z", completed_at: "2026-10-01T00:00:00.000Z", decided_at: "2026-09-25T00:00:00.000Z", signoff: { decision: "approved", by: HEAD }, customer_name: "Siti", identity_check: {} },
      { id: "r2", account_id: ACCOUNT, reference: "CMP-2026-000002", type_key: "closure", source: "inbox", status: "awaiting_signoff", received_at: "2026-10-01T00:00:00.000Z", signoff: {}, customer_name: "Ali", identity_check: { verified_by: OFFICER } },
    ]);
  });

  it("serve the officer and the Head only, with the menu", async () => {
    as(OPS, MENU, "compliance.execute");
    expect((await getReport(new Request(url("/api/compliance/reports")))).status).toBe(403);
    expect((await getExport(new Request(url("/api/compliance/reports/export")))).status).toBe(403);
    expect((await getBadge()).status).toBe(403);
    as(OFFICER, "compliance.review");
    expect((await getReport(new Request(url("/api/compliance/reports")))).status).toBe(403);
    as(OFFICER, MENU, "compliance.review");
    const r = await read(await getReport(new Request(url("/api/compliance/reports"))));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, open: 1, finished: 1 });
    expect(JSON.stringify(r.body)).not.toMatch(/Siti|Ali"/);
  });

  it("export a CSV with no personal data, record the export first, and are limited to ten an hour", async () => {
    as(OFFICER, MENU, "compliance.review");
    const res = await getExport(new Request(url("/api/compliance/reports/export?type=closure")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csv = await res.text();
    expect(csv).toContain("CMP-2026-000001");
    expect(csv).not.toMatch(/Siti|Ali/);
    expect(db.rows("compliance_exports")[0]).toMatchObject({ account_id: ACCOUNT, actor: OFFICER, row_count: 2, filters: { from: null, to: null, type: "closure" } });
    db.failNext.compliance_exports = "boom";
    expect((await getExport(new Request(url("/api/compliance/reports/export")))).status).toBe(503);
    let status = 200;
    for (let i = 0; i < 12; i++) status = (await getExport(new Request(url("/api/compliance/reports/export")))).status;
    expect(status).toBe(429);
  });

  it("count for the badge what waits for this person", async () => {
    as(OFFICER, MENU, "compliance.review", "compliance.approve");
    // r2 awaits sign-off but the officer recorded its identity check: not theirs to sign
    expect((await read(await getBadge())).body).toEqual({ count: 0 });
    as(HEAD, MENU, "compliance.approve");
    const head = await read(await getBadge());
    expect(head.body).toEqual({ count: 1 });
    expect(head.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the hourly job", () => {
  const SECRET = "cron-secret-for-tests";
  it("also emails the clock alerts the sweep raised (once) and clears old codes, and a failure of either never fails the sweep", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    db.rpcHandlers.compliance_clock_alert_sweep = () => ({ data: { alerted: 1, notified: 2 }, error: null });
    db.rpcHandlers.cron_heartbeat = () => ({ data: null, error: null });
    db.seed("compliance_requests", [{ id: "r1", account_id: ACCOUNT, reference: "CMP-2026-000001", type_key: "closure", source: "form", status: "officer_review", received_at: "2026-09-20T00:00:00.000Z", customer_name: "x", closed_at: null, completed_at: null }]);
    db.seed("compliance_request_events", [{ id: "e1", account_id: ACCOUNT, request_id: "r1", kind: "clock_alert", actor: null, at: new Date().toISOString(), detail: { threshold: 5, days_left: 5 } }]);
    db.seed("compliance_email_codes", [{ id: "old", account_id: ACCOUNT, form_id: "f", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }, { id: "new", account_id: ACCOUNT, form_id: "f", created_at: new Date().toISOString() }]);
    const call = () => getCron(new Request(url("/api/compliance/clock-cron"), { headers: { "x-cron-secret": SECRET } }));
    const first = await read(await call());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ alerted: 1, notified: 2, emails: { looked: 1, sent: 1 }, codes: { purged: 1 } });
    expect(h.sent.map((m) => m.to).sort()).toEqual(["harun@example.test", "olivia@example.test"]);
    const second = await read(await call());
    expect(second.body.emails).toMatchObject({ sent: 0 });
    expect(h.sent).toHaveLength(2);
    expect(db.rows("compliance_email_codes").map((c: any) => c.id)).toEqual(["new"]);
    vi.unstubAllEnvs();
  });
});
