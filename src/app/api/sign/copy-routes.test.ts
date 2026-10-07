/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// The routes of the people model (migration 175): /api/sign/documents/[id]/copies (+ [copyId]), /api/sign/envelopes/[id]/copies (+ [copyId]) and
// PUT /api/sign/envelopes/[id]/signers with `type`, `key` and copies in the answer. What the routes do on top of the services: the capability
// (menu.sign to read, sign.send to write), a non-uuid id is "not found", the body is read, and a service error is `{ error, code }` with its status.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { createDraftFromUpload, setSigners } from "@/lib/sign/service/drafts";
import { setEnvelopeSigners } from "@/lib/sign/service/envelopes";
import { ALI_KEY, BALA_KEY, ACCT, OTHER, OTHER_USER, USER, makeWorld, signerIn, uploadedCollection, type World } from "@/lib/sign/service/people-world";

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

import { DELETE as deleteDocumentCopy } from "./documents/[id]/copies/[copyId]/route";
import { GET as listDocumentCopies, POST as addDocumentCopy, PUT as setDocumentCopies } from "./documents/[id]/copies/route";
import { DELETE as deleteEnvelopeCopy } from "./envelopes/[id]/copies/[copyId]/route";
import { GET as listEnvelopeCopies, POST as addEnvelopeCopy, PUT as setEnvelopeCopies } from "./envelopes/[id]/copies/route";
import { PUT as putPeople } from "./envelopes/[id]/signers/route";
import { GET as getDocument, PATCH as patchDocument } from "./documents/[id]/route";

let w: World;
let docId: string;
let envId: string;
let envDocs: string[];

