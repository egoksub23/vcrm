/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// The /api/kyc routes, end to end except for the network and the database: the staff wrapper (capability, rate limit), the validation of what
// comes in, the call to the (fake) back end, the masking on the server, the access log row each call writes, and the headers of an image.
// The fetch is a function the test supplies; nothing here reaches the network.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { API_KEY, BASE_URL, ENV, HTML, JPEG, PDF, PNG, RECORD, RECORD_2, bytes, json, makeTransport, streamOf, text } from "@/lib/kyc/test-support";

const h = vi.hoisted(() => ({
  db: null as unknown,
  env: {} as Record<string, string | undefined>,
  transport: null as unknown,
  userId: "u-reviewer",
  accountId: "acct-1",
  role: "admin" as string,
  caps: new Set<string>(),
  denied: new Set<string>(),
  asked: [] as string[],
  shared: { success: true, reset: Date.now() + 30_000, remaining: 5, limit: 10 },
  sharedKeys: [] as string[],
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    h.asked.push(capability);
    if (h.denied.has(capability) || !h.caps.has(capability)) throw Object.assign(new Error(`This action requires the '${capability}' permission`), { status: 403 });
    return { userId: h.userId, accountId: h.accountId, role: h.role, capabilities: h.caps };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/kyc/runtime", () => ({ kycRuntime: () => ({ env: h.env, transport: h.transport }) }));
vi.mock("@/lib/rate-limit-shared", () => ({
  checkSharedRateLimit: async (key: string) => {
    h.sharedKeys.push(key);
    return { ...h.shared };
  },
}));

import { GET as getAccessLog } from "./access-log/route";
import { GET as getAccessLogExport } from "./access-log/export/route";
import { GET as getStatus } from "./status/route";
import { GET as getValidations } from "./validations/route";
import { GET as getImage } from "./validations/[id]/image/route";
import { POST as postReview } from "./validations/[id]/review/route";

const ALL_CAPS = ["menu.kyc", "kyc.view", "kyc.reveal", "kyc.decide"];
const SECRETS = ["150304101234", "160405105678", "2015-03-04", "2016-04-05", "Jalan Mawar", "Lorong Kenanga", API_KEY, BASE_URL, "apis-uat.vircle.com"];

let db: FakeDb;
let api: ReturnType<typeof makeTransport>;

const setup = (opts: { caps?: string[]; role?: string; env?: Record<string, string | undefined>; apiHandler?: Parameters<typeof makeTransport>[0]["api"]; imageHandler?: Parameters<typeof makeTransport>[0]["image"] } = {}) => {
  h.caps = new Set(opts.caps ?? ALL_CAPS);
  h.role = opts.role ?? "admin";
  h.env = opts.env ?? { ...ENV };
  api = makeTransport({ api: opts.apiHandler ?? (() => json([RECORD, RECORD_2])), image: opts.imageHandler ?? (() => bytes(JPEG, "image/jpeg")) });
  h.transport = api.transport;
};

const get = (handler: (r: Request, c?: any) => Promise<Response>, path: string, ctx?: unknown) => handler(new Request(`https://halo.test${path}`), ctx);
const read = async (res: Response) => ({ status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> });
const logRows = () => db.rows("kyc_access_log");
const image = (id: string, qs = "") => get(getImage, `/api/kyc/validations/${encodeURIComponent(id)}/image${qs}`, { params: Promise.resolve({ id: encodeURIComponent(id) }) });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetRateLimitForTests();
  db = new FakeDb();
  h.db = db;
  h.userId = "u-reviewer";
  h.accountId = "acct-1";
  h.denied = new Set();
  h.asked = [];
  h.shared = { success: true, reset: Date.now() + 30_000, remaining: 5, limit: 10 };
  h.sharedKeys = [];
  setup();
});

describe("the staff wrapper", () => {
  it("every route asks for menu.kyc first, and is refused without it (the operator's flag removes the capability, so this is also 'feature off')", async () => {
    setup({ caps: ["kyc.view", "kyc.reveal"] });
    const results = [
      await get(getStatus, "/api/kyc/status"),
      await get(getValidations, "/api/kyc/validations?friend_id=child-77"),
      await image("val_123"),
      await get(getAccessLog, "/api/kyc/access-log"),
      await get(getAccessLogExport, "/api/kyc/access-log/export"),
    ];
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(new Set(h.asked)).toEqual(new Set(["menu.kyc"]));
    expect(api.calls.api).toHaveLength(0);
    expect(api.calls.image).toHaveLength(0);
    expect(logRows()).toHaveLength(0);
  });

  it("rate limits each person per route: the 31st lookup in a minute is a 429 and reaches neither the back end nor the log", async () => {
    for (let i = 0; i < 30; i++) expect((await get(getValidations, "/api/kyc/validations?friend_id=c1")).status).toBe(200);
    const before = api.calls.api.length;
    const rows = logRows().length;
    const limited = await read(await get(getValidations, "/api/kyc/validations?friend_id=c1"));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(api.calls.api).toHaveLength(before);
    expect(logRows()).toHaveLength(rows);
    // another person is not affected
    h.userId = "u-other";
    expect((await get(getValidations, "/api/kyc/validations?friend_id=c1")).status).toBe(200);
  });
});

describe("GET /api/kyc/status", () => {
  it("says it is not set up, naming the missing variables to an administrator only", async () => {
    setup({ env: {} });
    expect((await read(await get(getStatus, "/api/kyc/status"))).body).toMatchObject({ configured: false, missing: ["KYC_DOC_API_BASE_URL", "KYC_DOC_API_KEY"], isAdmin: true, canView: true, canReveal: true });
    setup({ env: {}, role: "agent", caps: ["menu.kyc"] });
    const agent = (await read(await get(getStatus, "/api/kyc/status"))).body;
    expect(agent).toMatchObject({ configured: false, missing: [], isAdmin: false, canView: false, canReveal: false });
  });

  it("reports UAT, the caller's permissions, and never the base URL or the key", async () => {
    const { body, headers } = await read(await get(getStatus, "/api/kyc/status"));
    expect(body).toMatchObject({ configured: true, uat: true, missing: [] });
    for (const s of [API_KEY, "vircle.com", "verify_doc"]) expect(JSON.stringify(body)).not.toContain(s);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(api.calls.api).toHaveLength(0);
  });

  it("checks the back end's /health only for an administrator who asks, without sending the key", async () => {
    setup({ apiHandler: () => text("ok") });
    expect((await read(await get(getStatus, "/api/kyc/status?check=1"))).body.service).toBe("up");
    expect(api.calls.api[0].url).toBe(`${BASE_URL}/health`);
    expect(api.calls.api[0].headers["x-api-key"]).toBeUndefined();
    setup({ apiHandler: () => text("down", 503) });
    expect((await read(await get(getStatus, "/api/kyc/status?check=1"))).body.service).toBe("down");
    setup({ role: "agent", caps: ["menu.kyc"], apiHandler: () => text("ok") });
    expect((await read(await get(getStatus, "/api/kyc/status?check=1"))).body.service).toBeUndefined();
    expect(api.calls.api).toHaveLength(0);
    // not configured: nothing to check
    setup({ env: {}, apiHandler: () => text("ok") });
    expect((await read(await get(getStatus, "/api/kyc/status?check=1"))).body.service).toBeUndefined();
  });

  it("limits the health check to six a minute", async () => {
    setup({ apiHandler: () => text("ok") });
    for (let i = 0; i < 6; i++) expect((await get(getStatus, "/api/kyc/status?check=1")).status).toBe(200);
    expect((await get(getStatus, "/api/kyc/status?check=1")).status).toBe(429);
  });
});

describe("GET /api/kyc/validations", () => {
  it("is 'not set up' with a 503, and records a config_error", async () => {
    setup({ env: {} });
    const { status, body } = await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77"));
    expect(status).toBe(503);
    expect(body).toEqual({ error: "not_configured", code: "not_configured" });
    expect(api.calls.api).toHaveLength(0);
    expect(logRows()).toMatchObject([{ account_id: "acct-1", user_id: "u-reviewer", action: "config_error", friend_id: "child-77", validation_id: null, outcome: "error" }]);
  });

  it("passes the document kind on to the back end, and refuses a kind it does not know", async () => {
    const { status } = await read(await get(getValidations, "/api/kyc/validations?doc_type=passport"));
    expect(status).toBe(200);
    expect(api.calls.api[0].url).toBe(`${BASE_URL}/validations?doc_type=passport&limit=50`);
    const bad = await read(await get(getValidations, "/api/kyc/validations?doc_type=driving_licence"));
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "invalid_request" });
    // nothing was sent upstream for the kind that was refused
    expect(api.calls.api).toHaveLength(1);
  });

  it("looks the friend id up, newest first, and MASKS on the server: no sensitive value is in the answer", async () => {
    const { status, body, headers } = await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77"));
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body.friendId).toBe("child-77");
    expect(body.items.map((v: any) => v.id)).toEqual(["val_124", "val_123"]);
    const idNumber = body.items[1].known.find((f: any) => f.key === "idNumber");
    expect(idNumber).toMatchObject({ value: "15••••••34", masked: true, sensitive: true });
    expect(body.items[1].known.find((f: any) => f.key === "dob")).toMatchObject({ value: null, masked: true });
    const text = JSON.stringify(body);
    for (const s of SECRETS) expect(text, s).not.toContain(s);
    // what the back end was asked
    expect(api.calls.api).toHaveLength(1);
    expect(api.calls.api[0].url).toBe(`${BASE_URL}/validations?friend_id=child-77&limit=50`);
    expect(api.calls.api[0].headers["x-api-key"]).toBe(API_KEY);
  });

  it("masks for a caller who holds kyc.reveal too, until reveal=1 is sent", async () => {
    const text = JSON.stringify((await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77"))).body);
    expect(text).not.toContain("150304101234");
  });

  it("writes a 'lookup' row, or a 'list' row on a reload, with the friend id and nothing else", async () => {
    await get(getValidations, "/api/kyc/validations?friend_id=%20child-77%20");
    await get(getValidations, "/api/kyc/validations?friend_id=child-77&reload=1");
    expect(logRows().map((r) => [r.action, r.friend_id, r.validation_id, r.outcome, r.user_id, r.account_id])).toEqual([
      ["lookup", "child-77", null, "ok", "u-reviewer", "acct-1"],
      ["list", "child-77", null, "ok", "u-reviewer", "acct-1"],
    ]);
    expect(Object.keys(logRows()[0]).sort()).toEqual(["account_id", "action", "created_at", "decision", "friend_id", "id", "outcome", "updated_at", "user_id", "validation_id"]);
    const dump = JSON.stringify(logRows());
    for (const s of SECRETS) expect(dump, s).not.toContain(s);
    expect(dump).not.toContain("Aisyah");
  });

  it("answers an empty list for an unknown friend id (404 from the back end, or an empty array) and records 'not_found'", async () => {
    setup({ apiHandler: () => text("", 404) });
    expect((await read(await get(getValidations, "/api/kyc/validations?friend_id=nobody"))).body).toMatchObject({ items: [] });
    setup({ apiHandler: () => json({ validations: [] }) });
    const r = await read(await get(getValidations, "/api/kyc/validations?friend_id=nobody"));
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(logRows().map((x) => x.outcome)).toEqual(["not_found", "not_found"]);
  });

  it("accepts the list in the other shapes the adapter knows", async () => {
    setup({ apiHandler: () => json({ data: { items: [RECORD] } }) });
    expect((await read(await get(getValidations, "/api/kyc/validations?friend_id=c"))).body.items).toHaveLength(1);
  });

  it("maps a rejected key to upstream_unauthorized (502), logs a config_error, and echoes nothing the back end said", async () => {
    setup({ apiHandler: () => text("Forbidden: invalid api key SECRET-UPSTREAM-TEXT", 403) });
    const { status, body } = await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77"));
    expect(status).toBe(502);
    expect(body).toEqual({ error: "upstream_unauthorized", code: "upstream_unauthorized" });
    expect(logRows()).toMatchObject([{ action: "config_error", outcome: "error", friend_id: "child-77" }]);
  });

  it.each([
    ["a 500", () => text("stack trace SECRET-UPSTREAM-TEXT", 500), "upstream_unreachable"],
    ["a 429", () => text("slow down", 429), "upstream_unreachable"],
    ["the network failing", () => Promise.reject(new Error(`ECONNREFUSED ${BASE_URL} ${API_KEY}`)), "upstream_unreachable"],
    ["an HTML page", () => text("<html>SECRET-UPSTREAM-TEXT</html>"), "bad_response"],
    ["an error object", () => json({ message: "SECRET-UPSTREAM-TEXT" }), "bad_response"],
    ["a redirect", () => text("", 302, { location: "https://elsewhere.example/" }), "bad_response"],
  ])("maps %s to %s and keeps the words to itself", async (_name, handler, code) => {
    setup({ apiHandler: handler as never });
    const { status, body } = await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77"));
    expect(status).toBe(502);
    expect(body).toEqual({ error: code, code });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(logRows()).toMatchObject([{ action: "lookup", outcome: "error" }]);
    expect(JSON.stringify(logRows())).not.toContain("SECRET");
  });

  it("never lets the key or the base URL into any answer, whatever the back end does", async () => {
    const dump: string[] = [];
    for (const handler of [() => text("x", 401), () => text("x", 500), () => json([RECORD]), () => text("not json"), () => Promise.reject(new Error(API_KEY))]) {
      setup({ apiHandler: handler as never });
      const res = await get(getValidations, "/api/kyc/validations?friend_id=child-77");
      dump.push(JSON.stringify([...res.headers.entries()]) + (await res.text()));
    }
    for (const s of [API_KEY, BASE_URL]) expect(dump.join("\n")).not.toContain(s);
    expect(JSON.stringify(logRows())).not.toContain(API_KEY);
  });

  describe("friend_id and limit", () => {
    it.each(["a".repeat(101), "a b", "a/b", "a\\b", "../x", "x%2fy", "a;b", "<script>", "a\nb", "ünï", "a'b", 'a"b', "a?b", "a#b", "a&b=c", "a=b", "a,b", "a*b"])(
      "refuses the friend id %j with 400 and does nothing else",
      async (id) => {
        const res = await read(await get(getValidations, `/api/kyc/validations?friend_id=${encodeURIComponent(id)}`));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("invalid_request");
        expect(api.calls.api).toHaveLength(0);
        expect(logRows()).toHaveLength(0);
      },
    );

    it("without a friend id lists the latest of everybody: no filter is sent upstream and the log row has no friend id", async () => {
      for (const url of ["/api/kyc/validations", "/api/kyc/validations?friend_id=", "/api/kyc/validations?friend_id=%20%20"]) {
        setup();
        const res = await read(await get(getValidations, url));
        expect(res.status).toBe(200);
        expect(res.body.friendId).toBe("");
        expect(api.calls.api).toHaveLength(1);
        expect(api.calls.api[0].url).toBe(`${BASE_URL}/validations?limit=50`);
        expect(logRows().at(-1)).toMatchObject({ action: "lookup", friend_id: null, outcome: "ok" });
      }
    });

    it("pages back with before_id (digits only), and answers the next cursor only for a full page", async () => {
      setup({ apiHandler: () => json({ items: [{ id: 9, doc_type: "nric", validation_status: "UNREADABLE" }, { id: 8, doc_type: "nric", validation_status: "UNREADABLE" }] }) });
      const full = await read(await get(getValidations, "/api/kyc/validations?limit=2&before_id=10"));
      expect(api.calls.api[0].url).toBe(`${BASE_URL}/validations?limit=2&before_id=10`);
      expect(full.body.nextBeforeId).toBe("8");
      const short = await read(await get(getValidations, "/api/kyc/validations?limit=3"));
      expect(short.body.nextBeforeId).toBeNull();
    });

    it.each(["x", "1;2", "-1", "1.5", "../1", "1234567890123"])("refuses the before_id %j with 400 and does nothing else", async (id) => {
      const res = await read(await get(getValidations, `/api/kyc/validations?before_id=${encodeURIComponent(id)}`));
      expect(res.status).toBe(400);
      expect(api.calls.api).toHaveLength(0);
      expect(logRows()).toHaveLength(0);
    });

    it("refuses a reveal that names no friend id", async () => {
      const res = await read(await get(getValidations, "/api/kyc/validations?reveal=1&validation_id=7"));
      expect(res.status).toBe(400);
      expect(api.calls.api).toHaveLength(0);
    });

    it.each(["a", "A1", "child-77", "x.y_z", "me@example.com", "tel:+60123456789", "a:b", "+60-12", "a".repeat(100)])("accepts the friend id %s", async (id) => {
      expect((await get(getValidations, `/api/kyc/validations?friend_id=${encodeURIComponent(id)}`)).status).toBe(200);
      expect(logRows().at(-1)?.friend_id).toBe(id);
    });

    it("clamps the limit to 1..100 (default 50) and refuses one that is not a number", async () => {
      await get(getValidations, "/api/kyc/validations?friend_id=c&limit=1000");
      await get(getValidations, "/api/kyc/validations?friend_id=c&limit=0");
      await get(getValidations, "/api/kyc/validations?friend_id=c&limit=-5");
      await get(getValidations, "/api/kyc/validations?friend_id=c&limit=12.9");
      await get(getValidations, "/api/kyc/validations?friend_id=c&limit=");
      expect(api.calls.api.map((c) => new URL(c.url).searchParams.get("limit"))).toEqual(["100", "1", "1", "12", "50"]);
      expect((await get(getValidations, "/api/kyc/validations?friend_id=c&limit=abc")).status).toBe(400);
    });

    it("never returns more than the limit even if the back end ignores it", async () => {
      setup({ apiHandler: () => json(Array.from({ length: 150 }, (_, i) => ({ id: `v${i}`, status: "ok" }))) });
      expect((await read(await get(getValidations, "/api/kyc/validations?friend_id=c&limit=20"))).body.items).toHaveLength(20);
    });
  });

  describe("reveal", () => {
    const reveal = (vid = "val_123", extra = "") => get(getValidations, `/api/kyc/validations?friend_id=child-77&reveal=1&validation_id=${encodeURIComponent(vid)}${extra}`);

    it("returns the sensitive values of THAT validation in full, only when the caller holds kyc.reveal, and every other item stays masked", async () => {
      const { status, body } = await read(await reveal("val_123"));
      expect(status).toBe(200);
      expect(body.revealedId).toBe("val_123");
      const a = body.items.find((v: any) => v.id === "val_123");
      const b = body.items.find((v: any) => v.id === "val_124");
      expect(Object.fromEntries(a.known.map((f: any) => [f.key, f.value]))).toMatchObject({ idNumber: "150304101234", dob: "2015-03-04", address: "12 Jalan Mawar, 50000 Kuala Lumpur" });
      expect(a.known.some((f: any) => f.masked)).toBe(false);
      expect(b.known.find((f: any) => f.key === "idNumber")).toMatchObject({ value: "16••••••78", masked: true });
      expect(JSON.stringify(body)).not.toContain("160405105678");
      expect(JSON.stringify(body)).not.toContain(API_KEY);
    });

    it("records a 'reveal' row with the validation id", async () => {
      await reveal("val_124");
      expect(logRows()).toMatchObject([{ action: "reveal", friend_id: "child-77", validation_id: "val_124", outcome: "ok", user_id: "u-reviewer" }]);
      expect(JSON.stringify(logRows())).not.toContain("1604051");
    });

    it("is a 403 without kyc.reveal, recorded as 'forbidden', and the back end is not even asked", async () => {
      setup({ caps: ["menu.kyc", "kyc.view"], role: "agent" });
      const { status, body } = await read(await reveal());
      expect(status).toBe(403);
      expect(body.code).toBe("forbidden");
      expect(JSON.stringify(body)).not.toContain("150304101234");
      expect(api.calls.api).toHaveLength(0);
      expect(logRows()).toMatchObject([{ action: "reveal", outcome: "forbidden", validation_id: "val_123" }]);
    });

    it("still masks a plain lookup for that caller", async () => {
      setup({ caps: ["menu.kyc", "kyc.view"], role: "agent" });
      const res = await get(getValidations, "/api/kyc/validations?friend_id=child-77");
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("150304101234");
    });

    it("answers 404 for a validation that is not in the list, and 400 for a missing or malformed validation id", async () => {
      expect((await read(await reveal("nope"))).status).toBe(404);
      expect(logRows().at(-1)).toMatchObject({ action: "reveal", outcome: "not_found", validation_id: "nope" });
      expect((await get(getValidations, "/api/kyc/validations?friend_id=child-77&reveal=1")).status).toBe(400);
      expect((await reveal("a/b")).status).toBe(400);
      expect((await reveal("a b")).status).toBe(400);
      expect((await reveal("x".repeat(201))).status).toBe(400);
    });

    it("is rate limited in the shared limiter (ten a minute per person): over the limit nothing is fetched or recorded", async () => {
      h.shared = { success: false, reset: Date.now() + 20_000, remaining: 0, limit: 10 };
      const { status, body, headers } = await read(await reveal());
      expect(status).toBe(429);
      expect(body.code).toBe("rate_limited");
      expect(Number(headers.get("retry-after"))).toBeGreaterThan(0);
      expect(h.sharedKeys).toEqual(["kyc-reveal:u-reviewer"]);
      expect(api.calls.api).toHaveLength(0);
      expect(logRows()).toHaveLength(0);
    });

    it("does not touch the reveal limiter for an ordinary lookup", async () => {
      await get(getValidations, "/api/kyc/validations?friend_id=child-77");
      expect(h.sharedKeys).toEqual([]);
    });

    it("a reveal that the back end fails is recorded as an error and returns nothing", async () => {
      setup({ apiHandler: () => text("boom", 500) });
      expect((await reveal()).status).toBe(502);
      expect(logRows()).toMatchObject([{ action: "reveal", outcome: "error" }]);
    });
  });

  it("returns nothing when the access log cannot be written (the log is never skipped)", async () => {
    db.failNext.kyc_access_log = "disk full";
    const res = await get(getValidations, "/api/kyc/validations?friend_id=child-77");
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: "audit_failed", code: "audit_failed" });
    expect(text).not.toContain("Aisyah");
    // and the same for a reveal
    db.failNext.kyc_access_log = "disk full";
    const rev = await get(getValidations, "/api/kyc/validations?friend_id=child-77&reveal=1&validation_id=val_123");
    expect(rev.status).toBe(503);
    expect(await rev.text()).not.toContain("150304101234");
  });
});

