// GET /api/sign/documents/[id]/writebacks: the contact changes a document's answers made. Anyone with the Secure Sign menu may
// read that something changed; the old and new value are real only for a person who holds sign.reveal-sensitive, and
// otherwise a mask that is the same whatever the value (the real value is never in the answer).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCT = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const BOSS = "33333333-3333-4333-8333-333333333333";
const DOC = "44444444-4444-4444-8444-444444444444";
const OTHER_DOC = "55555555-5555-4555-8555-555555555555";
const PRIVATE_DOC = "66666666-6666-4666-8666-666666666666";

const h = vi.hoisted(() => ({ db: null as unknown, caller: { userId: "", accountId: "", capabilities: new Set<string>() }, denied: false }));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: async (capability: string) => {
    if (h.denied) throw Object.assign(new Error(`missing ${capability}`), { status: 403 });
    return { ...h.caller };
  },
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
  assertCapability: () => undefined,
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));

import { GET } from "./route";

const call = (id = DOC) => GET(new Request(`https://halo.test/api/sign/documents/${id}/writebacks`), { params: Promise.resolve({ id }) });

const EVENTS = [
  { account_id: ACCT, document_id: DOC, doc_seq: 7, type: "writeback", detail: { field: "email", old: "ali@old.example", new: "ali@new.example" } },
  { account_id: ACCT, document_id: DOC, doc_seq: 8, type: "writeback", detail: { field: "custom:Region", old: "", new: "Selangor" } },
  { account_id: ACCT, document_id: DOC, doc_seq: 9, type: "writeback", detail: { field: "company", old: "Kedai Runcit Ali", new: "Kedai Runcit Ali Sdn Bhd" } },
  { account_id: ACCT, document_id: DOC, doc_seq: 5, type: "sent", detail: { old: "not a write-back" } },
  { account_id: ACCT, document_id: OTHER_DOC, doc_seq: 3, type: "writeback", detail: { field: "name", old: "Someone Else", new: "Another One" } },
  { account_id: OTHER_ACCT, document_id: DOC, doc_seq: 4, type: "writeback", detail: { field: "name", old: "Other Workspace", new: "Not Ours" } },
];

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  h.db = db;
  h.denied = false;
  h.caller = { userId: USER, accountId: ACCT, capabilities: new Set(["menu.sign"]) };
  db.seed("sign_documents", [
    { id: DOC, account_id: ACCT, is_private: false, created_by: BOSS },
    { id: OTHER_DOC, account_id: ACCT, is_private: false, created_by: BOSS },
    { id: PRIVATE_DOC, account_id: ACCT, is_private: true, created_by: BOSS },
  ]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, account_role: "member" }]);
  db.seed("sign_events", [...EVENTS, { account_id: ACCT, document_id: PRIVATE_DOC, doc_seq: 1, type: "writeback", detail: { field: "name", old: "Secret Old", new: "Secret New" } }]);
});

describe("GET /api/sign/documents/[id]/writebacks", () => {
  it("gives a person with only the menu the fields that changed and a mask, and the real values nowhere in the answer", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mayReveal: boolean; changes: { seq: number; field: string; old: string; new: string; masked: boolean }[] };
    expect(body.mayReveal).toBe(false);
    expect(body.changes).toEqual([
      { seq: 7, field: "email", old: "••••", new: "••••", masked: true },
      // an empty value is no secret, and says so
      { seq: 8, field: "custom:Region", old: "", new: "••••", masked: true },
      { seq: 9, field: "company", old: "••••", new: "••••", masked: true },
    ]);
    const text = JSON.stringify(body);
    for (const secret of ["ali@old.example", "ali@new.example", "Selangor", "Kedai Runcit", "Someone Else", "Other Workspace", "Secret"]) expect(text).not.toContain(secret);
  });

  it("gives a person who holds sign.reveal-sensitive the values, oldest event first, and only this document's", async () => {
    h.caller = { userId: BOSS, accountId: ACCT, capabilities: new Set(["menu.sign", "sign.reveal-sensitive"]) };
    const body = (await (await call()).json()) as { mayReveal: boolean; changes: { seq: number; field: string; old: string; new: string; masked: boolean }[] };
    expect(body.mayReveal).toBe(true);
    expect(body.changes).toEqual([
      { seq: 7, field: "email", old: "ali@old.example", new: "ali@new.example", masked: false },
      { seq: 8, field: "custom:Region", old: "", new: "Selangor", masked: false },
      { seq: 9, field: "company", old: "Kedai Runcit Ali", new: "Kedai Runcit Ali Sdn Bhd", masked: false },
    ]);
  });

  it("does not let a long or short value change the mask", async () => {
    db.seed("sign_events", [{ account_id: ACCT, document_id: DOC, doc_seq: 10, type: "writeback", detail: { field: "name", old: "Al", new: "A very long name that would show its last four characters" } }]);
    const body = (await (await call()).json()) as { changes: { seq: number; old: string; new: string }[] };
    expect(body.changes.find((c) => c.seq === 10)).toMatchObject({ old: "••••", new: "••••" });
  });

  it("refuses without the menu, and treats a private document its reader may not see as not found", async () => {
    h.denied = true;
    expect((await call()).status).toBe(403);
    h.denied = false;
    expect((await call(PRIVATE_DOC)).status).toBe(404);
    expect((await call("not-a-uuid")).status).toBe(404);
  });
});
