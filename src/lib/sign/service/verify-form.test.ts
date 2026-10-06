import { beforeEach, describe, expect, it } from "vitest";

import { FakeDb } from "./fake-db";
import { loadVerification, signedPeople } from "./verify";

// The public verify page for a form WITHOUT a signature (migration 169): the sealed file is a submission record, nobody is a signer, so
// the page lists everyone who submitted and says it is a form; an agreement's page is unchanged.

const ACCT = "11111111-1111-4111-8111-111111111111";
const DOC = "33333333-3333-4333-8333-333333333333";
const SHA = "ab".repeat(32);

let db: FakeDb;

const seed = (mode?: string) => {
  db = new FakeDb();
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: "Vircle", timezone: "Asia/Kuala_Lumpur", brand_logo_url: null }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("sign_documents", [{ id: DOC, account_id: ACCT, title: "E-invoice details", reference: "SGN-1", status: "completed", completed_at: "2026-10-06T08:30:00Z", page_count: 1, final_sha256: SHA, ...(mode ? { mode } : {}) }]);
  const person = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, account_id: ACCT, document_id: DOC, role_key: "applicant", kind: "filler", full_name: name, email: `${id}@x.example`, status: "signed", order_no: 1, signed_at: "2026-10-06T08:20:00Z", created_at: "2026-10-06T08:00:00Z", ...over });
  db.seed("sign_signers", [person("s1", "Ali bin Ahmad"), person("s2", "Siti Accounts", { signed_at: "2026-10-06T08:25:00Z" }), person("s3", "Not Yet", { status: "sent", signed_at: null })]);
  db.rpcHandlers.sign_verify_chain = async () => ({ data: { ok: true, events: 9, head: "x" }, error: null });
};

beforeEach(() => seed("form"));

describe("the verify page of a form without a signature", () => {
  it("lists everyone who submitted, earliest first, and says it is a form", async () => {
    const v = await loadVerification(db.client(), DOC);
    expect(v).toMatchObject({ mode: "form", title: "E-invoice details", sha256: SHA, chain: "intact" });
    expect(v?.signers).toEqual([
      { name: "Ali bin Ahmad", signedAt: "2026-10-06T08:20:00Z" },
      { name: "Siti Accounts", signedAt: "2026-10-06T08:25:00Z" },
    ]);
    // still only a name and a time
    expect(JSON.stringify(v)).not.toContain("x.example");
  });

  it("says nothing about a mode for an agreement, and still lists only its signers", async () => {
    seed();
    db.tables.sign_signers = [];
    db.seed("sign_signers", [{ id: "a", account_id: ACCT, document_id: DOC, role_key: "merchant", kind: "signer", full_name: "Ali", email: "a@x.example", status: "signed", order_no: 1, signed_at: "2026-10-06T08:20:00Z", created_at: "2026-10-06T08:00:00Z" }, { id: "b", account_id: ACCT, document_id: DOC, role_key: "finance", kind: "filler", full_name: "Filler", email: "b@x.example", status: "signed", order_no: 2, signed_at: "2026-10-06T08:21:00Z", created_at: "2026-10-06T08:00:00Z" }]);
    const v = await loadVerification(db.client(), DOC);
    expect(v).not.toHaveProperty("mode");
    expect(v?.signers.map((s) => s.name)).toEqual(["Ali"]);
  });

  it("filters people by mode", () => {
    const rows = [
      { kind: "filler", status: "signed", full_name: "F", signed_at: "2026-10-06T08:00:00Z" },
      { kind: "signer", status: "signed", full_name: "S", signed_at: "2026-10-06T09:00:00Z" },
      { kind: "signer", status: "declined", full_name: "D", signed_at: null },
    ] as never[];
    expect(signedPeople(rows).map((s) => s.name)).toEqual(["S"]);
    expect(signedPeople(rows, "sign").map((s) => s.name)).toEqual(["S"]);
    expect(signedPeople(rows, "form").map((s) => s.name)).toEqual(["F", "S"]);
  });
});