describe("GET /api/kyc/validations/[id]/image", () => {
  const signed = (url = "https://files.vircle.com/img/val_123.jpg?X-Amz-Signature=SIGSECRET") => json({ url });

  it("streams the image with no-store headers, never the vendor URL, and records 'view_image'", async () => {
    setup({ apiHandler: () => signed() });
    const res = await image("val_123", "?friend_id=child-77");
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(JPEG));
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store, no-cache, private");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("content-length")).toBe(String(JPEG.length));
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const headerText = JSON.stringify([...res.headers.entries()]);
    for (const s of ["SIGSECRET", "files.vircle.com", API_KEY, BASE_URL, "Location"]) expect(headerText, s).not.toContain(s);
    // the signed URL was asked for with the key; the image host got no key
    expect(api.calls.api[0].url).toBe(`${BASE_URL}/validations/val_123/url`);
    expect(api.calls.api[0].headers["x-api-key"]).toBe(API_KEY);
    expect(api.calls.image[0].url).toBe("https://files.vircle.com/img/val_123.jpg?X-Amz-Signature=SIGSECRET");
    expect(JSON.stringify(api.calls.image[0].headers)).not.toContain(API_KEY);
    expect(logRows()).toMatchObject([{ action: "view_image", friend_id: "child-77", validation_id: "val_123", outcome: "ok", user_id: "u-reviewer" }]);
    expect(JSON.stringify(logRows())).not.toContain("SIGSECRET");
  });

  it("serves a PNG and a WebP too", async () => {
    setup({ apiHandler: () => signed(), imageHandler: () => bytes(PNG, "image/png") });
    expect((await image("v1")).headers.get("content-type")).toBe("image/png");
  });

  it("needs kyc.view: without it 403, recorded as 'forbidden', and neither the back end nor the image host is called", async () => {
    setup({ caps: ["menu.kyc", "kyc.reveal"], role: "agent", apiHandler: () => signed() });
    const { status, body } = await read(await image("val_123", "?friend_id=child-77"));
    expect(status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(api.calls.api).toHaveLength(0);
    expect(api.calls.image).toHaveLength(0);
    expect(logRows()).toMatchObject([{ action: "view_image", outcome: "forbidden", validation_id: "val_123", friend_id: "child-77" }]);
  });

  it("is 'not set up' with a 503 and a config_error row", async () => {
    setup({ env: {} });
    expect((await image("val_123")).status).toBe(503);
    expect(logRows()).toMatchObject([{ action: "config_error", outcome: "error", validation_id: "val_123" }]);
  });

  it.each(["a/b", "a b", "..", "a;b", "x".repeat(201), "<x>", "a?b"])("refuses the validation id %j with 400", async (id) => {
    const res = await image(id);
    expect(res.status).toBe(400);
    expect(api.calls.api).toHaveLength(0);
    expect(logRows()).toHaveLength(0);
  });

  it("refuses an id that is not valid percent-encoding", async () => {
    const res = await get(getImage, "/api/kyc/validations/%E0%A4%A/image", { params: Promise.resolve({ id: "%E0%A4%A" }) });
    expect(res.status).toBe(400);
  });

  it.each([
    ["a host that is not the back end's and not allowed", "https://evil.example/a.jpg", "image_host_blocked"],
    ["http", "http://files.vircle.com/a.jpg", "image_host_blocked"],
    ["a private address", "https://10.0.0.8/a.jpg", "image_host_blocked"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/", "image_host_blocked"],
    ["localhost", "https://localhost/a.jpg", "image_host_blocked"],
    ["credentials in the URL", "https://u:p@files.vircle.com/a.jpg", "image_host_blocked"],
    ["a look-alike host", "https://files.vircle.com.evil.example/a.jpg", "image_host_blocked"],
  ])("refuses a signed URL with %s: 502, the image is never fetched, a row records the error", async (_n, url, code) => {
    setup({ apiHandler: () => signed(url) });
    const { status, body } = await read(await image("val_123"));
    expect(status).toBe(502);
    expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("evil.example");
    expect(api.calls.image).toHaveLength(0);
    expect(logRows()).toMatchObject([{ action: "view_image", outcome: "error" }]);
  });

  it("accepts a host named in KYC_DOC_ALLOWED_IMAGE_HOSTS", async () => {
    setup({ env: { ...ENV, KYC_DOC_ALLOWED_IMAGE_HOSTS: "*.s3.ap-southeast-1.amazonaws.com" }, apiHandler: () => signed("https://kyc.s3.ap-southeast-1.amazonaws.com/a.jpg?sig=1") });
    expect((await image("val_123")).status).toBe(200);
  });

  it("reads a redirect's Location from the URL call but never follows a redirect from the image host", async () => {
    setup({ apiHandler: () => text("", 302, { location: "https://files.vircle.com/a.jpg" }), imageHandler: () => text("", 302, { location: "https://169.254.169.254/" }) });
    const { status, body } = await read(await image("val_123"));
    expect(status).toBe(502);
    expect(body.code).toBe("bad_response");
    expect(api.calls.image).toHaveLength(1);
  });

  it.each([
    ["a PDF", () => bytes(PDF, "application/pdf"), "image_type_unsupported"],
    ["HTML", () => bytes(HTML, "text/html"), "image_type_unsupported"],
    ["HTML labelled as an image", () => bytes(HTML, "image/jpeg"), "image_type_unsupported"],
    ["an image that is too big (declared)", () => new Response(new Uint8Array(4), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(20 * 1024 * 1024) } }), "image_too_large"],
    ["an image that is too big (streamed)", () => new Response(streamOf(16 * 1024 * 1024, 1024 * 1024), { status: 200, headers: { "content-type": "image/jpeg" } }), "image_too_large"],
    ["a 404", () => text("", 404), "not_found"],
    ["a 500", () => text("", 500), "bad_response"],
  ])("maps %s from the image host to %s", async (_n, handler, code) => {
    setup({ apiHandler: () => signed(), imageHandler: handler as never });
    const { status, body } = await read(await image("val_123"));
    expect(body.code).toBe(code);
    expect(status).toBe(code === "not_found" ? 404 : 502);
    expect(logRows()).toHaveLength(1);
    expect(logRows()[0].outcome).toBe(code === "not_found" ? "not_found" : "error");
  });

  it("maps the back end's answers to the URL call: 404, a rejected key (config_error row), a failure, a body with no URL", async () => {
    setup({ apiHandler: () => text("", 404) });
    expect((await image("val_123")).status).toBe(404);
    setup({ apiHandler: () => text("denied", 403) });
    const denied = await read(await image("val_123"));
    expect(denied.status).toBe(502);
    expect(denied.body.code).toBe("upstream_unauthorized");
    expect(logRows().at(-1)).toMatchObject({ action: "config_error", outcome: "error" });
    setup({ apiHandler: () => text("", 500) });
    expect((await read(await image("val_123"))).body.code).toBe("upstream_unreachable");
    setup({ apiHandler: () => json({ nothing: true }) });
    expect((await read(await image("val_123"))).body.code).toBe("bad_response");
  });

  it("drops the bytes when the access log cannot be written", async () => {
    setup({ apiHandler: () => signed() });
    db.failNext.kyc_access_log = "disk full";
    const res = await image("val_123");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe("audit_failed");
  });

  it("is limited to 120 a minute per person", async () => {
    setup({ apiHandler: () => signed() });
    for (let i = 0; i < 120; i++) expect((await image("val_123")).status).toBe(200);
    expect((await image("val_123")).status).toBe(429);
  });

  it("puts only a valid friend id in the log, and none when the screen sent junk", async () => {
    setup({ apiHandler: () => signed() });
    await image("v1", "?friend_id=<script>");
    await image("v2");
    expect(logRows().map((r) => r.friend_id)).toEqual([null, null]);
  });
});

