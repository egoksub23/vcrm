// WP25, the security review of Doc Sign phases 2 and 3: the attacks that were tried and what stops each, as tests. Each one is an attacker's
// request, not a happy path. The fixes made in this review have their own tests next to the code they changed (registration.test.ts,
// countersign.test.ts); what is here is what had no home: forged people of an envelope, a link that serves a document of another envelope,
// hostile names in a zip, a spreadsheet formula that looks like a number, a route that forgets the envelope's code.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readJson, readUpload } from "../http";
import { csvCell } from "../lists/csv";
import { zipEntryName } from "../export/zip";
import { hashToken } from "../tokens";
import { FakeDb } from "./fake-db";
import { codeRequiredFor, lookupByToken, pickDocument } from "./signing";

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const TOKEN = "c".repeat(64);
const SECOND_TOKEN = "d".repeat(64);

function seedEnvelope(db: FakeDb) {
  const doc = (id: string, envelope: string | null, position: number | null, account = ACCT) => ({ id, account_id: account, title: `Doc ${id}`, status: "sent", envelope_id: envelope, envelope_position: position, code_required: false, created_by: null });
  db.seed("sign_envelopes", [
    { id: "E1", account_id: ACCT, title: "Pack", reference: "ENV-1", status: "sent" },
    { id: "E2", account_id: ACCT, title: "Someone else's pack", reference: "ENV-2", status: "sent" },
    { id: "E9", account_id: OTHER, title: "Another workspace", reference: "ENV-9", status: "sent" },
  ]);
  db.seed("sign_documents", [doc("D1", "E1", 1), doc("D2", "E1", 2), doc("D3", "E2", 1), doc("D4", "E9", 1, OTHER)]);
  const signer = (id: string, documentId: string, over: Record<string, unknown> = {}) => ({ id, account_id: ACCT, document_id: documentId, role_key: "merchant", kind: "signer", full_name: id, email: `${id}@example.com`, order_no: 1, status: "sent", party_id: "A", created_at: "2026-10-01T00:00:00Z", ...over });
  db.seed("sign_signers", [
    signer("A", "D1"), // the person's first document: the anchor, whose id is the party id
    signer("S2", "D2"), // the same person on the second document
    // rows somebody forged onto the person's party id: on a document of another envelope, and of another workspace
    signer("ROGUE-OTHER-ENVELOPE", "D3"),
    signer("ROGUE-OTHER-WORKSPACE", "D4", { account_id: OTHER }),
  ]);
  db.seed("sign_signer_secrets", [
    { signer_id: "A", account_id: ACCT, token_hash: hashToken(TOKEN), code_hash: null, code_expires_at: null, code_attempts: 0 },
    { signer_id: "S2", account_id: ACCT, token_hash: hashToken(SECOND_TOKEN), code_hash: null, code_expires_at: null, code_attempts: 0 },
  ]);
}

describe("an envelope's link and the people forged onto it", () => {
  it("serves only the person's own rows on documents of this envelope, whatever party id other rows carry", async () => {
    const db = new FakeDb();
    seedEnvelope(db);
    const found = await lookupByToken(db.client(), TOKEN);
    expect(found?.party?.members.map((m) => [m.signer.id, m.doc.id])).toEqual([["A", "D1"], ["S2", "D2"]]);
    // the documents of another envelope and of another workspace are not reachable through this link
    expect(pickDocument(found!, "D3")).toBeNull();
    expect(pickDocument(found!, "D4")).toBeNull();
    expect(pickDocument(found!, "D2")?.signer.id).toBe("S2");
  });

  it("is no link at all for a row that is not the person's anchor: a token made for it opens nothing", async () => {
    const db = new FakeDb();
    seedEnvelope(db);
    expect(await lookupByToken(db.client(), SECOND_TOKEN)).toBeNull();
  });

  it("is no link when the anchor's own party id names somebody else's row", async () => {
    const db = new FakeDb();
    seedEnvelope(db);
    db.tables.sign_signers = db.rows("sign_signers").map((s) => (s.id === "A" ? { ...s, party_id: "SOMEONE-ELSE" } : s));
    expect(await lookupByToken(db.client(), TOKEN)).toBeNull();
  });
});

