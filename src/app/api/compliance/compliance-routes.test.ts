/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// The /api/compliance routes end to end except for the database function bodies and the network: the staff wrapper (menu.compliance first, then the
// capability each route needs, a rate limit per person), the validation of what comes in, the answers (no-store, codes, never the database's words),
// the events each route writes, and the headers of a file. The database is the in-memory FakeDb; SQL rules are proved by supabase/ci/verify-183-*.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { ACCOUNT, ACCOUNT_NUMBER, BANK_NAME, CLOSURE_ANSWERS, HEAD, OFFICER, OPS, eventsOf, world } from "@/lib/compliance/test-support";

const h = vi.hoisted(() => ({
  db: null as unknown,
  userId: "u",
  accountId: "acct",
  caps: new Set<string>(),
  asked: [] as string[],
  shared: { success: true, reset: Date.now() + 30_000, remaining: 5, limit: 10 },
  sharedKeys: [] as string[],
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    h.asked.push(capability);
    if (!h.caps.has(capability)) throw Object.assign(new Error(`This action requires the '${capability}' permission`), { status: 403 });
    return { userId: h.userId, accountId: h.accountId, role: "agent", capabilities: h.caps };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/rate-limit-shared", () => ({
  checkSharedRateLimit: async (key: string) => {
    h.sharedKeys.push(key);
    return { ...h.shared };
  },
}));

import { GET as getList, POST as postCreate } from "./requests/route";
import { GET as getDetail, PATCH as patchDetail } from "./requests/[id]/route";
import { POST as postTransition } from "./requests/[id]/transition/route";
import { POST as postStep } from "./requests/[id]/steps/[step]/route";
import { POST as postStanding } from "./requests/[id]/standing/route";
import { POST as postClock } from "./requests/[id]/clock/route";
import { POST as postNote } from "./requests/[id]/notes/route";
import { POST as postReveal } from "./requests/[id]/reveal/route";
import { POST as postFile } from "./requests/[id]/files/route";
import { GET as getFile } from "./requests/[id]/files/[fileId]/route";
import { GET as getTypes, POST as postType } from "./types/route";
import { PATCH as patchType } from "./types/[key]/route";
import { GET as getCron } from "./clock-cron/route";

const MENU = "menu.compliance";
const ALL = [MENU, "compliance.review", "compliance.approve", "compliance.reveal", "compliance.execute", "compliance.manage"];
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

let db: FakeDb;
const as = (userId: string, ...caps: string[]) => {
  h.userId = userId;
  h.caps = new Set(caps);
};
const url = (path: string) => `https://halo.test${path}`;
const jsonReq = (method: string, path: string, body?: unknown) =>
  new Request(url(path), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const idCtx = (id: string, extra: Record<string, string> = {}): any => ({ params: Promise.resolve({ id, ...extra }) });
const read = async (res: Response) => ({ status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> });

const newCase = async (): Promise<{ id: string; reference: string }> => {
  as(OFFICER, MENU, "compliance.review");
  const r = await read(await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "closure", customerName: "Siti Aminah", customerPhone: "012 345 6789", channel: "whatsapp", answers: CLOSURE_ANSWERS })));
  expect(r.status).toBe(201);
  return r.body as any;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetRateLimitForTests();
  db = world();
  h.db = db;
  h.accountId = ACCOUNT;
  h.asked = [];
  h.shared = { success: true, reset: Date.now() + 30_000, remaining: 5, limit: 10 };
  h.sharedKeys = [];
  as(OFFICER, ...ALL);
});