describe("GET /api/kyc/access-log and its CSV", () => {
  const seed = () => {
    db.seed("profiles", [
      { user_id: "u-reviewer", account_id: "acct-1", full_name: "Reviewer One", email: "r1@example.test" },
      { user_id: "u-two", account_id: "acct-1", full_name: "Reviewer Two", email: "r2@example.test" },
      { user_id: "u-elsewhere", account_id: "acct-2", full_name: "Somebody Else", email: "x@example.test" },
    ]);
    const row = (n: number, over: Record<string, unknown> = {}) => ({
      id: `log-${n}`,
      account_id: "acct-1",
      user_id: n % 2 ? "u-reviewer" : "u-two",
      action: "lookup",
      friend_id: `child-${n}`,
      validation_id: null,
      outcome: "ok",
      created_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
      ...over,
    });
    db.seed("kyc_access_log", [
      row(1),
      row(2, { action: "view_image", validation_id: "val_9" }),
      row(3, { action: "reveal", outcome: "forbidden", friend_id: "+evil" }),
      row(4, { account_id: "acct-2", user_id: "u-elsewhere" }),
      row(5, { user_id: "u-gone", action: "config_error", friend_id: null, outcome: "error" }),
    ]);
  };

  it("is for administrators and owners only: an agent who holds menu.kyc gets a 403", async () => {
    seed();
    setup({ role: "agent", caps: ALL_CAPS });
    expect((await get(getAccessLog, "/api/kyc/access-log")).status).toBe(403);
    expect((await get(getAccessLogExport, "/api/kyc/access-log/export")).status).toBe(403);
    setup({ role: "owner" });
    expect((await get(getAccessLog, "/api/kyc/access-log")).status).toBe(200);
  });

  it("lists this workspace's rows newest first with names, and the people for the filter; never another workspace's", async () => {
    seed();
    const { body, headers } = await read(await get(getAccessLog, "/api/kyc/access-log"));
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body.rows.map((r: any) => r.id)).toEqual(["log-5", "log-3", "log-2", "log-1"]);
    expect(body.rows[1]).toMatchObject({ userName: "Reviewer One", action: "reveal", friendId: "+evil", outcome: "forbidden" });
    expect(body.rows[0]).toMatchObject({ userName: null, userId: "u-gone" });
    expect(body.people.map((p: any) => p.name)).toEqual(["Reviewer One", "Reviewer Two"]);
    expect(JSON.stringify(body)).not.toContain("Somebody Else");
    expect(body.hasMore).toBe(false);
  });

  it("filters by person, friend id, action and date, and pages with `before`", async () => {
    seed();
    const ids = async (qs: string) => (await read(await get(getAccessLog, `/api/kyc/access-log?${qs}`))).body.rows.map((r: any) => r.id);
    // a person's id is a UUID; anything else is ignored rather than trusted
    expect(await ids("user_id=u-two")).toHaveLength(4);
    db.seed("kyc_access_log", [{ id: "log-6", account_id: "acct-1", user_id: "bbbbbbbb-0000-4000-8000-000000000001", action: "lookup", friend_id: "child-6", validation_id: null, outcome: "ok", created_at: "2026-10-02T00:00:00.000Z" }]);
    expect(await ids("user_id=bbbbbbbb-0000-4000-8000-000000000001")).toEqual(["log-6"]);
    expect(await ids("friend_id=child-1")).toEqual(["log-1"]);
    expect(await ids("action=view_image")).toEqual(["log-2"]);
    expect(await ids("action=bogus")).toHaveLength(5);
    expect(await ids(`from=${encodeURIComponent("2026-10-01T00:02:00Z")}&to=${encodeURIComponent("2026-10-01T00:04:00Z")}`)).toEqual(["log-3", "log-2"]);
    expect(await ids(`before=${encodeURIComponent("2026-10-01T00:03:00.000Z")}`)).toEqual(["log-2", "log-1"]);
    expect(await ids("friend_id=bad%20id")).toHaveLength(5);
    const page = (await read(await get(getAccessLog, "/api/kyc/access-log?limit=2"))).body;
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it("exports a CSV with the same filters, formula-guarded, no-store, and says how many rows", async () => {
    seed();
    const res = await get(getAccessLogExport, "/api/kyc/access-log/export?action=reveal");
    const csv = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="kyc-access-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-row-count")).toBe("1");
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Time (UTC),Person,Person ID,Action,Friend ID,Validation ID,Outcome,Decision");
    expect(lines).toHaveLength(2);
    // "+evil" starts with a formula character: guarded with a leading apostrophe
    expect(lines[1]).toBe("2026-10-01T00:03:00.000Z,Reviewer One,u-reviewer,reveal,'+evil,,forbidden,");
  });

  it("caps the export at 5,000 rows and says it was cut", async () => {
    db.seed(
      "kyc_access_log",
      Array.from({ length: 5100 }, (_, i) => ({ id: `r${i}`, account_id: "acct-1", user_id: "u-reviewer", action: "lookup", friend_id: "c", validation_id: null, outcome: "ok", created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() })),
    );
    const res = await get(getAccessLogExport, "/api/kyc/access-log/export");
    expect(res.headers.get("x-row-count")).toBe("5000");
    expect(res.headers.get("x-truncated")).toBe("5000");
    expect((await res.text()).trim().split("\r\n")).toHaveLength(5001);
  });

  it("limits the export to six a minute", async () => {
    for (let i = 0; i < 6; i++) expect((await get(getAccessLogExport, "/api/kyc/access-log/export")).status).toBe(200);
    expect((await get(getAccessLogExport, "/api/kyc/access-log/export")).status).toBe(429);
  });
});

