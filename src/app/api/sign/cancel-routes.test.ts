/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// POST /api/sign/documents/[id]/cancel and POST /api/sign/envelopes/[id]/cancel (migration 181): the staff wrapper (a capability and a rate limit), the
// body, and the answers (200 with what was cancelled; 400, 403, 404 and 409 for each way it can be wrong). The rule itself is in
// lib/sign/service/cancel.test.ts; here it is proved that the routes carry it, with the permission it needs (menu.sign: NOT sign.void).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { createDraftFromUpload } from "@/lib/sign/service/drafts";
import { ACCT, OTHER_USER, SENDER_EMAIL, USER, docOf, makeWorld, uploadedCollection, type World } from "@/lib/sign/service/people-world";

const h = vi.hoisted(() => ({ db: null as unknown, deps: {} as Record<string, unknown>, caller: { userId: "", accountId: "" }, denied: new Set<string>(), asked: [] as string[] }));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    h.asked.push(capability);
    if (h.denied.has(capability)) throw Object.assign(new Error(`missing ${capability}`), { status: 403 });
    return { userId: h.caller.userId, accountId: h.caller.accountId };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
  assertCapability: () => undefined,
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as { client: () => unknown }).client() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));
// the route sends mail through the real transport chooser; the world's recorder stands in for it
vi.mock("@/lib/sign/notify", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sign/notify")>();
  // every property read goes to the world's own mail recorder
  return { ...real, realDeps: new Proxy({}, { get: (_t, k) => h.deps[k as string] }) as typeof real.realDeps };
});

import { POST as cancelDocument } from "./documents/[id]/cancel/route";
import { GET as getDocument } from "./documents/[id]/route";
import { POST as cancelEnvelope } from "./envelopes/[id]/cancel/route";

const ADMIN_U = "aaaaaaaa-0000-4000-8000-000000000001";
const STAFF_U = "aaaaaaaa-0000-4000-8000-000000000004";
const NOWHERE = "00000000-0000-4000-8000-000000000000";
const REASON = "Signed with the wrong price list.";

let w: World;

const req = (body?: unknown, raw?: string) => new Request("https://halo.test/api/sign/x/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const as = (userId: string) => {
  h.caller = { userId, accountId: ACCT };
};

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetRateLimitForTests();
  w = await makeWorld();
  h.db = w.db;
  h.deps = w.ctx.deps as unknown as Record<string, unknown>;
  h.denied = new Set();
  h.asked = [];
  as(USER);
  w.db.seed("profiles", [
    { user_id: ADMIN_U, account_id: ACCT, account_role: "admin", full_name: "Admin", email: "admin@vircle.example" },
    { user_id: STAFF_U, account_id: ACCT, account_role: "agent", full_name: "Staff", email: "staff@vircle.example" },
  ]);
  w.db.rows("profiles").find((p) => p.user_id === USER)!.account_role = "agent";
});

async function completed() {
  const { document } = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Agreement.pdf", title: "Merchant Agreement" });
  Object.assign(docOf(w, document.id), { status: "completed", completed_at: "2026-10-02T09:00:00Z", final_path: `account-${ACCT}/${document.id}/final.pdf`, final_sha256: "ab".repeat(32) });
  w.db.seed("sign_signers", [{ id: `s-${document.id}`, account_id: ACCT, document_id: document.id, role_key: "signer", kind: "signer", full_name: "Ali", email: "ali@kedai.example", channel: "email", order_no: 1, status: "signed" }]);
  return document.id;
}

async function collection() {
  const c = await uploadedCollection(w, 2);
  Object.assign(w.db.rows("sign_envelopes").find((e) => e.id === c.envelope.id)!, { status: "completed" });
  for (const id of c.ids) Object.assign(docOf(w, id), { status: "completed", completed_at: "2026-10-02T09:00:00Z", final_path: `account-${ACCT}/${id}/final.pdf`, final_sha256: "ab".repeat(32) });
  return c;
}