describe("the staff wrapper: menu.compliance first, then the capability of the route", () => {
  it("every route asks for menu.compliance first, and a workspace with the flag off (no menu.compliance) gets a 403 from all of them", async () => {
    const { id } = await (async () => {
      as(OFFICER, ...ALL);
      return newCase();
    })();
    as(OFFICER, ...ALL.filter((c) => c !== MENU));
    h.asked = [];
    const call = [
      await getList(new Request(url("/api/compliance/requests"))),
      await postCreate(jsonReq("POST", "/api/compliance/requests", {})),
      await getDetail(new Request(url("/x")), idCtx(id)),
      await patchDetail(jsonReq("PATCH", "/x", {}), idCtx(id)),
      await postTransition(jsonReq("POST", "/x", { to: "identity_check" }), idCtx(id)),
      await postStep(jsonReq("POST", "/x", { done: true }), idCtx(id, { step: "refund" })),
      await postStanding(jsonReq("POST", "/x", { duesOutstanding: false }), idCtx(id)),
      await postClock(jsonReq("POST", "/x", { action: "pause", note: "x" }), idCtx(id)),
      await postNote(jsonReq("POST", "/x", { text: "x" }), idCtx(id)),
      await postReveal(jsonReq("POST", "/x"), idCtx(id)),
      await postFile(jsonReq("POST", "/x"), idCtx(id)),
      await getFile(new Request(url("/x")), idCtx(id, { fileId: id })),
      await getTypes(),
      await postType(jsonReq("POST", "/x", {})),
      await patchType(jsonReq("PATCH", "/x", {}), { params: Promise.resolve({ key: "closure" }) }),
    ];
    expect(call.map((r) => r.status)).toEqual(Array(15).fill(403));
    expect(new Set(h.asked)).toEqual(new Set([MENU]));
    expect(db.rows("compliance_request_events").filter((e: any) => e.kind !== "created")).toHaveLength(0);
  });

  it("menu.compliance alone opens no data route (the work capabilities do)", async () => {
    const { id } = await newCase();
    as(AGENT_ID, MENU);
    const rs = [
      await getList(new Request(url("/api/compliance/requests"))),
      await getDetail(new Request(url("/x")), idCtx(id)),
      await getTypes(),
      await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "closure" })),
      await postNote(jsonReq("POST", "/x", { text: "x" }), idCtx(id)),
    ];
    expect(rs.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    // and not a single event was written for the refused reads
    expect(eventsOf(db, id).filter((e: any) => e.kind === "view")).toHaveLength(0);
  });

  it("each route needs its own capability", async () => {
    const { id } = await newCase();
    const status = async (res: Promise<Response>) => (await res).status;
    as(OFFICER, MENU, "compliance.review");
    expect(await status(postReveal(jsonReq("POST", "/x"), idCtx(id)))).toBe(403);
    expect(await status(postClock(jsonReq("POST", "/x", { action: "pause", note: "x" }), idCtx(id)))).toBe(403);
    expect(await status(postStep(jsonReq("POST", "/x", { done: true }), idCtx(id, { step: "refund" })))).toBe(403);
    expect(await status(postType(jsonReq("POST", "/x", {})))).toBe(403);
    expect(await status(patchType(jsonReq("PATCH", "/x", {}), { params: Promise.resolve({ key: "closure" }) }))).toBe(403);
    as(OPS, MENU, "compliance.execute");
    expect(await status(patchDetail(jsonReq("PATCH", "/x", {}), idCtx(id)))).toBe(403);
    expect(await status(postStanding(jsonReq("POST", "/x", { duesOutstanding: false }), idCtx(id)))).toBe(403);
    expect(await status(postFile(jsonReq("POST", "/x"), idCtx(id)))).toBe(403);
    expect(await status(getList(new Request(url("/api/compliance/requests"))))).toBe(200);
    as(HEAD, MENU, "compliance.manage");
    expect(await status(getTypes())).toBe(200);
    expect(await status(getList(new Request(url("/api/compliance/requests"))))).toBe(403);
  });

  it("answers in the module's shape: a code, no-store, and never the database's words", async () => {
    const r = await read(await getDetail(new Request(url("/x")), idCtx("00000000-0000-4000-8000-00000000dead")));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "not_found", code: "not_found" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const bad = await read(await getDetail(new Request(url("/x")), idCtx("not-a-uuid")));
    expect(bad.status).toBe(404);
  });

  it("rate limits each person per route and tells them when to retry", async () => {
    for (let i = 0; i < 20; i++) expect((await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "phone_change", customerName: `P${i}`, answers: { current_phone: "0123456789", new_phone: "0198765432" } }))).status).toBe(201);
    const limited = await read(await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "phone_change", customerName: "One more", answers: { current_phone: "0123456789", new_phone: "0198765432" } })));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(db.rows("compliance_requests")).toHaveLength(20);
    as(HEAD, ...ALL);
    expect((await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "phone_change", customerName: "Another person", answers: { current_phone: "0123456789", new_phone: "0198765432" } }))).status).toBe(201);
  });
});

const AGENT_ID = "44444444-4444-4444-8444-444444444444";

