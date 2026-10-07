// POST /api/sign/documents/[id]/retry-seal and /api/sign/envelopes/[id]/retry-seal: what the routes do on top of the service (service/seal-retry.ts):
// the capability, a bad id, a document that is not stuck, and that the sealing is handed to `after` only when something was put back.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const DOC2 = "33333333-3333-4333-8333-333333333334";
const ENV = "55555555-5555-4555-8555-555555555555";

const h = vi.hoisted(() => ({ db: null as unknown, denied: false, scheduled: vi.fn(), capability: "" }));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    h.capability = capability;
    if (h.denied) throw Object.assign(new Error(`missing ${capability}`), { status: 403 });
    return { userId: USER, accountId: ACCT };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/sign/service/seal-after", () => ({ sealAfterResponse: (...a: unknown[]) => h.scheduled(...a) }));

import { POST as retryDocument } from "./documents/[id]/retry-seal/route";
import { POST as retryEnvelope } from "./envelopes/[id]/retry-seal/route";

let db: FakeDb;
const doc = (id: string) => db.rows("sign_documents").find((d) => d.id === id)!;
const callDocument = (id = DOC) => retryDocument(new Request(`https://halo.test/api/sign/documents/${id}/retry-seal`, { method: "POST" }), { params: Promise.resolve({ id }) });
const callEnvelope = (id = ENV) => retryEnvelope(new Request(`https://halo.test/api/sign/envelopes/${id}/retry-seal`, { method: "POST" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  db = new FakeDb();
  h.db = db;
  h.denied = false;
  h.scheduled.mockReset();
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.seed("sign_envelopes", [{ id: ENV, account_id: ACCT, title: "Collection", status: "failed", created_by: USER, is_private: false }]);
  db.seed("sign_documents", [
    { id: DOC, account_id: ACCT, title: "One", status: "failed", seal_error: "ENOENT: font", sealing_attempts: 5, sealing_started_at: "2026-10-07T08:00:00Z", envelope_id: ENV, envelope_position: 1, created_by: USER, is_private: false },
    { id: DOC2, account_id: ACCT, title: "Two", status: "completed", seal_error: null, envelope_id: ENV, envelope_position: 2, created_by: USER, is_private: false },
  ]);
});

describe("POST /api/sign/documents/[id]/retry-seal", () => {
  it("asks for sign.send, puts a failed document back to being sealed, and schedules the sealing after the answer", async () => {
    const res = await callDocument();
    expect(h.capability).toBe("sign.send");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ retried: [DOC] });
    expect(doc(DOC)).toMatchObject({ status: "sealing", sealing_attempts: 0, sealing_started_at: null, seal_error: null });
    expect(h.scheduled).toHaveBeenCalledTimes(1);
  });

  it("answers 409 seal_not_stuck for a document that is not stuck, and schedules nothing", async () => {
    const res = await callDocument(DOC2);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "seal_not_stuck" });
    expect(doc(DOC2).status).toBe("completed");
    expect(h.scheduled).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not one and for a document of another workspace", async () => {
    expect((await callDocument("not-an-id")).status).toBe(404);
    db.rows("sign_documents").find((d) => d.id === DOC)!.account_id = "99999999-9999-4999-8999-999999999999";
    expect((await callDocument()).status).toBe(404);
    expect(h.scheduled).not.toHaveBeenCalled();
  });

  it("refuses a person without the capability", async () => {
    h.denied = true;
    expect((await callDocument()).status).toBe(403);
    expect(doc(DOC).status).toBe("failed");
  });
});

describe("POST /api/sign/envelopes/[id]/retry-seal", () => {
  it("puts every stuck document of the collection back and none of the others", async () => {
    const res = await callEnvelope();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retried: [DOC] });
    expect(doc(DOC).status).toBe("sealing");
    expect(doc(DOC2).status).toBe("completed");
    expect(h.scheduled).toHaveBeenCalledTimes(1);
  });

  it("answers 409 when nothing is stuck, 404 for a bad id, 403 without the capability", async () => {
    doc(DOC).status = "completed";
    const none = await callEnvelope();
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: "seal_not_stuck" });
    expect((await callEnvelope("nope")).status).toBe(404);
    h.denied = true;
    expect((await callEnvelope()).status).toBe(403);
  });
});