describe("the server log", () => {
  it("never holds the key, the base URL, a friend id, a signed URL or anything the back end said, whatever fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers = [
      () => text(`SECRET-UPSTREAM ${API_KEY}`, 500),
      () => text("", 403),
      () => Promise.reject(new Error(`ECONNREFUSED ${BASE_URL} ${API_KEY}`)),
      () => json({ url: "https://evil.example/a.jpg?X-Amz-Signature=SIGSECRET" }),
    ];
    for (const apiHandler of handlers) {
      setup({ apiHandler: apiHandler as never });
      await get(getValidations, "/api/kyc/validations?friend_id=child-77");
      await image("val_123", "?friend_id=child-77");
    }
    db.failNext.kyc_access_log = "disk full";
    setup({ apiHandler: () => json([RECORD]) });
    await get(getValidations, "/api/kyc/validations?friend_id=child-77");
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged.length).toBeGreaterThan(10);
    for (const s of [API_KEY, BASE_URL, "child-77", "SIGSECRET", "SECRET-UPSTREAM", "vircle.com/verify_doc"]) expect(logged, s).not.toContain(s);
  });
});

// ---- decisions (migration 188) ----
// A check as the production back end sends it once it names its people (the engineers' collection of 19 Oct 2026), and the answer a review gets.
const PEOPLE_RECORD = {
  id: 42,
  friend_id: "child-77",
  doc_type: "nric",
  s3_key: "Prod/child-77/nric_20261018T065853Z.jpg",
  job_status: "complete",
  capture_ok: true,
  capture_code: "ok",
  capture_message: "NRIC looks readable.",
  extracted_id: "901010145678",
  client_id_number: "901010145678",
  validation_status: "MATCH",
  parent: { id: "parent-uuid", name: "Parent Name", nickname: "parent", identification: "A1234567", client_type: "APP", email: "parent@example.com", wallet_id: "8001000000001", phone_number: "60123456789" },
  child: { id: "child-77", name: "Child Name", nickname: "child", identification: "901010145678", client_type: "CARD", email: null, wallet_id: "8001000000002", phone_number: null },
  review_status: null,
  review_note: null,
  reviewed_at: null,
  created_at: "2026-10-18T06:58:53+00:00",
};
const REVIEW_REPLY = { id: 42, friend_id: "child-77", decision: "approve", review_status: "APPROVED", ekyc_status: "VERIFIED", postgres: { ok: true, where: "METADATA.duitnow.ekyc_status", table: "SECRET_TABLE" }, dynamodb: { ok: true }, reviewed_at: "2026-10-19T04:00:00+00:00", note: "ok" };
const PEOPLE_SECRETS = ["parent@example.com", "60123456789", "A1234567", "8001000000001", "8001000000002", "901010145678", "SECRET_TABLE"];

