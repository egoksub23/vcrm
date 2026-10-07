/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// The routes of migration 176: what a person at a screen is told about a private document (the same "not found" as for a document that is not there,
// in every route that reads or changes one), the choice made when a document or a collection is started and changed, and the separate permission
// for Reveal on a sensitive answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { createDraftFromUpload } from "@/lib/sign/service/drafts";
import { ACCT, OTHER_USER, TPL_A, TPL_B, USER, makeWorld, type World } from "@/lib/sign/service/people-world";

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

import { GET as attention } from "./attention/route";
import { GET as exportCsv } from "./documents/export/route";
import { GET as getDocument, PATCH as patchDocument } from "./documents/[id]/route";
import { GET as progress } from "./documents/[id]/progress/route";
import { GET as copies } from "./documents/[id]/copies/route";
import { GET as getFile } from "./documents/[id]/file/route";
import { POST as reveal } from "./documents/[id]/sensitive/route";
import { POST as startDocument } from "./documents/route";
import { POST as startCollection } from "./envelopes/route";
import { GET as getEnvelope, PATCH as patchEnvelope } from "./envelopes/[id]/route";
import { POST as zip } from "./documents/zip/route";

const ADMIN_U = "aaaaaaaa-0000-4000-8000-000000000001";
const STAFF_U = "aaaaaaaa-0000-4000-8000-000000000004";
const NOWHERE = "00000000-0000-4000-8000-000000000000";

let w: World;

const req = (method: string, body?: unknown, url = "https://halo.test/api/sign/x") => new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  h.denied = new Set();
  h.asked = [];
  as(USER);
  w.db.seed("profiles", [
    { user_id: ADMIN_U, account_id: ACCT, account_role: "admin", full_name: "Admin", email: "admin@vircle.example" },
    { user_id: STAFF_U, account_id: ACCT, account_role: "agent", full_name: "Staff", email: "staff@vircle.example" },
  ]);
  w.db.rows("profiles").find((p) => p.user_id === USER)!.account_role = "agent";
});

const upload = (isPrivate: boolean, name = isPrivate ? "Secret offer" : "Open agreement") => createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: `${name}.pdf`, isPrivate }).then((r) => r.document);

describe("starting a document", () => {
  it("is private when asked (JSON), not otherwise, and refuses a choice that is not one", async () => {
    const secret = await read(await startDocument(req("POST", { templateId: TPL_A, isPrivate: true })));
    expect(secret.status).toBe(201);
    expect(w.docRows().find((d) => d.id === secret.body.document.id)?.is_private).toBe(true);
    const open = await read(await startDocument(req("POST", { templateId: TPL_A })));
    expect(w.docRows().find((d) => d.id === open.body.document.id)?.is_private ?? false).toBe(false);
    const asText = await read(await startDocument(req("POST", { templateId: TPL_A, isPrivate: "true" })));
    expect(w.docRows().find((d) => d.id === asText.body.document.id)?.is_private).toBe(true);
    const bad = await read(await startDocument(req("POST", { templateId: TPL_A, isPrivate: "maybe" })));
    expect([bad.status, bad.body.code]).toEqual([400, "bad_private"]);
    expect(w.docRows()).toHaveLength(3);
  });

  it("is private when asked in the upload's own fields (multipart)", async () => {
    const form = new FormData();
    form.append("file", new Blob([w.pdf as BlobPart], { type: "application/pdf" }), "Agreement.pdf");
    form.append("isPrivate", "true");
    const res = await startDocument(new Request("https://halo.test/api/sign/documents", { method: "POST", body: form }));
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(w.docRows().find((d) => d.id === body.document.id)?.is_private).toBe(true);
  });

  it("starts a collection that is private, and every document in it", async () => {
    const res = await read(await startCollection(req("POST", { templateIds: [TPL_A, TPL_B], isPrivate: true })));
    expect(res.status).toBe(201);
    expect(w.db.rows("sign_envelopes").find((e) => e.id === res.body.envelope.id)?.is_private).toBe(true);
    expect(res.body.documents).toHaveLength(2);
    expect(w.docRows().filter((d) => d.envelope_id === res.body.envelope.id).every((d) => d.is_private === true)).toBe(true);
  });
});

