/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// PUT /api/sign/documents/[id]/signers (sign.send): the list as it always was ({ signers }), and the people of the sending screens ({ people }), which
// make the roles of an uploaded file from the people and save the people who receive a copy in the same call. What the route does on top of the
// service: the capability, a non-uuid id is "not found", the body is read, and a service error is `{ error, code }` with its status.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { createDraftFromUpload } from "@/lib/sign/service/drafts";
import { ACCT, ALI_KEY, BALA_KEY, USER, makeWorld, uploadedCollection, type World } from "@/lib/sign/service/people-world";

const h = vi.hoisted(() => ({ db: null as unknown, caller: { userId: "", accountId: "" }, denied: new Set<string>(), asked: [] as string[] }));

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

import { GET as getDocument } from "../route";
import { PUT as putSigners } from "./route";

let w: World;
let docId: string;

const req = (body?: unknown) => new Request("https://halo.test/api/sign/documents/x/signers", { method: "PUT", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });

beforeEach(async () => {
  __resetRateLimitForTests();
  w = await makeWorld();
  h.db = w.db;
  h.caller = { userId: USER, accountId: ACCT };
  h.denied = new Set();
  h.asked = [];
  docId = (await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Agreement.pdf" })).document.id;
});

const people = [
  { fullName: "Ali", email: "ali@kedai.example", type: "signer", key: ALI_KEY, channel: "email", step: 1 },
  { fullName: "Bala", email: "bala@kedai.example", type: "signer", key: BALA_KEY, channel: "whatsapp", phone: "+60123456789", step: 2 },
  { fullName: "Cara Lim", email: "cara@kedai.example", type: "copy", key: "pp_caracopy1" },
];

describe("PUT /api/sign/documents/[id]/signers with people", () => {
  it("needs sign.send, and a caller without it is refused before anything is saved", async () => {
    h.denied = new Set(["sign.send"]);
    expect((await putSigners(req({ people }), at(docId))).status).toBe(403);
    expect(w.signerRows()).toHaveLength(0);
    h.denied = new Set();
    expect((await putSigners(req({ people }), at(docId))).status).toBe(200);
    expect(h.asked).toEqual(["sign.send", "sign.send"]);
  });

  it("saves the people who must sign (with the roles made from them) and the people who receive a copy, in one call", async () => {
    const { status, body } = await read(await putSigners(req({ people, ordered: true }), at(docId)));
    expect(status).toBe(200);
    expect(body.signers.map((s: any) => [s.email, s.role_key, s.channel, s.order_no])).toEqual([["ali@kedai.example", ALI_KEY, "email", 1], ["bala@kedai.example", BALA_KEY, "whatsapp", 2]]);
    expect(body.copies.map((c: any) => [c.full_name, c.email])).toEqual([["Cara Lim", "cara@kedai.example"]]);
    expect(w.docRows().find((d) => d.id === docId)!.roles_snapshot.map((r) => [r.key, r.label, r.source])).toEqual([[ALI_KEY, "Ali", "people"], [BALA_KEY, "Bala", "people"]]);
    // what the draft says afterwards: each person is a signer who has no block yet, and the copy is listed
    const got = await read(await getDocument(new Request("https://halo.test/api/sign/documents/x"), at(docId)));
    expect(got.body.copies).toHaveLength(1);
    expect(got.body.problems.map((p: any) => p.code)).toContain("signer_without_signature");
  });

  it("answers 400 bad_signers with the people it is about when the list is not sound, and 404 for an id that is not a uuid", async () => {
    const dup = await read(await putSigners(req({ people: [people[0], { ...people[1], email: "ALI@kedai.example" }] }), at(docId)));
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe("bad_signers");
    expect(dup.body.issues.map((i: any) => i.code)).toContain("duplicate_person");
    const gone = await read(await putSigners(req({ people }), at("not-a-uuid")));
    expect([gone.status, gone.body.code]).toEqual([404, "document_not_found"]);
  });

  it("refuses a document of a collection (409), and a body with neither list (400)", async () => {
    const c = await uploadedCollection(w, 2);
    const member = await read(await putSigners(req({ people }), at(c.ids[0])));
    expect([member.status, member.body.code]).toEqual([409, "document_in_envelope"]);
    const none = await read(await putSigners(req({}), at(docId)));
    expect([none.status, none.body.code]).toEqual([400, "bad_signers"]);
  });

  it("keeps a Halo user only on a document on its own, and takes the people's order from the body", async () => {
    // a member of the workspace is a Halo user; one from elsewhere is refused by the service
    w.db.seed("profiles", [{ user_id: "33333333-3333-4333-8333-333333333333", account_id: ACCT, full_name: "Siti", email: "siti@vircle.example" }]);
    const halo = await read(await putSigners(req({ people: [{ fullName: "Siti", email: "siti@vircle.example", type: "signer", key: ALI_KEY, internalUserId: "33333333-3333-4333-8333-333333333333" }] }), at(docId)));
    expect(halo.status).toBe(200);
    expect(halo.body.signers[0].internal_user_id).toBe("33333333-3333-4333-8333-333333333333");
    const stranger = await read(await putSigners(req({ people: [{ fullName: "X", email: "x@other.example", type: "signer", key: ALI_KEY, internalUserId: "44444444-4444-4444-8444-444444444444" }] }), at(docId)));
    expect(stranger.status).toBe(400);
  });
});

describe("PUT /api/sign/documents/[id]/signers with signers (as it always was)", () => {
  it("still replaces the list from roles the document has, and refuses a role it does not have", async () => {
    await putSigners(req({ people: [people[0]] }), at(docId));
    const ok = await read(await putSigners(req({ signers: [{ roleKey: ALI_KEY, kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 }] }), at(docId)));
    expect(ok.status).toBe(200);
    expect(ok.body.signers).toHaveLength(1);
    const bad = await read(await putSigners(req({ signers: [{ roleKey: "nothing", kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 }] }), at(docId)));
    expect([bad.status, bad.body.code]).toEqual([400, "signer_role"]);
  });
});