describe("people on a check: masked on the server", () => {
  it("lists the child and the parent with names shown, ID numbers and wallets partly hidden, e-mail and phone hidden, and never takes the parent's name for the check's own", async () => {
    setup({ apiHandler: () => json({ items: [PEOPLE_RECORD] }) });
    const { status, body } = await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77"));
    expect(status).toBe(200);
    const item = body.items[0];
    expect(item.people.map((p: any) => p.role)).toEqual(["child", "parent"]);
    const child = Object.fromEntries(item.people[0].fields.map((f: any) => [f.key, f]));
    const parent = Object.fromEntries(item.people[1].fields.map((f: any) => [f.key, f]));
    expect(child.name).toMatchObject({ value: "Child Name", masked: false });
    expect(child.identification).toMatchObject({ value: "90••••••78", masked: true });
    expect(child.wallet).toMatchObject({ value: "80••••••02", masked: true });
    expect(parent.name).toMatchObject({ value: "Parent Name", masked: false });
    expect(parent.email).toMatchObject({ value: null, masked: true });
    expect(parent.phone).toMatchObject({ value: null, masked: true });
    expect(parent.identification).toMatchObject({ value: null, masked: true });
    expect(item.known.find((f: any) => f.key === "name")).toBeUndefined();
    expect(item.extra.some((f: any) => /parent|child/i.test(f.key))).toBe(false);
    const dump = JSON.stringify(body);
    for (const s of PEOPLE_SECRETS) expect(dump, s).not.toContain(s);
    expect(dump).not.toContain("Prod/child-77");
  });

  it("shows the people in full for the ONE revealed validation, to a caller with kyc.reveal", async () => {
    setup({ apiHandler: () => json({ items: [PEOPLE_RECORD] }) });
    const { body } = await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77&reveal=1&validation_id=42"));
    const parent = Object.fromEntries(body.items[0].people[1].fields.map((f: any) => [f.key, f.value]));
    expect(parent).toMatchObject({ email: "parent@example.com", phone: "60123456789", identification: "A1234567" });
  });

  it("reads a recorded decision (status, note, time) and nothing is left over in the other fields", async () => {
    const reviewed = { ...PEOPLE_RECORD, review_status: "REJECTED", review_note: "Photo does not match", reviewed_at: "2026-10-19T04:00:00+00:00" };
    setup({ apiHandler: () => json({ items: [reviewed] }) });
    const { body } = await read(await get(getValidations, "/api/kyc/validations?friend_id=child-77"));
    expect(body.items[0].review).toEqual({ raw: "REJECTED", tone: "negative", note: "Photo does not match", at: "2026-10-19T04:00:00.000Z" });
    expect(body.items[0].extra.some((f: any) => /review/i.test(f.key))).toBe(false);
  });
});