describe("a private document and a person who may not see it", () => {
  it("answers 404 in every route that reads one, and 200 for the uploader and an admin", async () => {
    const d = await upload(true);
    const routes: [string, () => Promise<Response>][] = [
      ["the document", () => getDocument(req("GET"), at(d.id))],
      ["its progress", () => progress(req("GET"), at(d.id))],
      ["its file", () => getFile(req("GET", undefined, `https://halo.test/api/sign/documents/${d.id}/file?kind=base`), at(d.id))],
      ["its copy recipients", () => copies(req("GET"), at(d.id))],
    ];
    as(STAFF_U);
    for (const [name, call] of routes) {
      const { status, body } = await read(await call());
      expect([name, status, body.code]).toEqual([name, 404, "document_not_found"]);
    }
    // exactly what a document that is not there answers
    const missing = await read(await getDocument(req("GET"), at(NOWHERE)));
    const hidden = await read(await getDocument(req("GET"), at(d.id)));
    expect(hidden).toEqual(missing);
    for (const who of [USER, ADMIN_U]) {
      as(who);
      expect((await getDocument(req("GET"), at(d.id))).status).toBe(200);
      expect((await getFile(req("GET", undefined, `https://halo.test/api/sign/documents/${d.id}/file?kind=base`), at(d.id))).status).toBe(200);
    }
  });

  it("is shown to the uploader as private, with the flag in what the screen reads", async () => {
    const d = await upload(true);
    const { body } = await read(await getDocument(req("GET"), at(d.id)));
    expect(body.document.is_private).toBe(true);
  });

  it("answers 404 for a private collection, and the same for one that is not there", async () => {
    const made = await read(await startCollection(req("POST", { templateIds: [TPL_A, TPL_B], isPrivate: true })));
    const id = made.body.envelope.id as string;
    as(STAFF_U);
    const hidden = await read(await getEnvelope(req("GET"), at(id)));
    const missing = await read(await getEnvelope(req("GET"), at(NOWHERE)));
    expect([hidden.status, hidden.body.code]).toEqual([404, "envelope_not_found"]);
    expect(hidden).toEqual(missing);
    expect((await patchEnvelope(req("PATCH", { title: "x" }), at(id))).status).toBe(404);
    as(ADMIN_U);
    expect((await getEnvelope(req("GET"), at(id))).status).toBe(200);
  });

  it("leaves it out of the list a person exports and the zip they ask for, and out of what needs attention", async () => {
    const open = await upload(false);
    const secret = await upload(true);
    for (const d of [open, secret]) {
      const path = `account-${ACCT}/${d.id}/final/${d.id}.pdf`;
      Object.assign(w.db.rows("sign_documents").find((x) => x.id === d.id)!, { status: "declined", final_path: path, updated_at: new Date().toISOString() });
      w.db.files.set(path, new Uint8Array([1, 2, 3]));
    }
    as(STAFF_U);
    const csv = await (await exportCsv(req("GET", undefined, "https://halo.test/api/sign/documents/export"))).text();
    expect(csv).toContain(open.title);
    expect(csv).not.toContain(secret.title);
    const items = (await read(await attention(req("GET")))).body.items as { documentId: string }[];
    expect(items.map((i) => i.documentId)).toEqual([open.id]);
    // the zip: only completed documents go in; the private one is "not found", never listed
    for (const d of [open, secret]) w.db.rows("sign_documents").find((x) => x.id === d.id)!.status = "completed";
    const zipped = await zip(req("POST", { ids: [open.id, secret.id] }));
    expect(zipped.status).toBe(200);
    expect(zipped.headers.get("X-Sign-Zip-Included")).toBe("1");
    const nothing = await read(await zip(req("POST", { ids: [secret.id] })));
    expect([nothing.status, nothing.body.code]).toEqual([409, "nothing_to_download"]);
    // an admin gets both
    as(ADMIN_U);
    expect((await zip(req("POST", { ids: [open.id, secret.id] }))).headers.get("X-Sign-Zip-Included")).toBe("2");
    expect(await (await exportCsv(req("GET", undefined, "https://halo.test/api/sign/documents/export"))).text()).toContain(secret.title);
  });
});