describe("the code of an envelope", () => {
  const doc = (id: string, code: boolean) => ({ id, code_required: code }) as never;
  it("is asked for on every document of the person as soon as any document of the envelope asks for it", () => {
    const withoutCode = doc("D1", false);
    const lookup = { doc: withoutCode, party: { members: [{ doc: withoutCode }, { doc: doc("D2", true) }] } } as never;
    expect(codeRequiredFor(lookup)).toBe(true);
    expect(codeRequiredFor({ doc: withoutCode, party: null } as never)).toBe(false);
  });

  // The routes must ask the question about the whole link. A route that asks only about the document on the screen lets a document whose
  // own flag is off be read or changed with no code, while another document of the same envelope asks for one.
  it("is the question every public signer route asks, never the flag of the one document", () => {
    const root = join(process.cwd(), "src", "app", "api", "sign", "public");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === "route.ts") files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/lookup\.doc\.code_required/);
  });
});

describe("what a stranger's text can do to a zip", () => {
  const used = () => new Set<string>();
  const hostile = ["../../../etc/passwd", "..\\..\\Windows\\System32\\config", "C:\\Users\\boss\\secret", "/etc/shadow", "a/../../b", "CON", "name\u0000.pdf", "x\r\ny", "....//....//x", "   ", "..", ".", "\u202Efdp.exe", "a".repeat(5000)];
  it("never lets a title or a reference make a path: no separator, no parent, no drive, no control character, a bounded length", () => {
    for (const title of hostile) {
      for (const reference of [null, "SGN-2026-000001", title]) {
        const name = zipEntryName({ id: "0123456789abcdef", reference, title }, used());
        expect(name, `${title}|${reference}`).toMatch(/^[\w.\- ]+\.pdf$/);
        expect(name).not.toContain("..");
        expect(name).not.toMatch(/[\\/:\u0000-\u001f]/);
        expect(name.length).toBeLessThanOrEqual(110);
        expect(name.startsWith(".")).toBe(false);
      }
    }
  });

  it("keeps two documents with the same hostile title apart, so one cannot overwrite the other in the archive", () => {
    const names = used();
    const a = zipEntryName({ id: "aaaaaaaa11111111", reference: null, title: "../x" }, names);
    const b = zipEntryName({ id: "bbbbbbbb22222222", reference: null, title: "../x" }, names);
    expect(a).not.toBe(b);
  });
});

describe("a spreadsheet formula that starts like a number", () => {
  it("is made harmless in an exported option list, and a plain number is left alone", () => {
    for (const evil of ["-2+3+cmd|' /C calc'!A0", "+1+1", "=HYPERLINK(\"http://x\")", "@SUM(1)", "\t=1+1", "\r=1+1", "-1-1"]) {
      expect(csvCell(evil).replace(/^"/, "").startsWith("'"), evil).toBe(true);
    }
    for (const plain of ["-5", "+60", "3.14", "-0.5", "42"]) expect(csvCell(plain), plain).toBe(plain);
  });
});

describe("a body that is bigger than it says", () => {
  // The registration page has no login, so what it reads must be bounded by what arrives, not by what the request declares.
  const endless = () => {
    const piece = new TextEncoder().encode(`{"x":"${"a".repeat(4000)}"}`);
    return new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(piece) });
  };
  const chunked = (url: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", body: endless(), headers, duplex: "half" } as RequestInit);

  it("is refused with 413 once it passes the cap, for a JSON body sent with no length and for one that declares a small length", async () => {
    await expect(readJson(chunked("https://halo.test/api/sign/register/x"), 20_000)).rejects.toMatchObject({ status: 413, code: "body_too_large" });
    await expect(readJson(chunked("https://halo.test/api/sign/register/x", { "content-length": "100" }), 20_000)).rejects.toMatchObject({ status: 413 });
  });

  it("is refused with 413 for an upload sent with no length, and an ordinary small one still reads", async () => {
    await expect(readUpload(chunked("https://halo.test/api/sign/public/t/upload", { "content-type": "multipart/form-data; boundary=x" }), 50_000)).rejects.toMatchObject({ status: 413 });
    const form = new FormData();
    form.set("field", "id_card");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    const ok = await readUpload(new Request("https://halo.test/api/sign/public/t/upload", { method: "POST", body: form }), 50_000);
    expect(ok.fields).toEqual({ field: "id_card" });
    expect(ok.file?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(ok.file?.name).toBe("a.png");
  });

  it("still reads an ordinary JSON body, with characters that take more than one byte", async () => {
    const body = { name: "马来西亚 한국어 Ñandú" };
    expect(await readJson(new Request("https://halo.test/x", { method: "POST", body: JSON.stringify(body) }), 1000)).toEqual(body);
  });
});