describe("POST /api/kyc/validations/[id]/review", () => {
  const post = (id: string, payload: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    postReview(new Request(`https://halo.test/api/kyc/validations/${encodeURIComponent(id)}/review`, { method: "POST", headers, body: typeof payload === "string" ? payload : JSON.stringify(payload) }), { params: Promise.resolve({ id: encodeURIComponent(id) }) });
  const decide = (decision: string, extra: Record<string, unknown> = {}, id = "42") => post(id, { friend_id: "child-77", decision, ...extra });
  const review = (over: Record<string, unknown> = {}, record: Record<string, unknown> = PEOPLE_RECORD) =>
    setup({ apiHandler: (c) => (c.init.method === "POST" ? json({ ...REVIEW_REPLY, ...over }) : json({ items: [record] })) });
  const posts = () => api.calls.api.filter((c) => c.init.method === "POST");

  it("approves: asks the back end once after reading the check again, logs the attempt BEFORE and the result AFTER, and answers with only what the screen needs", async () => {
    review();
    const { status, body, headers } = await read(await decide("approve"));
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ decision: "approve", reviewStatus: "APPROVED", reviewTone: "positive", reviewedAt: "2026-10-19T04:00:00.000Z", note: null, partial: false, emailSent: null });
    expect(api.calls.api.map((c) => `${c.init.method} ${c.url}`)).toEqual([`GET ${BASE_URL}/validations?friend_id=child-77&limit=100`, `POST ${BASE_URL}/validations/42/review`]);
    expect(posts()[0].headers["x-api-key"]).toBe(API_KEY);
    expect(posts()[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(posts()[0].init.body))).toEqual({ decision: "approve" });
    expect(logRows().map((r) => [r.action, r.outcome, r.decision, r.friend_id, r.validation_id, r.user_id])).toEqual([
      ["decision", "attempt", "approve", "child-77", "42", "u-reviewer"],
      ["decision", "ok", "approve", "child-77", "42", "u-reviewer"],
    ]);
    const dump = JSON.stringify([body, logRows()]);
    for (const s of [...PEOPLE_SECRETS, API_KEY, BASE_URL]) expect(dump, s).not.toContain(s);
  });

  it("rejects only with a note, sends the note cleaned (one line, no control or bidi characters), and says whether the parent's e-mail went", async () => {
    review();
    for (const note of [undefined, "", "   \n\t "]) {
      const refused = await read(await decide("reject", note === undefined ? {} : { note }));
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("invalid_request");
    }
    expect(api.calls.api).toHaveLength(0);
    expect(logRows()).toHaveLength(0);

    review({ decision: "reject", review_status: "REJECTED", email: { ok: true, to: "parent@example.com" } });
    const sent = await read(await decide("reject", { note: "  Photo‮ does\n not\u0007  match  " }));
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ decision: "reject", reviewStatus: "REJECTED", reviewTone: "negative", note: "Photo does not match", emailSent: true, partial: false });
    expect(JSON.parse(String(posts()[0].init.body))).toEqual({ decision: "reject", note: "Photo does not match" });
    expect(JSON.stringify(sent.body)).not.toContain("parent@example.com");
    expect(JSON.stringify(logRows())).not.toContain("Photo");

    review({ decision: "reject", review_status: "REJECTED", email: { ok: false, to: "parent@example.com" } });
    expect((await read(await decide("reject", { note: "Blurry" }))).body.emailSent).toBe(false);
    review({ decision: "reject", review_status: "REJECTED" });
    expect((await read(await decide("reject", { note: "Blurry" }))).body.emailSent).toBeNull();
  });

  it("tells the screen when the back end could not save the decision everywhere", async () => {
    review({ dynamodb: { ok: false, where: "SECRET_TABLE" } });
    const { status, body } = await read(await decide("approve"));
    expect(status).toBe(200);
    expect(body.partial).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SECRET_TABLE");
  });

  it("is a 403 without kyc.decide, recorded as 'forbidden' with the decision asked for, and the back end is not even asked", async () => {
    setup({ caps: ["menu.kyc", "kyc.view", "kyc.reveal"], apiHandler: () => json({ items: [PEOPLE_RECORD] }) });
    const { status, body } = await read(await decide("approve"));
    expect(status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(api.calls.api).toHaveLength(0);
    expect(logRows()).toMatchObject([{ action: "decision", outcome: "forbidden", decision: "approve", validation_id: "42" }]);
  });

  it("is refused without menu.kyc, whatever else the caller holds", async () => {
    setup({ caps: ["kyc.decide"] });
    expect((await decide("approve")).status).toBe(403);
    expect(api.calls.api).toHaveLength(0);
    expect(logRows()).toHaveLength(0);
  });

  it("refuses a request that is not well formed, before anything is read, sent or logged", async () => {
    review();
    const bad: [string, () => Promise<Response>][] = [
      ["not JSON", () => post("42", { friend_id: "child-77", decision: "approve" }, { "content-type": "text/plain" })],
      ["a form", () => post("42", "friend_id=child-77&decision=approve", { "content-type": "application/x-www-form-urlencoded" })],
      ["no content type", () => post("42", { friend_id: "child-77", decision: "approve" }, {})],
      ["broken JSON", () => post("42", "{not json")],
      ["an array", () => post("42", [1, 2])],
      ["no friend id", () => post("42", { decision: "approve" })],
      ["a friend id with a slash", () => post("42", { friend_id: "a/b", decision: "approve" })],
      ["an unknown decision", () => decide("delete")],
      ["a missing decision", () => post("42", { friend_id: "child-77" })],
      ["a note that is not text", () => decide("approve", { note: 5 })],
      ["a note over 500 characters", () => decide("approve", { note: "x".repeat(501) })],
      ["a body over 4000 characters", () => decide("approve", { note: "x".repeat(4100) })],
      ["a validation id of '..'", () => decide("approve", {}, "..")],
    ];
    for (const [what, run] of bad) {
      const { status, body } = await read(await run());
      expect([what, status, body.code]).toEqual([what, 400, "invalid_request"]);
    }
    expect(api.calls.api).toHaveLength(0);
    expect(logRows()).toHaveLength(0);
    // 500 characters is the limit and is let through
    expect((await decide("approve", { note: "x".repeat(500) })).status).toBe(200);
  });

  it("does not decide a check that already carries a review: a 409, nothing sent, and a trace", async () => {
    review({}, { ...PEOPLE_RECORD, review_status: "APPROVED", reviewed_at: "2026-10-19T01:00:00+00:00" });
    const { status, body } = await read(await decide("reject", { note: "Changed my mind" }));
    expect(status).toBe(409);
    expect(body.code).toBe("already_decided");
    expect(posts()).toHaveLength(0);
    expect(logRows().map((r) => [r.action, r.outcome, r.decision])).toEqual([["decision", "error", "reject"]]);
  });

  it("asks the back end even when the check is not among the child's first hundred (the back end answers 409 for one it refuses)", async () => {
    review({}, { ...PEOPLE_RECORD, id: 7 });
    expect((await decide("approve")).status).toBe(200);
    expect(posts()).toHaveLength(1);
  });

  it("sends NOTHING when the attempt cannot be written to the log", async () => {
    review();
    db.failNext.kyc_access_log = "disk full";
    const { status, body } = await read(await decide("approve"));
    expect(status).toBe(503);
    expect(body.code).toBe("audit_failed");
    expect(posts()).toHaveLength(0);
  });

  it("still answers 'done' when only the RESULT row cannot be written (the attempt row is there)", async () => {
    setup({
      apiHandler: (c) => {
        if (c.init.method !== "POST") return json({ items: [PEOPLE_RECORD] });
        db.failNext.kyc_access_log = "disk full";
        return json(REVIEW_REPLY);
      },
    });
    const { status, body } = await read(await decide("approve"));
    expect(status).toBe(200);
    expect(body.reviewStatus).toBe("APPROVED");
    expect(logRows().map((r) => r.outcome)).toEqual(["attempt"]);
  });

  it("never retries: a failure of the back end is one POST, an 'error' row after the attempt, and a code with none of the back end's words", async () => {
    // a rejected key is logged as a set-up problem (config_error, no decision), like everywhere else in this module
    const cases: { reply: () => Response | Promise<Response>; code: string; statusCode: number; outcome: string; second: string; secondDecision: string | null }[] = [
      { reply: () => text("SECRET-UPSTREAM " + API_KEY, 500), code: "upstream_unreachable", statusCode: 502, outcome: "error", second: "decision", secondDecision: "approve" },
      { reply: () => text("", 503), code: "upstream_unreachable", statusCode: 502, outcome: "error", second: "decision", secondDecision: "approve" },
      { reply: () => text("", 401), code: "upstream_unauthorized", statusCode: 502, outcome: "error", second: "config_error", secondDecision: null },
      { reply: () => text("", 409), code: "already_decided", statusCode: 409, outcome: "error", second: "decision", secondDecision: "approve" },
      { reply: () => text("bad decision SECRET-UPSTREAM", 422), code: "invalid_request", statusCode: 400, outcome: "error", second: "decision", secondDecision: "approve" },
      { reply: () => text("", 404), code: "not_found", statusCode: 404, outcome: "not_found", second: "decision", secondDecision: "approve" },
      { reply: () => Promise.reject(new Error(`ECONNREFUSED ${BASE_URL} ${API_KEY}`)), code: "upstream_unreachable", statusCode: 502, outcome: "error", second: "decision", secondDecision: "approve" },
    ];
    for (const { reply, code, statusCode, outcome, second, secondDecision } of cases) {
      db = new FakeDb();
      h.db = db;
      setup({ apiHandler: (c) => (c.init.method === "POST" ? reply() : json({ items: [PEOPLE_RECORD] })) });
      const { status, body } = await read(await decide("approve"));
      expect([body.code, status]).toEqual([code, statusCode]);
      expect(posts()).toHaveLength(1);
      expect(logRows().map((r) => [r.action, r.outcome, r.decision])).toEqual([["decision", "attempt", "approve"], [second, outcome, secondDecision]]);
      const dump = JSON.stringify(body);
      for (const s of [API_KEY, "SECRET-UPSTREAM", BASE_URL]) expect(dump, s).not.toContain(s);
    }
  });

  it("treats any 2xx as taken, even when the answer cannot be read", async () => {
    setup({ apiHandler: (c) => (c.init.method === "POST" ? text("<html>ok</html>", 200) : json({ items: [PEOPLE_RECORD] })) });
    const { status, body } = await read(await decide("approve"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ decision: "approve", reviewStatus: "APPROVED", partial: false, emailSent: null });
  });

  it("when the check cannot be read again, nothing is sent", async () => {
    setup({ apiHandler: () => text("", 503) });
    expect((await decide("approve")).status).toBe(502);
    expect(posts()).toHaveLength(0);
    expect(logRows().map((r) => [r.outcome])).toEqual([["error"]]);
  });

  it("is 'not set up' with a 503 when the server has no key, and sends nothing", async () => {
    setup({ env: {} });
    expect((await decide("approve")).status).toBe(503);
    expect(api.calls.api).toHaveLength(0);
    expect(logRows()).toMatchObject([{ action: "config_error", outcome: "error", decision: null }]);
  });

  it("allows twenty decisions a minute per person", async () => {
    review();
    for (let i = 0; i < 20; i++) expect((await decide("approve")).status).toBe(200);
    const limited = await read(await decide("approve"));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(posts()).toHaveLength(20);
  });

  it("is reported to the screen as canDecide, true only for a caller who holds kyc.decide", async () => {
    expect((await read(await get(getStatus, "/api/kyc/status"))).body.canDecide).toBe(true);
    setup({ caps: ["menu.kyc", "kyc.view", "kyc.reveal"] });
    expect((await read(await get(getStatus, "/api/kyc/status"))).body.canDecide).toBe(false);
  });

  it("is in the access log's CSV and filters as a 'decision' with the decision named", async () => {
    review();
    await decide("approve");
    const csv = await (await get(getAccessLogExport, "/api/kyc/access-log/export?action=decision")).text();
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",decision,child-77,42,");
    expect(lines.slice(1).map((l) => l.split(",").slice(-2)).sort((a, b) => a[0].localeCompare(b[0]))).toEqual([["attempt", "approve"], ["ok", "approve"]]);
  });
});
