import { beforeEach, describe, expect, it } from "vitest";

import { FakeDb } from "./fake-db";
import { isDocumentId, loadVerification } from "./verify";

const ACCT = "11111111-1111-4111-8111-111111111111";
const DOC = "33333333-3333-4333-8333-333333333333";
const SHA = "ab".repeat(32);

let db: FakeDb;

/** FakeDb.seed adds rows; a test that changes a row replaces the table's rows instead. */
const replace = (table: string, rows: Record<string, unknown>[]) => {
  db.tables[table] = [];
  db.seed(table, rows);
};

const doc = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  account_id: ACCT,
  title: "Merchant Application: Kedai Runcit",
  reference: "MA-0001",
  status: "completed",
  completed_at: "2026-10-06T08:30:00Z",
  page_count: 4,
  final_sha256: SHA,
  ...over,
});

const signer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  account_id: ACCT,
  document_id: DOC,
  role_key: "merchant",
  kind: "signer",
  full_name: "Ali bin Ahmad",
  email: "ali@kedairuncit.example",
  phone: "+60123456789",
  status: "signed",
  order_no: 1,
  signed_at: "2026-10-06T08:20:00Z",
  ip: "203.0.113.9",
  device: "Mozilla/5.0",
  created_at: "2026-10-06T08:00:00Z",
  ...over,
});

beforeEach(() => {
  db = new FakeDb();
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: "Vircle", timezone: "Asia/Kuala_Lumpur", brand_logo_url: "https://cdn.example/logo.png" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("sign_documents", [doc()]);
  db.seed("sign_signers", [
    signer("s2", { full_name: "Siti Director", role_key: "director", order_no: 2, signed_at: "2026-10-06T08:25:00Z" }),
    signer("s1"),
    signer("s3", { full_name: "Counter Filler", kind: "filler", status: "signed" }),
    signer("s4", { full_name: "Never Signed", status: "sent", signed_at: null }),
  ]);
  db.rpcHandlers.sign_verify_chain = async () => ({ data: { ok: true, events: 14, head: "x" }, error: null });
});

describe("document id", () => {
  it("accepts only a UUID", () => {
    expect(isDocumentId(DOC)).toBe(true);
    expect(isDocumentId("abc123")).toBe(false);
    expect(isDocumentId(`${DOC}x`)).toBe(false);
    expect(isDocumentId(undefined)).toBe(false);
    expect(isDocumentId("' or 1=1 --")).toBe(false);
  });
});

describe("loadVerification", () => {
  it("shows a completed document", async () => {
    const v = await loadVerification(db.client(), DOC);
    expect(v).toMatchObject({
      title: "Merchant Application: Kedai Runcit",
      reference: "MA-0001",
      pageCount: 4,
      completedAt: "2026-10-06T08:30:00Z",
      workspace: { name: "Vircle", logoUrl: "https://cdn.example/logo.png" },
      sha256: SHA,
      chain: "intact",
      events: 14,
    });
    expect(db.rpcCalls.find((c) => c.name === "sign_verify_chain")?.args).toEqual({ p_document: DOC });
  });

  it("lists who signed, earliest first, with a name and a time only", async () => {
    const v = await loadVerification(db.client(), DOC);
    expect(v?.signers).toEqual([
      { name: "Ali bin Ahmad", signedAt: "2026-10-06T08:20:00Z" },
      { name: "Siti Director", signedAt: "2026-10-06T08:25:00Z" },
    ]);
    // nothing about the people beyond that reaches the page
    const text = JSON.stringify(v);
    expect(text).not.toContain("kedairuncit.example");
    expect(text).not.toContain("+6012");
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("Mozilla");
    expect(text).not.toContain("Counter Filler");
    expect(text).not.toContain("Never Signed");
  });

  it("says nothing for a document that is not completed", async () => {
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) {
      replace("sign_documents", [doc({ status })]);
      expect(await loadVerification(db.client(), DOC), status).toBeNull();
    }
  });

  it("says nothing for a document with no sealed file", async () => {
    replace("sign_documents", [doc({ final_sha256: null })]);
    expect(await loadVerification(db.client(), DOC)).toBeNull();
  });

  it("says nothing for an unknown document or a malformed id", async () => {
    expect(await loadVerification(db.client(), "44444444-4444-4444-8444-444444444444")).toBeNull();
    expect(await loadVerification(db.client(), "not-an-id")).toBeNull();
  });

  it("says nothing when the workspace has Doc Sign off or is suspended", async () => {
    replace("account_platform", [{ account_id: ACCT, status: "active", features: { sign: false }, limits: {} }]);
    expect(await loadVerification(db.client(), DOC)).toBeNull();
    replace("account_platform", [{ account_id: ACCT, status: "suspended", features: { sign: true }, limits: {} }]);
    expect(await loadVerification(db.client(), DOC)).toBeNull();
  });

  it("reports a broken audit chain", async () => {
    db.rpcHandlers.sign_verify_chain = async () => ({ data: { ok: false, events: 9, broken_at: 5 }, error: null });
    const v = await loadVerification(db.client(), DOC);
    expect(v?.chain).toBe("broken");
  });

  it("reports an unchecked chain when the check cannot run, and still shows the rest", async () => {
    db.rpcHandlers.sign_verify_chain = async () => ({ data: null, error: { message: "boom" } });
    const v = await loadVerification(db.client(), DOC);
    expect(v?.chain).toBe("unknown");
    expect(v?.events).toBeNull();
    expect(v?.sha256).toBe(SHA);
  });

  it("falls back to the account name when the workspace has no brand name or a non-https logo", async () => {
    replace("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "UTC", brand_logo_url: "http://insecure.example/l.png" }]);
    const v = await loadVerification(db.client(), DOC);
    expect(v?.workspace).toEqual({ name: "Vircle Sdn Bhd", logoUrl: null });
  });
});
