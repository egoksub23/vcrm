import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/csv";
import { ENCRYPTED_COLUMNS, reencryptAll } from "@/lib/crypto/reencrypt";
import { keyIdOf } from "@/lib/whatsapp/encryption";

import { documentsCsvStream } from "./export";
import { EXPORT_HEADER, type ExportFilters } from "../export/documents";
import type { SignCtx } from "./context";
import { FakeDb } from "./fake-db";
import { ANSWER_COLUMNS, openAnswer, openRows, sealAnswer, type StoredRow } from "./sensitive";

const DOC = "d0000000-0000-4000-8000-000000000001";
const ORIGINAL = "ab".repeat(32);
const K1 = "1".repeat(64);
const saved = { ...process.env };

function setEnv(env: Record<string, string | undefined>) {
  for (const k of ["ENCRYPTION_KEY", "ENCRYPTION_KEYS", "ENCRYPTION_KEY_ID"]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
}

beforeEach(() => setEnv({ ENCRYPTION_KEY: ORIGINAL }));
afterEach(() => setEnv({ ENCRYPTION_KEY: saved.ENCRYPTION_KEY, ENCRYPTION_KEYS: saved.ENCRYPTION_KEYS, ENCRYPTION_KEY_ID: saved.ENCRYPTION_KEY_ID }));

const where = (fieldKey: string) => ({ documentId: DOC, fieldKey });
const stored = (key: string, sealed: ReturnType<typeof sealAnswer>, signer = "s1"): StoredRow => ({ signer_id: signer, field_key: key, value: sealed.value, value_enc: sealed.value_enc });

describe("sealing and opening an answer", () => {
  it("round-trips text and a list, and returns no plain value in what is stored", () => {
    for (const value of [{ text: "900101-01-1234" }, { list: ["123456789", "987654321"] }, { text: "Zürich 北京 한국" }]) {
      const sealed = sealAnswer({ sensitive: true }, value, where("ic"));
      expect(sealed).toMatchObject({ value: null, sensitive: true });
      expect(typeof sealed.value_enc).toBe("string");
      expect(JSON.stringify(sealed)).not.toMatch(/900101|123456789|Zürich/);
      expect(openAnswer(stored("ic", sealed), DOC)).toEqual(value);
    }
  });

  it("passes an ordinary answer through, and never gives a placed field ciphertext", () => {
    expect(sealAnswer({}, { text: "Kedai" }, where("name"))).toEqual({ value: { text: "Kedai" }, value_enc: null, sensitive: false });
    expect(sealAnswer(undefined, { typed: "Ali" }, where("sig"))).toEqual({ value: { typed: "Ali" }, value_enc: null, sensitive: false });
    expect(sealAnswer({ sensitive: false }, { text: "x" }, where("x")).value_enc).toBeNull();
    expect(openAnswer({ field_key: "name", value: { text: "Kedai" } }, DOC)).toEqual({ text: "Kedai" });
  });

  it("makes each ciphertext different, and binds it to its document and field", () => {
    const a = sealAnswer({ sensitive: true }, { text: "same" }, where("ic"));
    const b = sealAnswer({ sensitive: true }, { text: "same" }, where("ic"));
    expect(a.value_enc).not.toBe(b.value_enc);
    // read as another field, or in another document
    expect(() => openAnswer({ field_key: "other", value: null, value_enc: a.value_enc }, DOC)).toThrow(/could not be read/);
    expect(() => openAnswer({ field_key: "ic", value: null, value_enc: a.value_enc }, "d0000000-0000-4000-8000-000000000002")).toThrow(/could not be read/);
  });

  it("fails with a stable code and no value when the ciphertext cannot be read", () => {
    const a = sealAnswer({ sensitive: true }, { text: "SECRET-VALUE" }, where("ic"));
    setEnv({ ENCRYPTION_KEY: "2".repeat(64) }); // another key entirely
    try {
      openAnswer(stored("ic", a), DOC);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: "sensitive_unreadable", status: 500 });
      expect(String((err as Error).message)).not.toContain("SECRET");
    }
    expect(() => openAnswer({ field_key: "ic", value: null, value_enc: "not-ciphertext" }, DOC)).toThrow();
  });

  it("saves nothing in the clear when there is no key, and an ordinary answer is not affected", () => {
    setEnv({});
    expect(() => sealAnswer({ sensitive: true }, { text: "SECRET-VALUE" }, where("ic"))).toThrow(expect.objectContaining({ code: "sensitive_unavailable", status: 503 }));
    expect(sealAnswer({}, { text: "Kedai" }, where("name")).value).toEqual({ text: "Kedai" });
  });

  it("opens a set of rows, leaving a row without ciphertext as it was", () => {
    const rows: StoredRow[] = [
      stored("ic", sealAnswer({ sensitive: true }, { text: "900101-01-1234" }, where("ic"))),
      { signer_id: "s1", field_key: "name", value: { text: "Ali" }, source: "signer", saved_at: "2026-10-06T08:00:00Z" },
    ];
    expect(openRows(rows, DOC)).toEqual([
      { signer_id: "s1", field_key: "ic", value: { text: "900101-01-1234" }, source: undefined, saved_at: undefined },
      { signer_id: "s1", field_key: "name", value: { text: "Ali" }, source: "signer", saved_at: "2026-10-06T08:00:00Z" },
    ]);
  });
});