const NOWHERE = "00000000-0000-4000-8000-000000000000";
const req = (method: string, body?: unknown) => new Request("https://halo.test/api/sign/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });
const at2 = (id: string, copyId: string) => ({ params: Promise.resolve({ id, copyId }) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });

beforeEach(async () => {
  __resetRateLimitForTests();
  w = await makeWorld();
  h.db = w.db;
  h.caller = { userId: USER, accountId: ACCT };
  h.denied = new Set();
  h.asked = [];
  const { document } = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Agreement.pdf" });
  docId = document.id;
  await setSigners(w.ctx, docId, [{ roleKey: "signer", kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 }]);
  const c = await uploadedCollection(w, 2);
  envId = c.envelope.id;
  envDocs = c.ids;
  await setEnvelopeSigners(w.ctx, envId, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
});

const both = [
  { name: "documents", id: () => docId, list: listDocumentCopies, add: addDocumentCopy, put: setDocumentCopies, del: deleteDocumentCopy, notFound: "document_not_found" },
  { name: "envelopes", id: () => envId, list: listEnvelopeCopies, add: addEnvelopeCopy, put: setEnvelopeCopies, del: deleteEnvelopeCopy, notFound: "envelope_not_found" },
] as const;

describe.each(both)("/api/sign/$name/[id]/copies", (r) => {
  it("reads with menu.sign and writes with sign.send, and a caller without the capability is refused before anything is done", async () => {
    await r.list(req("GET"), at(r.id()));
    expect(h.asked).toEqual(["menu.sign"]);
    h.asked = [];
    await r.add(req("POST", { fullName: "Cara", email: "cara@kedai.example" }), at(r.id()));
    await r.put(req("PUT", { copies: [] }), at(r.id()));
    await r.del(req("DELETE"), at2(r.id(), NOWHERE));
    expect(h.asked).toEqual(["sign.send", "sign.send", "sign.send"]);

    h.denied = new Set(["sign.send"]);
    for (const res of [await r.add(req("POST", { fullName: "Dev", email: "dev@kedai.example" }), at(r.id())), await r.put(req("PUT", { copies: [{ fullName: "Dev", email: "dev@kedai.example" }] }), at(r.id())), await r.del(req("DELETE"), at2(r.id(), NOWHERE))]) {
      expect(res.status).toBe(403);
    }
    expect(w.copyRows().some((c) => c.email === "dev@kedai.example")).toBe(false);
    // reading needs menu.sign, not sign.send
    expect((await r.list(req("GET"), at(r.id()))).status).toBe(200);
    h.denied = new Set(["menu.sign"]);
    expect((await r.list(req("GET"), at(r.id()))).status).toBe(403);
  });

  it("answers 404 for an id that is not a uuid, for every method, and for a copy id that is not one", async () => {
    for (const res of [await r.list(req("GET"), at("not-a-uuid")), await r.add(req("POST", { fullName: "C", email: "c@kedai.example" }), at("not-a-uuid")), await r.put(req("PUT", { copies: [] }), at("not-a-uuid")), await r.del(req("DELETE"), at2("not-a-uuid", NOWHERE))]) {
      const { status, body } = await read(res);
      expect(status).toBe(404);
      expect(body.code).toBe(r.notFound);
    }
    const { status, body } = await read(await r.del(req("DELETE"), at2(r.id(), "nope")));
    expect([status, body.code]).toEqual([404, "copy_recipient_not_found"]);
  });

  it("adds one person (201 { copy }), reading the name as fullName or full_name, lists them, and removes them", async () => {
    const one = await read(await r.add(req("POST", { fullName: "Cara Lim", email: "cara@kedai.example" }), at(r.id())));
    expect(one.status).toBe(201);
    expect(one.body.copy).toMatchObject({ full_name: "Cara Lim", email: "cara@kedai.example", notified_at: null });
    const two = await read(await r.add(req("POST", { full_name: "Dev Raj", email: "dev@kedai.example" }), at(r.id())));
    expect(two.status).toBe(201);
    expect(two.body.copy.full_name).toBe("Dev Raj");
    const list = await read(await r.list(req("GET"), at(r.id())));
    expect(list.body.copies.map((c: { email: string }) => c.email)).toEqual(["cara@kedai.example", "dev@kedai.example"]);
    const gone = await read(await r.del(req("DELETE"), at2(r.id(), one.body.copy.id)));
    expect(gone).toEqual({ status: 200, body: { removed: true } });
    expect((await read(await r.list(req("GET"), at(r.id())))).body.copies).toHaveLength(1);
  });

  it("replaces the list with PUT, reading fullName or full_name, and answers 400 for something that is not a list", async () => {
    const out = await read(await r.put(req("PUT", { copies: [{ fullName: "Cara", email: "cara@kedai.example" }, { full_name: "Dev", email: "dev@kedai.example" }] }), at(r.id())));
    expect(out.status).toBe(200);
    expect(out.body.copies.map((c: { full_name: string }) => c.full_name)).toEqual(["Cara", "Dev"]);
    for (const bad of [{}, { copies: "x" }, { copies: { a: 1 } }]) {
      const { status, body } = await read(await r.put(req("PUT", bad), at(r.id())));
      expect([status, body.code]).toEqual([400, "copy_name"]);
    }
    expect(w.copyRows()).toHaveLength(2);
  });

  it("turns a service error into { error, code } with the service's status", async () => {
    await r.add(req("POST", { fullName: "Cara", email: "cara@kedai.example" }), at(r.id()));
    const cases: [Response, number, string][] = [
      [await r.add(req("POST", { fullName: "Cara again", email: "CARA@kedai.example" }), at(r.id())), 400, "copy_duplicate"],
      [await r.add(req("POST", { fullName: "Ali", email: "ali@kedai.example" }), at(r.id())), 400, "copy_is_signer"],
      [await r.add(req("POST", { fullName: "", email: "x@kedai.example" }), at(r.id())), 400, "copy_name"],
      [await r.add(req("POST", { fullName: "X", email: "nope" }), at(r.id())), 400, "copy_email"],
      [await r.add(req("POST", {}), at(r.id())), 400, "copy_name"],
      [await r.del(req("DELETE"), at2(r.id(), NOWHERE)), 404, "copy_recipient_not_found"],
      [await r.put(req("PUT", { copies: Array.from({ length: 11 }, (_, i) => ({ fullName: `P${i}`, email: `p${i}@kedai.example` })) }), at(r.id())), 400, "copy_limit"],
      [await r.add(new Request("https://halo.test/x", { method: "POST", body: "{not json" }), at(r.id())), 400, "bad_json"],
    ];
    for (const [res, status, code] of cases) {
      const out = await read(res);
      expect([out.status, out.body.code]).toEqual([status, code]);
      expect(typeof out.body.error).toBe("string");
    }
    // not open any more: 409
    for (const d of w.docRows()) d.status = "completed";
    for (const e of w.db.rows("sign_envelopes")) e.status = "completed";
    const closed = await read(await r.add(req("POST", { fullName: "Late", email: "late@kedai.example" }), at(r.id())));
    expect([closed.status, closed.body.code]).toEqual([409, "copy_not_open"]);
    const removed = await read(await r.del(req("DELETE"), at2(r.id(), (w.copyRows()[0].id as string))));
    expect([removed.status, removed.body.code]).toEqual([409, "copy_not_open"]);
  });

  it("is not found for a caller of another workspace: add, list, remove and set (and a person of this workspace cannot be removed by them)", async () => {
    const mine = await read(await r.add(req("POST", { fullName: "Cara", email: "cara@kedai.example" }), at(r.id())));
    h.caller = { userId: OTHER_USER, accountId: OTHER };
    for (const res of [
      await r.add(req("POST", { fullName: "Eve", email: "eve@other.example" }), at(r.id())),
      await r.list(req("GET"), at(r.id())),
      await r.put(req("PUT", { copies: [] }), at(r.id())),
      await r.del(req("DELETE"), at2(r.id(), mine.body.copy.id)),
    ]) {
      const out = await read(res);
      expect([out.status, out.body.code]).toEqual([404, r.notFound]);
    }
    expect(w.copyRows().map((c) => c.email)).toEqual(["cara@kedai.example"]);
  });
});

describe("a document of a collection", () => {
  it("answers 409 document_in_envelope for add, set and remove on /documents/[id]/copies", async () => {
    for (const res of [
      await addDocumentCopy(req("POST", { fullName: "C", email: "c@kedai.example" }), at(envDocs[0])),
      await setDocumentCopies(req("PUT", { copies: [{ fullName: "C", email: "c@kedai.example" }] }), at(envDocs[0])),
      await deleteDocumentCopy(req("DELETE"), at2(envDocs[0], NOWHERE)),
    ]) {
      const out = await read(res);
      expect([out.status, out.body.code]).toEqual([409, "document_in_envelope"]);
    }
    expect(w.copyRows()).toHaveLength(0);
  });
});

describe("PUT /api/sign/envelopes/[id]/signers with people of both types", () => {
  const ALI = { fullName: "Ali", email: "ali@kedai.example", type: "signer", key: ALI_KEY, channel: "email" };
  const BALA = { fullName: "Bala", email: "bala@kedai.example", type: "signer", key: BALA_KEY, channel: "email" };
  const CARA = { fullName: "Cara Lim", email: "cara@kedai.example", type: "copy" };

  it("needs sign.send, answers 404 for a bad id, and 400 bad_signers for something that is not a list", async () => {
    h.denied = new Set(["sign.send"]);
    expect((await putPeople(req("PUT", { people: [ALI] }), at(envId))).status).toBe(403);
    h.denied = new Set();
    expect(h.asked.at(-1)).toBe("sign.send");
    const bad = await read(await putPeople(req("PUT", { people: [ALI] }), at("nope")));
    expect([bad.status, bad.body.code]).toEqual([404, "envelope_not_found"]);
    const notList = await read(await putPeople(req("PUT", { people: "x" }), at(envId)));
    expect([notList.status, notList.body.code]).toEqual([400, "bad_signers"]);
    expect((await read(await putPeople(req("PUT", {}), at(envId)))).body.code).toBe("bad_signers");
  });

  it("saves the people who must sign and the people who receive a copy in one call and answers { signers, copies }", async () => {
    const out = await read(await putPeople(req("PUT", { people: [ALI, BALA, CARA] }), at(envId)));
    expect(out.status).toBe(200);
    expect(out.body.signers.map((s: { email: string; role_key: string }) => [s.email, s.role_key])).toEqual(expect.arrayContaining([["ali@kedai.example", ALI_KEY], ["bala@kedai.example", BALA_KEY]]));
    expect(out.body.signers).toHaveLength(4);
    expect(out.body.copies.map((c: { email: string }) => c.email)).toEqual(["cara@kedai.example"]);
    // the key becomes the role on the uploaded documents
    expect(w.docRows().find((d) => d.id === envDocs[0])!.roles_snapshot.map((x) => x.key)).toEqual([ALI_KEY, BALA_KEY]);
    // no row, no link and no role for the copy
    expect(w.signerRows().some((s) => s.email === "cara@kedai.example")).toBe(false);
    // a person with no `type` is a signer; an unknown type is too; the copies are replaced, not added to
    const again = await read(await putPeople(req("PUT", { people: [{ ...ALI, type: undefined }, { ...BALA, type: "whatever" }, { fullName: "Dev", email: "dev@kedai.example", type: "copy" }] }), at(envId)));
    expect(again.body.signers).toHaveLength(4);
    expect(again.body.copies.map((c: { email: string }) => c.email)).toEqual(["dev@kedai.example"]);
  });

  it("moves a person from copy to signer and back in one save", async () => {
    await putPeople(req("PUT", { people: [ALI, CARA] }), at(envId));
    const asSigner = await read(await putPeople(req("PUT", { people: [ALI, { ...CARA, type: "signer", key: "pp_caracccc3" }] }), at(envId)));
    expect(asSigner.status).toBe(200);
    expect(asSigner.body.copies).toEqual([]);
    expect(w.signerRows().some((s) => s.email === "cara@kedai.example")).toBe(true);
    const back = await read(await putPeople(req("PUT", { people: [ALI, CARA] }), at(envId)));
    expect(back.body.copies).toHaveLength(1);
    expect(w.signerRows().some((s) => s.email === "cara@kedai.example")).toBe(false);
  });

  it("refuses a list that is not sound with 400 bad_signers and the issues, saving nothing", async () => {
    const out = await read(await putPeople(req("PUT", { people: [ALI, { ...BALA, email: "ali@kedai.example" }, { ...CARA, email: "cara@kedai.example" }] }), at(envId)));
    expect([out.status, out.body.code]).toEqual([400, "bad_signers"]);
    expect(out.body.issues).toContainEqual({ code: "duplicate_person", detail: "1" });
    expect(w.copyRows()).toHaveLength(0);
  });

  it("refuses a copy to someone who signs (copy_is_signer, 400) and a half-made copy, and keeps the roles of a person still being filled in (`incomplete`)", async () => {
    const dup = await read(await putPeople(req("PUT", { people: [ALI, { ...CARA, email: "ALI@kedai.example" }] }), at(envId)));
    expect([dup.status, dup.body.code]).toEqual([400, "copy_is_signer"]);
    const half = await read(await putPeople(req("PUT", { people: [ALI, { ...CARA, email: "" }] }), at(envId)));
    expect([half.status, half.body.code]).toEqual([400, "copy_email"]);
    // `incomplete` rides through to the service: Bala's role stays with no row for her
    await putPeople(req("PUT", { people: [ALI, BALA] }), at(envId));
    const out = await read(await putPeople(req("PUT", { people: [ALI, { ...BALA, email: "", incomplete: true }] }), at(envId)));
    expect(out.status).toBe(200);
    expect(w.docRows().find((d) => d.id === envDocs[0])!.roles_snapshot.map((x) => x.key)).toEqual([ALI_KEY, BALA_KEY]);
    expect(w.signerRows().some((s) => s.role_key === BALA_KEY)).toBe(false);
  });

  it("is not found for a caller of another workspace", async () => {
    h.caller = { userId: OTHER_USER, accountId: OTHER };
    const out = await read(await putPeople(req("PUT", { people: [ALI] }), at(envId)));
    expect([out.status, out.body.code]).toEqual([404, "envelope_not_found"]);
    expect(w.signerRows().filter((s) => envDocs.includes(s.document_id)).map((s) => s.email)).toEqual(["ali@kedai.example", "ali@kedai.example"]);
  });
});

describe("/api/sign/documents/[id] and the people model", () => {
  it("GET answers the copies of a document on its own, and none for a document of a collection (they belong to the collection)", async () => {
    await addDocumentCopy(req("POST", { fullName: "Cara", email: "cara@kedai.example" }), at(docId));
    await addEnvelopeCopy(req("POST", { fullName: "Dev", email: "dev@kedai.example" }), at(envId));
    const own = await read(await getDocument(req("GET"), at(docId)));
    expect(own.status).toBe(200);
    expect(own.body.copies.map((c: { email: string }) => c.email)).toEqual(["cara@kedai.example"]);
    // the copies are not among the signers
    expect(own.body.signers.map((s: { email: string }) => s.email)).toEqual(["ali@kedai.example"]);
    const inCollection = await read(await getDocument(req("GET"), at(envDocs[0])));
    expect(inCollection.body.copies).toEqual([]);
    expect(inCollection.body.envelope.id).toBe(envId);
  });

  it("PATCH with roles on an uploaded document of a collection does not take them, and takes the fields for the people's roles", async () => {
    const roles = [{ key: "hacker", label: "Hacker", kind: "signer", color: 0 }];
    const sig = { key: "a1", type: "signature", role: ALI_KEY, page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.06, required: true };
    const out = await read(await patchDocument(req("PATCH", { roles, fields: [sig] }), at(envDocs[0])));
    expect(out.status).toBe(200);
    expect(out.body.document.roles_snapshot.map((r: { key: string }) => r.key)).toEqual([ALI_KEY]);
    expect(out.body.document.fields_snapshot).toHaveLength(1);
    const bad = await read(await patchDocument(req("PATCH", { roles, fields: [{ ...sig, key: "h1", role: "hacker" }] }), at(envDocs[0])));
    expect([bad.status, bad.body.code]).toEqual([400, "invalid_layout"]);
  });
});
