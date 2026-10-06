// POST /api/sign/documents/[id]/countersign: what the route does on top of the service (src/lib/sign/service/countersign.ts):
// the capability, Doc Sign being on, the cookie that stands in for the code, and that the answer is a path on the same site.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";
import { verifySession } from "@/lib/sign/tokens";

const ACCT = "11111111-1111-4111-8111-111111111111";
const DIRECTOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOMEONE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOC = "33333333-3333-4333-8333-333333333333";
const SIGNER = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({ db: null as unknown, caller: { userId: "", accountId: "" }, denied: false, signOn: true }));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    if (h.denied) throw Object.assign(new Error(`missing ${capability}`), { status: 403 });
    return { userId: h.caller.userId, accountId: h.caller.accountId };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
  assertCapability: () => undefined,
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/sign/service/gate", () => ({
  assertSignOn: async () => {
    if (!h.signOn) {
      const { SignError } = await import("@/lib/sign/service/errors");
      throw new SignError("sign_disabled", "Doc Sign is not switched on for this workspace.", 403);
    }
  },
}));

import { POST } from "./route";

const call = (id = DOC) => POST(new Request(`https://halo.test/api/sign/documents/${id}/countersign`, { method: "POST", headers: { "user-agent": "Chrome", "x-forwarded-for": "203.0.113.9" } }), { params: Promise.resolve({ id }) });

let db: FakeDb;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  db = new FakeDb();
  h.db = db;
  h.denied = false;
  h.signOn = true;
  h.caller = { userId: DIRECTOR, accountId: ACCT };
  db.seed("sign_documents", [{ id: DOC, account_id: ACCT, title: "Agreement", status: "sent", expires_at: new Date(Date.now() + 86_400_000).toISOString(), code_required: true, roles_snapshot: [], created_by: null }]);
  db.seed("sign_signers", [{ id: SIGNER, account_id: ACCT, document_id: DOC, role_key: "director", kind: "signer", full_name: "Director", email: "d@example.com", order_no: 1, status: "sent", internal_user_id: DIRECTOR, created_at: "2026-10-01T00:00:00Z" }]);
  // the person's own address: a Halo sign-in opens only a place addressed to it
  db.seed("profiles", [{ user_id: DIRECTOR, account_id: ACCT, full_name: "Director", email: "d@example.com" }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_rotate_token = async () => ({ data: { signer_id: SIGNER, token: "ab".repeat(32) }, error: null });
});

afterEach(() => {
  if (saved === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = saved;
});

describe("POST /api/sign/documents/[id]/countersign", () => {
  it("answers the path of the signer page and sets the signer's session cookie (HttpOnly) so the code is not asked", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ url: `/s/${"ab".repeat(32)}`, signerId: SIGNER });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`sgs-${SIGNER}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    const value = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("="));
    expect(verifySession(value, SIGNER)).toBe(true);
  });

  it("gives a colleague who is not the signer nothing: 403, no cookie, no new link", async () => {
    h.caller = { userId: SOMEONE, accountId: ACCT };
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_a_signer");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(db.rpcCalls.filter((c) => c.name === "sign_rotate_token")).toHaveLength(0);
  });

  it("refuses without the capability, without Doc Sign, and for an address that is not a document id", async () => {
    h.denied = true;
    expect((await call()).status).toBe(403);
    h.denied = false;
    h.signOn = false;
    const off = await call();
    expect(off.status).toBe(403);
    expect((await off.json()).code).toBe("sign_disabled");
    h.signOn = true;
    const bad = await call("not-a-uuid");
    expect(bad.status).toBe(403);
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect(db.rpcCalls.filter((c) => c.name === "sign_rotate_token")).toHaveLength(0);
  });

  it("answers 409 when it is not their turn and sets no cookie", async () => {
    db.rows("sign_signers")[0].status = "pending";
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_your_turn");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