describe("key rotation", () => {
  it("lists the column, so the re-encrypt job and the key report cover it", () => {
    expect(ENCRYPTED_COLUMNS).toContainEqual({ table: "sign_answers", pk: "id", columns: ["value_enc"] });
  });

  it("re-encrypts a sensitive answer under the new key, and it still opens; rows without ciphertext are left alone", async () => {
    const db = new FakeDb();
    const sealed = sealAnswer({ sensitive: true }, { text: "900101-01-1234" }, where("ic"));
    db.seed("sign_answers", [
      { id: "a1", signer_id: "s1", field_key: "ic", value: null, value_enc: sealed.value_enc, sensitive: true },
      { id: "a2", signer_id: "s1", field_key: "name", value: { text: "Ali" }, value_enc: null, sensitive: false },
    ]);
    const before = db.rows("sign_answers")[0].value_enc as string;
    expect(keyIdOf(before)).toBe("legacy");
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: "2026a" });
    const result = await reencryptAll(db.client());
    expect(result).toMatchObject({ rewritten: 1, unreadable: 0, finished: true });
    const after = db.rows("sign_answers");
    expect(keyIdOf(after[0].value_enc as string)).toBe("2026a");
    expect(after[0].value_enc).not.toBe(before);
    expect(after[0].value).toBeNull();
    expect(after[1]).toMatchObject({ value: { text: "Ali" }, value_enc: null });
    // the answer reads the same under the new key, still bound to its document and field
    expect(openAnswer(after[0] as unknown as StoredRow, DOC)).toEqual({ text: "900101-01-1234" });
    // and, once the old key is retired, a value written before the rotation is the only thing that would not open
    setEnv({ ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: "2026a" });
    expect(openAnswer(after[0] as unknown as StoredRow, DOC)).toEqual({ text: "900101-01-1234" });
  });
});

// ---- every place that touches the table --------------------------------------------------------------------------------

const ROOT = process.cwd();

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full;
  }
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");

