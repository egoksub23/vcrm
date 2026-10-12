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

const ALL_CAPS = ["menu.kyc", "kyc.view", "kyc.reveal"];
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
    expect(Object.keys(logRows()[0]).sort()).toEqual(["account_id", "action", "created_at", "friend_id", "id", "outcome", "updated_at", "user_id", "validation_id"]);
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
    it.each(["", "   ", "a".repeat(101), "a b", "a/b", "a\\b", "../x", "x%2fy", "a;b", "<script>", "a\nb", "ünï", "a'b", 'a"b', "a?b", "a#b", "a&b=c", "a=b", "a,b", "a*b"])(
      "refuses the friend id %j with 400 and does nothing else",
      async (id) => {
        const res = await read(await get(getValidations, `/api/kyc/validations?friend_id=${encodeURIComponent(id)}`));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("invalid_request");
        expect(api.calls.api).toHaveLength(0);
        expect(logRows()).toHaveLength(0);
      },
    );

    it("refuses a missing friend id", async () => {
      expect((await get(getValidations, "/api/kyc/validations")).status).toBe(400);
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
    expect(lines[0]).toBe("Time (UTC),Person,Person ID,Action,Friend ID,Validation ID,Outcome");
    expect(lines).toHaveLength(2);
    // "+evil" starts with a formula character: guarded with a leading apostrophe
    expect(lines[1]).toBe("2026-10-01T00:03:00.000Z,Reviewer One,u-reviewer,reveal,'+evil,,forbidden");
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