describe("POST /api/sign/documents/[id]/cancel", () => {
  it("cancels a completed document for the person who made it, and says how much was cancelled", async () => {
    const id = await completed();
    const { status, body } = await read(await cancelDocument(req({ reason: `  ${REASON} `, notify: false }), at(id)));
    expect(status).toBe(200);
    expect(body).toMatchObject({ cancelled: true, scope: "document", documents: 1, notice: null });
    expect(docOf(w, id)).toMatchObject({ status: "completed", cancelled_by: USER, cancel_reason: REASON });
    expect(w.mail).toHaveLength(0);
  });

  it("asks for menu.sign and nothing else: cancelling is not sign.void, so a role without void can cancel its own document", async () => {
    h.denied = new Set(["sign.void", "sign.send"]);
    const id = await completed();
    expect((await cancelDocument(req({ reason: REASON }), at(id))).status).toBe(200);
    expect(h.asked).toEqual(["menu.sign"]);
  });

  it("is refused without menu.sign, like every Secure Sign screen", async () => {
    h.denied = new Set(["menu.sign"]);
    const id = await completed();
    expect((await cancelDocument(req({ reason: REASON }), at(id))).status).toBe(403);
    expect(docOf(w, id).cancelled_at ?? null).toBeNull();
  });

  it("emails the people only when notify is true", async () => {
    const id = await completed();
    const { body } = await read(await cancelDocument(req({ reason: REASON, notify: true }), at(id)));
    expect(body.notice).toEqual({ sent: 2, failed: 0 });
    expect(w.mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", SENDER_EMAIL].sort());
    // "yes" is not true
    const other = await completed();
    expect((await read(await cancelDocument(req({ reason: REASON, notify: "yes" }), at(other)))).body.notice).toBeNull();
  });

  it("answers 403 to another agent, 200 to an admin, and 404 for a document that is not there, another workspace's or not an id", async () => {
    const id = await completed();
    as(STAFF_U);
    expect(await read(await cancelDocument(req({ reason: REASON }), at(id)))).toMatchObject({ status: 403, body: { code: "cancel_not_allowed" } });
    as(ADMIN_U);
    expect((await cancelDocument(req({ reason: REASON }), at(id))).status).toBe(200);
    expect(await read(await cancelDocument(req({ reason: REASON }), at(NOWHERE)))).toMatchObject({ status: 404, body: { code: "document_not_found" } });
    expect(await read(await cancelDocument(req({ reason: REASON }), at("not-an-id")))).toMatchObject({ status: 404, body: { code: "document_not_found" } });
    h.caller = { userId: OTHER_USER, accountId: "99999999-9999-4999-8999-999999999999" };
    expect((await cancelDocument(req({ reason: REASON }), at(id))).status).toBe(404);
  });

  it("answers 400 for a reason that is missing, too short or too long, and for a body that is not an object", async () => {
    const id = await completed();
    for (const body of [{}, { reason: "" }, { reason: "ab" }, { reason: "x".repeat(501) }, { reason: 42 }]) {
      expect(await read(await cancelDocument(req(body), at(id))), JSON.stringify(body)).toMatchObject({ status: 400, body: { code: "cancel_reason_invalid" } });
    }
    expect(await read(await cancelDocument(req(undefined, "[1,2]"), at(id)))).toMatchObject({ status: 400, body: { code: "bad_json" } });
    expect(await read(await cancelDocument(req(undefined, "{not json"), at(id)))).toMatchObject({ status: 400, body: { code: "bad_json" } });
    expect(docOf(w, id).cancelled_at ?? null).toBeNull();
  });

  it("answers 409 for a document that is not completed, one that was cancelled already, and one of a collection (naming the collection)", async () => {
    const draft = (await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Draft.pdf" })).document.id;
    expect(await read(await cancelDocument(req({ reason: REASON }), at(draft)))).toMatchObject({ status: 409, body: { code: "document_not_completed" } });
    const id = await completed();
    expect((await cancelDocument(req({ reason: REASON }), at(id))).status).toBe(200);
    expect(await read(await cancelDocument(req({ reason: REASON }), at(id)))).toMatchObject({ status: 409, body: { code: "document_already_cancelled" } });
    const c = await collection();
    const res = await read(await cancelDocument(req({ reason: REASON }), at(c.ids[0])));
    expect(res).toMatchObject({ status: 409, body: { code: "belongs_to_collection", issues: [{ code: "belongs_to_collection", detail: c.envelope.id }] } });
  });

  it("is rate limited to 20 a minute for each person", async () => {
    const id = await completed();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await cancelDocument(req({ reason: REASON }), at(id))).status;
    expect(last).toBe(429);
  });

  it("shows on the document the page reads: still completed, with the stamp", async () => {
    const id = await completed();
    await cancelDocument(req({ reason: REASON }), at(id));
    const { body } = await read(await getDocument(new Request("https://halo.test/api/sign/documents/x"), at(id)));
    expect(body.document).toMatchObject({ status: "completed", cancelled_by: USER, cancel_reason: REASON });
    expect(body.document.cancelled_at).toBeTruthy();
  });
});

describe("POST /api/sign/envelopes/[id]/cancel", () => {
  it("cancels the collection with every document in it", async () => {
    const c = await collection();
    const { status, body } = await read(await cancelEnvelope(req({ reason: REASON, notify: false }), at(c.envelope.id)));
    expect(status).toBe(200);
    expect(body).toMatchObject({ cancelled: true, scope: "collection", documents: 2, notice: null });
    for (const id of c.ids) expect(docOf(w, id)).toMatchObject({ status: "completed", cancelled_by: USER, cancel_reason: REASON });
    expect(h.asked).toEqual(["menu.sign"]);
  });

  it("answers 403, 404, 400 and 409 as the document's route does", async () => {
    const c = await collection();
    as(STAFF_U);
    expect(await read(await cancelEnvelope(req({ reason: REASON }), at(c.envelope.id)))).toMatchObject({ status: 403, body: { code: "cancel_not_allowed" } });
    as(USER);
    expect(await read(await cancelEnvelope(req({ reason: "no" }), at(c.envelope.id)))).toMatchObject({ status: 400, body: { code: "cancel_reason_invalid" } });
    expect(await read(await cancelEnvelope(req({ reason: REASON }), at(NOWHERE)))).toMatchObject({ status: 404, body: { code: "envelope_not_found" } });
    expect(await read(await cancelEnvelope(req({ reason: REASON }), at("nope")))).toMatchObject({ status: 404, body: { code: "envelope_not_found" } });
    expect((await cancelEnvelope(req({ reason: REASON }), at(c.envelope.id))).status).toBe(200);
    expect(await read(await cancelEnvelope(req({ reason: REASON }), at(c.envelope.id)))).toMatchObject({ status: 409, body: { code: "envelope_already_cancelled" } });
    const draft = await uploadedCollection(w, 2);
    expect(await read(await cancelEnvelope(req({ reason: REASON }), at(draft.envelope.id)))).toMatchObject({ status: 409, body: { code: "envelope_not_completed" } });
  });
});