describe("every reader and writer of sign_answers goes through sensitive.ts", () => {
  /** The files that read or write the table. A new one fails this test until someone has decided how it treats a sensitive answer. */
  const KNOWN = new Set([
    "src/lib/sign/service/drafts.ts", // file paths only (deleting a draft's files)
    "src/lib/sign/service/form-state.ts", // the one reader: loadAnswerRows
    "src/lib/sign/service/seal.ts", // reads for the PDF, opens what it selected
    "src/lib/sign/service/signing.ts", // the write path of the signer's answers
    "src/lib/sign/service/uploads.ts", // file answers (never sensitive), through the same functions
    "src/lib/sign/service/writeback.ts", // prefill writes
  ]);
  const uses: { file: string; text: string }[] = [];
  for (const file of [...sourceFiles(path.join(ROOT, "src"))]) {
    const text = fs.readFileSync(file, "utf8");
    if (/\.from\(\s*["']sign_answers["']\s*\)/.test(text)) uses.push({ file: rel(file), text });
  }

  it("finds only the files it knows", () => {
    expect(uses.map((u) => u.file).sort()).toEqual([...KNOWN].sort());
  });

  it("selects the answer only with ANSWER_COLUMNS (so the ciphertext column comes with the value), or selects no value at all", () => {
    for (const { file, text } of uses) {
      for (const m of text.matchAll(/\.from\(\s*["']sign_answers["']\s*\)\s*\.select\(([^)]*)\)/g)) {
        const arg = m[1].trim();
        const ok = arg === "ANSWER_COLUMNS" || (!/value|\*/.test(arg) && /^["'][a-z_, ]+["']$/.test(arg));
        expect(ok, `${file}: .select(${arg})`).toBe(true);
      }
    }
    expect(ANSWER_COLUMNS.split(", ")).toEqual(expect.arrayContaining(["value", "value_enc"]));
  });

  it("writes only through sealAnswer", () => {
    for (const { file, text } of uses) {
      if (/\.from\(\s*["']sign_answers["']\s*\)\s*\.(upsert|insert)\(/.test(text)) expect(text.includes("sealAnswer("), `${file} writes answers`).toBe(true);
    }
  });

  it("opens what it reads: no reader hands a stored row's `value` on without openRows or openAnswer", () => {
    for (const file of ["src/lib/sign/service/form-state.ts", "src/lib/sign/service/seal.ts", "src/lib/sign/service/uploads.ts"]) {
      const text = uses.find((u) => u.file === file)!.text;
      expect(/openRows\(|openAnswer\(/.test(text), file).toBe(true);
    }
  });
});

describe("what leaves the building carries no answers", () => {
  const OUT: string[] = [
    "src/lib/sign/export",
    "src/lib/sign/service/export.ts",
    "src/lib/sign/service/api.ts",
    "src/lib/api/v1/sign.ts",
    "src/app/api/v1/sign",
    "src/app/api/sign/documents/export",
    "src/app/api/sign/documents/zip",
  ];
  const files = OUT.flatMap((p) => {
    const full = path.join(ROOT, p);
    return fs.statSync(full).isDirectory() ? [...sourceFiles(full)] : [full];
  });

  it("has files to look at", () => {
    expect(files.length).toBeGreaterThan(6);
  });

  it("never reads the answers table, the answer loaders or the ciphertext, and never shows a progress answer", () => {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const word of ["sign_answers", "value_enc", "ANSWER_COLUMNS", "loadAnswerRows", "loadFormState", "openAnswer", "openRows", "revealAnswer", "progress.answers", ".answers"]) {
        expect(text.includes(word), `${rel(file)} mentions ${word}`).toBe(false);
      }
    }
  });

  it("exports a list with no answer column, and none of a document's answers in its rows", async () => {
    expect(EXPORT_HEADER.filter((h) => /answer|value|form|sensitive/i.test(h))).toEqual([]);
    const db = new FakeDb();
    db.seed("sign_documents", [{ id: DOC, account_id: "acct-1", reference: "SGN-2026-000001", title: "Merchant form", status: "completed", category_id: null, created_at: "2026-10-01T01:00:00Z", sent_at: null, completed_at: null, expires_at: null }]);
    db.seed("sign_answers", [{ id: "a1", account_id: "acct-1", document_id: DOC, signer_id: "s1", field_key: "ic", value: null, value_enc: sealAnswer({ sensitive: true }, { text: "900101-01-1234" }, where("ic")).value_enc, sensitive: true }]);
    const ctx = { admin: db.client(), accountId: "acct-1", userId: "u1", origin: "https://halo.test", now: () => new Date("2026-10-06T08:00:00Z") } as unknown as SignCtx;
    const filters: ExportFilters = { group: "all", category: "all", search: "", from: null, to: null, contactId: null };
    const text = await new Response(documentsCsvStream(ctx, filters, { pageSize: 5 })).text();
    const table = parseCsv(text);
    expect(table[0]).toEqual([...EXPORT_HEADER]);
    expect(table).toHaveLength(2);
    expect(text).not.toMatch(/900101|value_enc|v2:/);
  });
});