describe("create, list and read", () => {
  it("creates a case from staff, lists it, and reads its detail with the bank details masked", async () => {
    const { id, reference } = await newCase();
    expect(reference).toMatch(/^CMP-/);
    expect((db.rows("compliance_requests")[0] as any).created_by).toBe(OFFICER);
    const list = await read(await getList(new Request(url("/api/compliance/requests?q=siti"))));
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0]).toMatchObject({ reference, customerName: "Siti Aminah", status: "received" });
    expect(list.headers.get("cache-control")).toBe("no-store");
    const detail = await read(await getDetail(new Request(url("/x")), idCtx(id)));
    expect(detail.status).toBe(200);
    expect(detail.body.sensitive.find((s: any) => s.key === "bank_account_number").masked).toBe("•••• 9012");
    for (const secret of [ACCOUNT_NUMBER, BANK_NAME]) {
      expect(JSON.stringify(list.body)).not.toContain(secret);
      expect(JSON.stringify(detail.body)).not.toContain(secret);
    }
    expect(eventsOf(db, id).map((e: any) => e.kind)).toEqual(["view"]);
  });

  it("never lets the public form's source or an unknown one through the staff route as 'form'", async () => {
    as(OFFICER, MENU, "compliance.review");
    await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "phone_change", customerName: "A", source: "form", answers: { current_phone: "0123456789", new_phone: "0198765432" } }));
    await postCreate(jsonReq("POST", "/api/compliance/requests", { typeKey: "phone_change", customerName: "B", source: "inbox", conversationId: "00000000-0000-4000-8000-0000000000c1", answers: { current_phone: "0123456789", new_phone: "0198765432" } }));
    expect((db.rows("compliance_requests") as any[]).map((r) => r.source)).toEqual(["staff", "inbox"]);
  });

  it("refuses a body that is not a JSON object, a missing type, and answers that do not fit the type (with the fields named)", async () => {
    as(OFFICER, MENU, "compliance.review");
    const raw = (body: string) => new Request(url("/x"), { method: "POST", body, headers: { "content-type": "application/json" } });
    expect((await postCreate(raw("[1,2]"))).status).toBe(400);
    expect((await postCreate(raw("{broken"))).status).toBe(400);
    expect((await postCreate(jsonReq("POST", "/x", { customerName: "x" }))).status).toBe(400);
    const r = await read(await postCreate(jsonReq("POST", "/x", { typeKey: "closure", customerName: "x", answers: { confirm_closure: true } })));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("validation_failed");
    expect(r.body.issues.map((i: any) => i.field)).toContain("bank_account_number");
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("does not show another workspace's case", async () => {
    const { id } = await newCase();
    h.accountId = "other-account";
    expect((await getDetail(new Request(url("/x")), idCtx(id))).status).toBe(404);
    const list = await read(await getList(new Request(url("/api/compliance/requests"))));
    expect(list.body.rows).toEqual([]);
  });
});

describe("edit, notes, standing", () => {
  it("edits through the database function and answers with what changed", async () => {
    const { id } = await newCase();
    const calls: any[] = [];
    db.rpcHandlers.compliance_update_request = (a) => (calls.push(a), { data: { id, changed: ["channel"] }, error: null });
    const r = await read(await patchDetail(jsonReq("PATCH", "/x", { channel: "email", assignedTo: HEAD, ticketId: null, bogus: 1 }), idCtx(id)));
    expect(r).toMatchObject({ status: 200, body: { changed: ["channel"] } });
    expect(calls[0].p_patch).toEqual({ channel: "email", assigned_to: HEAD, ticket_id: null });
  });

  it("adds a note", async () => {
    const { id } = await newCase();
    const ok = await read(await postNote(jsonReq("POST", "/x", { text: "Parent will send the letter" }), idCtx(id)));
    expect(ok.status).toBe(201);
    expect(eventsOf(db, id).find((e: any) => e.kind === "note")).toMatchObject({ actor: OFFICER, detail: { text: "Parent will send the letter" } });
    expect((await postNote(jsonReq("POST", "/x", { text: "" }), idCtx(id))).status).toBe(400);
  });

  it("records the dues standing", async () => {
    const { id } = await newCase();
    const calls: any[] = [];
    db.rpcHandlers.compliance_set_standing = (a) => (calls.push(a), { data: {}, error: null });
    expect((await postStanding(jsonReq("POST", "/x", { duesOutstanding: "yes" }), idCtx(id))).status).toBe(400);
    expect((await postStanding(jsonReq("POST", "/x", { duesOutstanding: true, notes: "two allowances" }), idCtx(id))).status).toBe(200);
    expect(calls[0]).toMatchObject({ p_dues: true, p_notes: "two allowances", p_actor: OFFICER });
  });
});