describe("changing whether a document is private", () => {
  it("is the uploader's or an admin's; another agent is refused (403) on a public document and told 404 on a private one", async () => {
    const open = await upload(false);
    as(STAFF_U);
    const refused = await read(await patchDocument(req("PATCH", { isPrivate: true }), at(open.id)));
    expect([refused.status, refused.body.code]).toEqual([403, "private_not_allowed"]);
    as(USER);
    const done = await read(await patchDocument(req("PATCH", { isPrivate: true }), at(open.id)));
    expect([done.status, done.body.document.is_private]).toEqual([200, true]);
    as(STAFF_U);
    const hidden = await read(await patchDocument(req("PATCH", { isPrivate: false }), at(open.id)));
    expect([hidden.status, hidden.body.code]).toEqual([404, "document_not_found"]);
    as(ADMIN_U);
    const back = await read(await patchDocument(req("PATCH", { isPrivate: false }), at(open.id)));
    expect([back.status, back.body.document.is_private]).toEqual([200, false]);
  });

  it("says why when it is too late, and what is wrong with a choice that is not one", async () => {
    const d = await upload(true);
    const bad = await read(await patchDocument(req("PATCH", { isPrivate: "yes" }), at(d.id)));
    expect([bad.status, bad.body.code]).toEqual([400, "bad_private"]);
    w.db.rows("sign_documents").find((x) => x.id === d.id)!.status = "sent";
    const late = await read(await patchDocument(req("PATCH", { isPrivate: false }), at(d.id)));
    expect([late.status, late.body.code]).toEqual([409, "document_not_draft"]);
  });

  it("is chosen on a collection, and goes onto its documents", async () => {
    const made = await read(await startCollection(req("POST", { templateIds: [TPL_A, TPL_B] })));
    const id = made.body.envelope.id as string;
    const done = await read(await patchEnvelope(req("PATCH", { isPrivate: true }), at(id)));
    expect([done.status, done.body.envelope.is_private]).toEqual([200, true]);
    expect(w.docRows().filter((d) => d.envelope_id === id).every((d) => d.is_private === true)).toBe(true);
    as(OTHER_USER);
    expect((await patchEnvelope(req("PATCH", { isPrivate: false }), at(id))).status).toBe(404);
  });
});

describe("Reveal on a sensitive answer", () => {
  it("asks for sign.reveal-sensitive and no longer for sign.send: a person who has only sign.send is refused before anything is done", async () => {
    const d = await upload(false);
    await reveal(req("POST", { field: "icNumber" }), at(d.id));
    expect(h.asked).toEqual(["sign.reveal-sensitive"]);
    h.asked = [];
    h.denied = new Set(["sign.reveal-sensitive"]);
    const refused = await reveal(req("POST", { field: "icNumber" }), at(d.id));
    expect(refused.status).toBe(403);
    expect(h.asked).toEqual(["sign.reveal-sensitive"]);
    expect(w.events("sensitive_viewed")).toHaveLength(0);
    // and holding it without sign.send is enough to ask (the answer is then "not found": this document has no such field)
    h.denied = new Set(["sign.send"]);
    const asked = await read(await reveal(req("POST", { field: "icNumber" }), at(d.id)));
    expect([asked.status, asked.body.code]).toEqual([404, "answer_not_found"]);
  });

  it("is told 404 for a private document the person may not see, even with the permission", async () => {
    const d = await upload(true);
    as(STAFF_U);
    const { status, body } = await read(await reveal(req("POST", { field: "icNumber" }), at(d.id)));
    expect([status, body.code]).toEqual([404, "document_not_found"]);
  });

  it("answers 404 for an id that is not an id", async () => {
    const { status, body } = await read(await reveal(req("POST", { field: "icNumber" }), at("not-a-uuid")));
    expect([status, body.code]).toEqual([404, "document_not_found"]);
  });
});
