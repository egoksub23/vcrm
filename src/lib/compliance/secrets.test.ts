import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENCRYPTED_COLUMNS, reencryptAll } from "@/lib/crypto/reencrypt";
import { FakeDb } from "@/lib/sign/service/fake-db";
import { keyIdOf } from "@/lib/whatsapp/encryption";

import { fromDatabase } from "./errors";
import { maskedFields, openSensitive, revealedFields, sealSensitive } from "./secrets";
import { CLOSURE_FIELDS, ACCOUNT_NUMBER, BANK_NAME } from "./test-support";
import type { FieldDef } from "./types";

const REQ = "r0000000-0000-4000-8000-000000000001";
const ORIGINAL = "ab".repeat(32);
const K1 = "1".repeat(64);
const saved = { ...process.env };
const fields = CLOSURE_FIELDS as unknown as FieldDef[];

function setEnv(env: Record<string, string | undefined>) {
  for (const k of ["ENCRYPTION_KEY", "ENCRYPTION_KEYS", "ENCRYPTION_KEY_ID"]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
}
beforeEach(() => {
  setEnv({ ENCRYPTION_KEY: ORIGINAL });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setEnv({ ENCRYPTION_KEY: saved.ENCRYPTION_KEY, ENCRYPTION_KEYS: saved.ENCRYPTION_KEYS, ENCRYPTION_KEY_ID: saved.ENCRYPTION_KEY_ID });
  vi.restoreAllMocks();
});

describe("sealSensitive / openSensitive", () => {
  it("round-trips the answers of a case, and the ciphertext holds none of them in the clear", () => {
    const enc = sealSensitive(REQ, { bank_name: BANK_NAME, bank_account_number: ACCOUNT_NUMBER })!;
    expect(enc).not.toContain(ACCOUNT_NUMBER);
    expect(enc).not.toContain("Maybank");
    expect(openSensitive(REQ, enc)).toEqual({ bank_name: BANK_NAME, bank_account_number: ACCOUNT_NUMBER });
  });

  it("stores nothing for an empty bag, and reads a missing column as an empty bag", () => {
    expect(sealSensitive(REQ, {})).toBeNull();
    expect(sealSensitive(REQ, { a: "" })).toBeNull();
    expect(openSensitive(REQ, null)).toEqual({});
    expect(openSensitive(REQ, "")).toEqual({});
  });

  it("refuses a ciphertext copied onto another case (the id is inside it)", () => {
    const enc = sealSensitive(REQ, { bank_account_number: ACCOUNT_NUMBER })!;
    expect(() => openSensitive("r0000000-0000-4000-8000-000000000002", enc)).toThrow(/could not be read/);
  });

  it("answers with a code and no value when the key is wrong or the text is damaged", () => {
    const enc = sealSensitive(REQ, { bank_account_number: ACCOUNT_NUMBER })!;
    setEnv({ ENCRYPTION_KEY: "cd".repeat(32) });
    let message = "";
    try {
      openSensitive(REQ, enc);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(ACCOUNT_NUMBER);
    expect(() => openSensitive(REQ, "garbage")).toThrow();
  });

  it("does not save in the clear when no key is configured", () => {
    setEnv({});
    expect(() => sealSensitive(REQ, { bank_account_number: ACCOUNT_NUMBER })).toThrow(/cannot be saved/);
  });
});

describe("masks and reveals", () => {
  it("masks every sensitive field of the type to its last four characters; ordinary fields are not in the list", () => {
    const masked = maskedFields(fields, { bank_name: BANK_NAME, bank_account_number: ACCOUNT_NUMBER });
    expect(masked.map((m) => m.key)).toEqual(["bank_name", "bank_account_number", "bank_account_holder"]);
    expect(masked.find((m) => m.key === "bank_account_number")).toMatchObject({ present: true, masked: "•••• 9012" });
    expect(masked.find((m) => m.key === "bank_account_holder")).toMatchObject({ present: false, masked: "" });
    expect(JSON.stringify(masked)).not.toContain(ACCOUNT_NUMBER);
  });

  it("a short value is masked completely (nothing of it is shown)", () => {
    expect(maskedFields(fields, { bank_name: "CIMB" }).find((m) => m.key === "bank_name")!.masked).toBe("••••");
  });

  it("reveals only the fields that have an answer, with their labels", () => {
    const r = revealedFields(fields, { bank_account_number: ACCOUNT_NUMBER, not_a_field: "x" });
    expect(r).toEqual([{ key: "bank_account_number", label: expect.objectContaining({ en: "Bank account number" }), value: ACCOUNT_NUMBER }]);
  });
});

describe("key rotation (the operator's re-encrypt job)", () => {
  it("lists the column the job must rewrite", () => {
    expect(ENCRYPTED_COLUMNS).toContainEqual({ table: "compliance_requests", pk: "id", columns: ["data_enc"] });
  });

  it("rewrites a case's ciphertext under the new key and it still opens for that case", async () => {
    const enc = sealSensitive(REQ, { bank_account_number: ACCOUNT_NUMBER })!;
    expect(keyIdOf(enc)).toBe("legacy");
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `k1:${K1}`, ENCRYPTION_KEY_ID: "k1" });
    const db = new FakeDb().seed("compliance_requests", [{ id: REQ, data_enc: enc }]);
    const result = await reencryptAll(db.client());
    expect(result).toMatchObject({ rewritten: 1, unreadable: 0 });
    const after = (db.rows("compliance_requests")[0] as { data_enc: string }).data_enc;
    expect(after).not.toBe(enc);
    expect(keyIdOf(after)).toBe("k1");
    expect(openSensitive(REQ, after)).toEqual({ bank_account_number: ACCOUNT_NUMBER });
  });
});

describe("errors from the database", () => {
  it("every compliance_* error the migration can raise is mapped to a code (none falls through to server_error)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "183_compliance_requests.sql"), "utf8");
    const raised = new Set([...sql.matchAll(/RAISE EXCEPTION '(compliance_[a-z_]+)/g)].map((m) => m[1]));
    expect(raised.size).toBeGreaterThan(25);
    // internal guards that no route can reach with a bad value of its own are mapped too, but these two are the only ones allowed to read as a plain refusal
    const unmapped = [...raised].filter((code) => fromDatabase({ message: code }).code === "server_error");
    expect(unmapped).toEqual([]);
  });

  it("reads the specific code first (a longer name is not shadowed by a shorter one)", () => {
    expect(fromDatabase({ message: "compliance_identity_not_passed" }).code).toBe("identity_not_passed");
    expect(fromDatabase({ message: "compliance_identity_method_other_required" }).code).toBe("identity_incomplete");
    expect(fromDatabase({ message: "compliance_not_allowed: approve" }).code).toBe("forbidden");
    expect(fromDatabase({ message: "compliance_not_paused" }).code).toBe("not_paused");
    expect(fromDatabase({ message: "compliance_request_not_found" }).code).toBe("not_found");
  });

  it("never carries the database's own words", () => {
    const e = fromDatabase({ message: 'duplicate key value violates unique constraint "compliance_requests_reference"', code: "23505" });
    expect(e.code).toBe("server_error");
    expect(e.message).not.toContain("constraint");
    expect(fromDatabase({ message: "permission denied for table x", code: "42501" }).code).toBe("forbidden");
    expect(fromDatabase(null).code).toBe("server_error");
  });
});