describe("transitions", () => {
  it("moves a case through the database function with the payload the move needs, and answers 409 for a move that is not allowed", async () => {
    const { id } = await newCase();
    const calls: any[] = [];
    db.rpcHandlers.compliance_transition = (a) => (calls.push(a), { data: { id }, error: null });
    const ok = await read(await postTransition(jsonReq("POST", "/x", { to: "officer_review", note: "Called back", identity: { method: "call_back", outcome: "pass" } }), idCtx(id)));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ from: "received", to: "officer_review" });
    expect(calls[0].p_payload).toEqual({ method: "call_back", method_other: null, outcome: "pass" });
    const bad = await read(await postTransition(jsonReq("POST", "/x", { to: "approved" }), idCtx(id)));
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe("invalid_transition");
    expect((await postTransition(jsonReq("POST", "/x", { to: "nowhere" }), idCtx(id))).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("answers 403 maker_checker to the person who recorded the identity check", async () => {
    const { id } = await newCase();
    Object.assign(db.rows("compliance_requests")[0], { status: "awaiting_signoff", identity_check: { outcome: "pass", verified_by: HEAD, recorded_by: HEAD } });
    as(HEAD, MENU, "compliance.review", "compliance.approve");
    const r = await read(await postTransition(jsonReq("POST", "/x", { to: "approved" }), idCtx(id)));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("maker_checker");
  });

  it("ticks a checklist step", async () => {
    const { id } = await newCase();
    as(OPS, MENU, "compliance.execute");
    const calls: any[] = [];
    db.rpcHandlers.compliance_tick_step = (a) => (calls.push(a), { data: {}, error: null });
    expect((await postStep(jsonReq("POST", "/x", { done: "yes" }), idCtx(id, { step: "refund" }))).status).toBe(400);
    expect((await postStep(jsonReq("POST", "/x", { done: true, note: "Paid" }), idCtx(id, { step: "refund" }))).status).toBe(200);
    expect(calls[0]).toEqual({ p_request: id, p_step: "refund", p_done: true, p_actor: OPS, p_note: "Paid" });
  });

  it("pauses the clock only for the Head, with a note", async () => {
    const { id } = await newCase();
    const calls: any[] = [];
    db.rpcHandlers.compliance_clock = (a) => (calls.push(a), { data: {}, error: null });
    as(HEAD, MENU, "compliance.approve");
    expect((await postClock(jsonReq("POST", "/x", { action: "pause", note: "" }), idCtx(id))).status).toBe(400);
    expect((await postClock(jsonReq("POST", "/x", { action: "freeze", note: "x" }), idCtx(id))).status).toBe(400);
    expect((await postClock(jsonReq("POST", "/x", { action: "pause", note: "Waiting" }), idCtx(id))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("reveal", () => {
  it("returns the bank details in full, no-store, after writing the reveal event, and uses the shared limiter (10 a minute per person)", async () => {
    const { id } = await newCase();
    as(HEAD, MENU, "compliance.reveal");
    const r = await read(await postReveal(jsonReq("POST", "/x"), idCtx(id)));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.fields.find((f: any) => f.key === "bank_account_number").value).toBe(ACCOUNT_NUMBER);
    expect(r.body.expiresInSeconds).toBe(120);
    expect(h.sharedKeys).toEqual([`compliance-reveal:${HEAD}`]);
    expect(eventsOf(db, id).find((e: any) => e.kind === "reveal")).toMatchObject({ actor: HEAD, detail: { allowed: true } });
  });

  it("is refused to anyone without compliance.reveal, and the limiter's refusal reaches nothing", async () => {
    const { id } = await newCase();
    as(OFFICER, MENU, "compliance.review");
    expect((await postReveal(jsonReq("POST", "/x"), idCtx(id))).status).toBe(403);
    as(HEAD, MENU, "compliance.reveal");
    h.shared = { success: false, reset: Date.now() + 30_000, remaining: 0, limit: 10 };
    const limited = await read(await postReveal(jsonReq("POST", "/x"), idCtx(id)));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(eventsOf(db, id).filter((e: any) => e.kind === "reveal")).toHaveLength(0);
  });
});

describe("files", () => {
  const upload = (id: string, bytes: Uint8Array, name: string, field?: string) => {
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], name, { type: "application/pdf" }));
    if (field) form.append("field", field);
    return postFile(new Request(url("/x"), { method: "POST", body: form }), idCtx(id));
  };

  it("uploads a PDF, then downloads it as an attachment with the headers that keep it from being run or cached", async () => {
    const { id } = await newCase();
    const up = await read(await upload(id, PDF, "letter.pdf", "authorization_letter"));
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: "letter.pdf", mime: "application/pdf" });
    expect(JSON.stringify(up.body)).not.toContain("account-");
    const res = await getFile(new Request(url("/x")), idCtx(id, { fileId: up.body.id }));
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(PDF));
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="letter.pdf"');
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(eventsOf(db, id).find((e: any) => e.kind === "view" && e.detail.file === up.body.id)).toBeTruthy();
  });

  it("refuses what is not a PDF, JPEG or PNG by its bytes, whatever it is called, and a body with no file", async () => {
    const { id } = await newCase();
    const r = await read(await upload(id, new TextEncoder().encode("<html>"), "letter.pdf"));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("unsupported_file");
    const none = await postFile(new Request(url("/x"), { method: "POST", body: new FormData() }), idCtx(id));
    expect(none.status).toBe(400);
    expect(db.rows("compliance_request_files")).toHaveLength(0);
  });

  it("refuses a download by someone who may not read evidence and an id that is not a file of this case", async () => {
    const { id } = await newCase();
    const up = await read(await upload(id, PDF, "letter.pdf"));
    as(OPS, MENU, "compliance.execute");
    expect((await getFile(new Request(url("/x")), idCtx(id, { fileId: up.body.id }))).status).toBe(403);
    as(HEAD, MENU, "compliance.approve");
    expect((await getFile(new Request(url("/x")), idCtx(id, { fileId: "00000000-0000-4000-8000-00000000dead" }))).status).toBe(404);
    expect((await getFile(new Request(url("/x")), idCtx(id, { fileId: "nope" }))).status).toBe(404);
  });
});

describe("request types", () => {
  it("reads the definitions for anyone who works on cases (active only), and all of them for an administrator", async () => {
    db.rows("compliance_request_types").find((t: any) => t.key === "phone_change")!.active = false;
    as(OFFICER, MENU, "compliance.review");
    const r = await read(await getTypes());
    expect(r.body.types.map((t: any) => t.key)).toEqual(["closure", "withdrawal"]);
    expect(r.body.types[0].fields.find((f: any) => f.key === "bank_account_number")).toMatchObject({ sensitive: true });
    as(HEAD, MENU, "compliance.manage");
    expect((await read(await getTypes())).body.types.map((t: any) => t.key)).toEqual(["closure", "withdrawal", "phone_change"]);
  });

  it("changes the clocks of a type for an administrator, and adds a custom one", async () => {
    as(HEAD, MENU, "compliance.manage");
    const r = await read(await patchType(jsonReq("PATCH", "/x", { targetDays: 7, hardStopDays: 21, allowPause: true }), { params: Promise.resolve({ key: "closure" }) }));
    expect(r.body.type).toMatchObject({ targetDays: 7, hardStopDays: 21, allowPause: true });
    const bad = await read(await patchType(jsonReq("PATCH", "/x", { targetDays: 30 }), { params: Promise.resolve({ key: "closure" }) }));
    expect(bad.status).toBe(400);
    expect((await patchType(jsonReq("PATCH", "/x", {}), { params: Promise.resolve({ key: "Bad Key" }) })).status).toBe(404);
    const created = await read(await postType(jsonReq("POST", "/x", { key: "address_change", label: "Address change", fields: [{ key: "new_address", type: "multiline", required: true, sensitive: true, label: { en: "New address" } }], targetDays: 5 })));
    expect(created.status).toBe(201);
    expect(created.body.type).toMatchObject({ key: "address_change", isSystem: false });
  });
});

describe("the clock job", () => {
  const SECRET = "cron-secret-for-tests";
  const call = (headers: Record<string, string> = {}) => getCron(new Request(url("/api/compliance/clock-cron"), { headers }));

  it("needs the cron secret, then runs the sweep and reports its counts", async () => {
    vi.stubEnv("AUTOMATION_CRON_SECRET", SECRET);
    db.rpcHandlers.compliance_clock_alert_sweep = () => ({ data: { alerted: 1, notified: 2 }, error: null });
    db.rpcHandlers.cron_heartbeat = () => ({ data: null, error: null });
    expect((await call()).status).toBe(401);
    expect((await call({ "x-cron-secret": "wrong" })).status).toBe(401);
    const ok = await call({ "x-cron-secret": SECRET });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ alerted: 1, notified: 2 });
    db.rpcHandlers.compliance_clock_alert_sweep = () => ({ data: null, error: { message: "boom" } });
    expect((await call({ "x-cron-secret": SECRET })).status).toBe(500);
    vi.unstubAllEnvs();
  });

  it("is registered with an hourly heartbeat", async () => {
    const { CRON_INTERVALS } = await import("@/lib/cron/guard");
    expect(CRON_INTERVALS["compliance-clock"]).toBe(3600);
  });
});
