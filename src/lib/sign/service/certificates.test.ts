// The sealing certificate as a workspace manages it: installing one from an authority (every way the file can be unfit
// is refused with its own code and nothing is stored), what sealing does with an uploaded certificate that has
// expired (it stops, loudly, and the document waits; it never falls back to a self-signed one), the certificate Halo
// makes for itself, and the whole sealing of a document with a chain.

import { beforeEach, describe, expect, it } from "vitest";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import type { NotifyDeps } from "../notify";
import { chain, issue, p12Of, certOnlyP12, rsaKey } from "../pdf/cert-fixtures";
import { A4, makePdf } from "../pdf/fixtures";
import { readP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import { verifySealed } from "../pdf/verify";
import type { SignRole } from "../types";
import { CERTIFICATE_HOLD_CODES, MAX_CERTIFICATE_BYTES, describeSealingCertificate, installCertificate, removeCertificate, sealingCertificate } from "./certificates";
import type { SignCtx } from "./context";
import { createDraftFromUpload, setSigners, updateDraft } from "./drafts";
import { SignError } from "./errors";
import { FakeDb } from "./fake-db";
import { runSealing } from "./seal";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const PASS = "correct horse";
const DAY = 24 * 3600 * 1000;
// the fixture certificates are issued relative to the real clock (two days back), so "now" follows it too
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);

function setup() {
  const db = new FakeDb();
  const mail: { to: string }[] = [];
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => NOW };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  // what migration 165's sign_install_certificate does, in one place
  db.rpcHandlers.sign_install_certificate = async (a) => {
    const rows = db.rows("sign_certificates");
    for (const r of rows) if (r.account_id === a.p_account && r.is_default) r.is_default = false;
    const id = `cert-${rows.length + 1}`;
    db.seed("sign_certificates", [{ id, account_id: a.p_account, name: a.p_name, subject: a.p_subject, valid_until: a.p_valid_until, p12_enc: a.p_p12_enc, passphrase_enc: a.p_passphrase_enc, is_default: true, created_by: a.p_user, source: "uploaded" }]);
    const settings = db.rows("sign_settings").find((s) => s.account_id === a.p_account);
    if (settings) settings.certificate_id = id;
    return { data: id, error: null };
  };
  return { db, ctx, mail };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  t = setup();
});

const stored = () => t.db.rows("sign_certificates");
const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  return e instanceof SignError ? { code: e.code, status: e.status } : e;
};

describe("installing a certificate", () => {
  const c = chain();

  it("keeps a good file under its own passphrase, with the whole chain, makes it the workspace's certificate and describes it", async () => {
    const file = p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert, c.root.cert], PASS);
    const view = await installCertificate(t.ctx, { bytes: file, passphrase: PASS });
    expect(view).toMatchObject({ uploaded: true, selfSigned: false, chainLength: 3, keyBits: 2048, readable: true, warnings: [] });
    expect(view.issuer).toContain("Test Issuing CA");
    expect(view.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(view.name).toBe("Uploaded: Kedai Runcit Ali Sdn Bhd");

    expect(stored()).toHaveLength(1);
    const row = stored()[0];
    expect(row).toMatchObject({ is_default: true, source: "uploaded", created_by: USER });
    expect(t.db.rows("sign_settings")[0].certificate_id).toBe(row.id);
    // what is stored is a copy that opens with a passphrase made here, not the one the person typed
    const keptPass = decrypt(String(row.passphrase_enc));
    expect(keptPass).not.toBe(PASS);
    const keptFile = new Uint8Array(Buffer.from(decrypt(String(row.p12_enc)), "base64"));
    expect(readP12(keptFile, keptPass).chainLength).toBe(3);
    expect(() => readP12(keptFile, PASS)).toThrow();
    // nothing the screen reads can carry the key or the file
    expect(JSON.stringify(view)).not.toContain(String(row.p12_enc));
  });

  it("refuses each kind of unfit file with its own code, and stores nothing", async () => {
    const weak = issue({ commonName: "Small Key", bits: 1024, slot: "svc-small", issuer: c.intermediate });
    const old = issue({ commonName: "Old", slot: "svc-old", issuer: c.intermediate, notBefore: new Date(NOW.getTime() - 400 * DAY), notAfter: new Date(NOW.getTime() - 35 * DAY) });
    const future = issue({ commonName: "Future", slot: "svc-future", issuer: c.intermediate, notBefore: new Date(NOW.getTime() + 10 * DAY), notAfter: new Date(NOW.getTime() + 375 * DAY) });
    const tls = issue({ commonName: "Encipher", slot: "svc-ku", issuer: c.intermediate, keyUsage: { keyEncipherment: true } });
    const stranger = rsaKey(2048, "svc-stranger").privateKey;
    const impostor = issue({ commonName: "Impostor CA", ca: true, slot: "svc-imp" });
    const forged = issue({ commonName: "Forged", slot: "svc-forged", issuer: { cert: c.intermediate.cert, key: impostor.key } });
    const cases: [string, Uint8Array, string][] = [
      ["no key", certOnlyP12([c.leaf.cert], PASS), "p12_no_key"],
      ["not a certificate file", new Uint8Array([1, 2, 3, 4]), "p12_unreadable"],
      ["key too small", p12Of(weak.key, [weak.cert], PASS), "p12_key_too_small"],
      ["expired", p12Of(old.key, [old.cert], PASS), "p12_expired"],
      ["not yet valid", p12Of(future.key, [future.cert], PASS), "p12_not_yet_valid"],
      ["key usage", p12Of(tls.key, [tls.cert], PASS), "p12_key_usage"],
      ["key of another certificate", p12Of(stranger, [c.leaf.cert], PASS), "p12_key_mismatch"],
      ["broken chain", p12Of(forged.key, [forged.cert, c.intermediate.cert], PASS), "p12_chain_invalid"],
    ];
    for (const [label, file, code] of cases) expect(await codeOf(installCertificate(t.ctx, { bytes: file, passphrase: PASS })), label).toEqual({ code, status: 422 });
    expect(await codeOf(installCertificate(t.ctx, { bytes: p12Of(c.leaf.key, [c.leaf.cert], PASS), passphrase: "nope" }))).toEqual({ code: "p12_bad_passphrase", status: 422 });
    expect(await codeOf(installCertificate(t.ctx, { bytes: new Uint8Array(0), passphrase: PASS }))).toEqual({ code: "p12_unreadable", status: 422 });
    expect(await codeOf(installCertificate(t.ctx, { bytes: new Uint8Array(MAX_CERTIFICATE_BYTES + 1), passphrase: PASS }))).toEqual({ code: "certificate_file_too_large", status: 413 });
    expect(stored()).toHaveLength(0);
    expect(t.db.rpcCalls.some((x) => x.name === "sign_install_certificate")).toBe(false);
  });

  it("warns about what is questionable without refusing it", async () => {
    const view = await installCertificate(t.ctx, { bytes: p12Of(c.leaf.key, [c.leaf.cert], PASS), passphrase: PASS });
    expect(view.warnings).toEqual(["chain_missing"]);
    expect(stored()).toHaveLength(1);
  });

  it("does not let a name pass an uploaded certificate off as one Halo made", async () => {
    const view = await installCertificate(t.ctx, { bytes: p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert], PASS), passphrase: PASS, name: "Halo self-signed (trust me)" });
    expect(view.name.startsWith("Halo self-signed")).toBe(false);
    expect(view.uploaded).toBe(true);
  });

  it("makes a second certificate the default and keeps the first on file", async () => {
    await installCertificate(t.ctx, { bytes: p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert], PASS), passphrase: PASS });
    const other = issue({ commonName: "Renewed", slot: "svc-renewed", issuer: c.intermediate });
    await installCertificate(t.ctx, { bytes: p12Of(other.key, [other.cert, c.intermediate.cert], PASS), passphrase: PASS });
    expect(stored()).toHaveLength(2);
    expect(stored().filter((r) => r.is_default)).toHaveLength(1);
    const view = await describeSealingCertificate(t.ctx);
    expect(view?.subject).toContain("Renewed");
  });
});

describe("what sealing does with the certificate", () => {
  const c = chain();

  async function installAs(file: Uint8Array, overrides: Record<string, unknown> = {}) {
    // put the certificate straight on file (an expired one cannot be installed through the screen)
    const id = `row-${stored().length + 1}`;
    t.db.seed("sign_certificates", [{ id, account_id: ACCT, name: "Uploaded: test", p12_enc: encrypt(Buffer.from(file).toString("base64")), passphrase_enc: encrypt(PASS), valid_until: null, is_default: true, source: "uploaded", ...overrides }]);
    return id;
  }

  it("uses the uploaded certificate while it is valid", async () => {
    await installAs(p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert], PASS));
    const cert = await sealingCertificate(t.ctx);
    expect(cert.generated).toBe(false);
    expect(cert.facts.chainLength).toBe(2);
    expect(stored()).toHaveLength(1);
  });

  it("stops with a clear reason when the uploaded certificate has expired, and never falls back to a self-signed one", async () => {
    const old = issue({ commonName: "Kedai Lama", slot: "seal-old", issuer: c.intermediate, notBefore: new Date(NOW.getTime() - 400 * DAY), notAfter: new Date(NOW.getTime() - 3 * DAY) });
    await installAs(p12Of(old.key, [old.cert, c.intermediate.cert], PASS));
    const err = await sealingCertificate(t.ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SignError);
    expect(err.code).toBe("certificate_expired");
    expect(err.message).toContain(new Date(NOW.getTime() - 3 * DAY).toISOString().slice(0, 10));
    expect(err.message).toContain("Settings > Secure Sign > Sealing certificate");
    expect(CERTIFICATE_HOLD_CODES.has(err.code)).toBe(true);
    // no certificate was made behind the owner's back
    expect(stored()).toHaveLength(1);
  });

  it("says so when the uploaded certificate is not valid yet, or cannot be opened", async () => {
    const future = issue({ commonName: "Kedai Baru", slot: "seal-future", issuer: c.intermediate, notBefore: new Date(NOW.getTime() + 5 * DAY), notAfter: new Date(NOW.getTime() + 370 * DAY) });
    await installAs(p12Of(future.key, [future.cert], PASS));
    expect(await codeOf(sealingCertificate(t.ctx))).toMatchObject({ code: "certificate_not_valid_yet" });
    t.db.tables.sign_certificates = [];
    await installAs(new Uint8Array([9, 9, 9]));
    expect(await codeOf(sealingCertificate(t.ctx))).toMatchObject({ code: "certificate_unreadable" });
  });

  it("makes a self-signed certificate for a workspace that has none, and keeps it", async () => {
    // the certificate Halo makes starts at the real clock, so this one runs on it
    t.ctx.now = () => new Date();
    const cert = await sealingCertificate(t.ctx);
    expect(cert.generated).toBe(true);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ source: "generated", is_default: true });
    expect(String(stored()[0].name)).toMatch(/^Halo self-signed/);
    expect(t.db.rows("sign_settings")[0].certificate_id).toBe(stored()[0].id);
    // the next seal uses it rather than making another
    await sealingCertificate(t.ctx);
    expect(stored()).toHaveLength(1);
  });

  it("renews an expired self-signed certificate of its own making, one default at a time", async () => {
    t.ctx.now = () => new Date();
    await sealingCertificate(t.ctx);
    const first = stored()[0];
    t.ctx.now = () => new Date(Date.now() + 6 * 365 * DAY);
    const again = await sealingCertificate(t.ctx);
    expect(again.generated).toBe(true);
    expect(stored()).toHaveLength(2);
    expect(stored().filter((r) => r.is_default)).toHaveLength(1);
    expect(first.is_default).toBe(false);
    expect(t.db.rows("sign_settings")[0].certificate_id).toBe(stored().find((r) => r.is_default)!.id);
  });

  it("recognises a row made before the source column existed by its name", async () => {
    t.db.seed("sign_certificates", [{ id: "old1", account_id: ACCT, name: "Halo self-signed (not trusted by PDF readers)", p12_enc: "x", passphrase_enc: "y", is_default: true }]);
    const view = await describeSealingCertificate(t.ctx);
    expect(view).toMatchObject({ uploaded: false, readable: false, selfSigned: true });
  });
});

describe("removing a certificate", () => {
  it("deletes an uploaded one, never one of another workspace or one Halo made", async () => {
    t.db.seed("sign_certificates", [
      { id: "mine", account_id: ACCT, name: "Uploaded: a", p12_enc: "x", passphrase_enc: "y", is_default: true, source: "uploaded" },
      { id: "theirs", account_id: "someone-else", name: "Uploaded: b", p12_enc: "x", passphrase_enc: "y", is_default: true, source: "uploaded" },
      { id: "halo", account_id: ACCT, name: "Halo self-signed", p12_enc: "x", passphrase_enc: "y", is_default: false, source: "generated" },
    ]);
    expect(await codeOf(removeCertificate(t.ctx, "theirs"))).toMatchObject({ code: "certificate_not_found", status: 404 });
    expect(await codeOf(removeCertificate(t.ctx, "halo"))).toMatchObject({ code: "certificate_not_found" });
    await removeCertificate(t.ctx, "mine");
    expect(stored().map((r) => r.id).sort()).toEqual(["halo", "theirs"]);
  });
});

// ---- sealing a whole document --------------------------------------------------------------------------------

const roles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];
const fields: PlacedField[] = [
  { key: "mname", type: "name", role: "merchant", page: 0, x: 0.1, y: 0.3, w: 0.5, h: 0.04, required: true },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
];

async function documentReadyToSeal() {
  const pdf = await makePdf([{ ...A4 }]);
  const { document } = await createDraftFromUpload(t.ctx, { bytes: pdf, filename: "Merchant Application.pdf", title: "Merchant Application: Kedai Runcit" });
  await updateDraft(t.ctx, document.id, { roles, fields, mergeValues: {} });
  const [m] = await setSigners(t.ctx, document.id, [{ roleKey: "merchant", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedairuncit.example", channel: "email", orderNo: 1 }]);
  Object.assign(t.db.rows("sign_documents")[0], { status: "sealing", reference: "SGN-2026-000123", sent_at: "2026-10-06T02:00:00Z", base_sha256: "f".repeat(64) });
  Object.assign(t.db.rows("sign_signers").find((s) => s.id === m.id)!, { status: "signed", signed_at: "2026-10-06T06:03:00Z", ip: "203.0.113.9", device: "Chrome" });
  t.db.seed("sign_answers", [{ account_id: ACCT, document_id: document.id, signer_id: m.id, field_key: "msig", value: { typed: "Ali" } }]);
  t.db.seed("sign_events", [{ account_id: ACCT, document_id: document.id, doc_seq: 1, type: "sent", signer_id: null, row_hash: "1".repeat(64), detail: {}, created_at: "2026-10-06T02:00:00Z" }]);
  t.db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: document.id, account_id: ACCT }], error: null });
  t.db.rpcHandlers.sign_finish_sealing = async (a) => {
    Object.assign(t.db.rows("sign_documents")[0], { status: "completed", final_path: a.p_final_path, final_sha256: a.p_final_sha256 });
    return { data: {}, error: null };
  };
  t.db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });
  t.db.rpcHandlers.sign_hold_sealing = async () => ({ data: null, error: null });
  return document;
}

const runOnce = () => runSealing({ admin: t.ctx.admin, origin: t.ctx.origin, deps: t.ctx.deps, now: t.ctx.now }, 2);

describe("sealing a document", () => {
  const c = chain();

  it("seals with the authority's certificate and carries the chain in the signature", async () => {
    await documentReadyToSeal();
    t.db.seed("sign_certificates", [{ id: "ca1", account_id: ACCT, name: "Uploaded: Kedai", p12_enc: encrypt(Buffer.from(p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert, c.root.cert], PASS)).toString("base64")), passphrase_enc: encrypt(PASS), valid_until: null, is_default: true, source: "uploaded" }]);
    expect(await runOnce()).toEqual({ claimed: 1, completed: 1, retry: 0 });
    const fin = t.db.rpcCalls.find((x) => x.name === "sign_finish_sealing")!;
    const v = verifySealed(t.db.files.get(String(fin.args.p_final_path))!);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.certificateCount).toBe(3);
    expect(v.signer?.selfSigned).toBe(false);
    expect(v.signer?.issuer).toContain("Test Issuing CA");
  });

  it("holds a document, with a readable reason and no attempt used, when the uploaded certificate has expired", async () => {
    const doc = await documentReadyToSeal();
    const old = issue({ commonName: "Kedai Lama", slot: "seal2-old", issuer: c.intermediate, notBefore: new Date(NOW.getTime() - 400 * DAY), notAfter: new Date(NOW.getTime() - 3 * DAY) });
    t.db.seed("sign_certificates", [{ id: "ca2", account_id: ACCT, name: "Uploaded: Kedai", p12_enc: encrypt(Buffer.from(p12Of(old.key, [old.cert, c.intermediate.cert], PASS)).toString("base64")), passphrase_enc: encrypt(PASS), valid_until: null, is_default: true, source: "uploaded" }]);
    expect(await runOnce()).toMatchObject({ claimed: 1, completed: 0, retry: 1 });
    const hold = t.db.rpcCalls.filter((x) => x.name === "sign_hold_sealing");
    expect(hold).toHaveLength(1);
    expect(hold[0].args.p_document).toBe(doc.id);
    expect(String(hold[0].args.p_error)).toContain(`expired on ${new Date(NOW.getTime() - 3 * DAY).toISOString().slice(0, 10)}`);
    // it is not the failure path (which counts attempts), and nothing half-made is left behind
    expect(t.db.rpcCalls.some((x) => x.name === "sign_fail_sealing")).toBe(false);
    expect(t.db.rpcCalls.some((x) => x.name === "sign_finish_sealing")).toBe(false);
    expect([...t.db.files.keys()].some((p) => p.includes("/final/"))).toBe(false);
    expect(t.db.rows("sign_certificates")).toHaveLength(1);
    // a certificate installed afterwards seals it on the next run
    const fresh = chain();
    await installCertificate(t.ctx, { bytes: p12Of(fresh.leaf.key, [fresh.leaf.cert, fresh.intermediate.cert], PASS), passphrase: PASS });
    expect(await runOnce()).toEqual({ claimed: 1, completed: 1, retry: 0 });
  });

  it("still uses the ordinary failure path for a fault that is not the certificate's", async () => {
    await documentReadyToSeal();
    t.db.files.set(t.db.rows("sign_documents")[0].base_path as string, new TextEncoder().encode("not a pdf"));
    expect(await runOnce()).toMatchObject({ claimed: 1, completed: 0, retry: 1 });
    expect(t.db.rpcCalls.some((x) => x.name === "sign_fail_sealing")).toBe(true);
    expect(t.db.rpcCalls.some((x) => x.name === "sign_hold_sealing")).toBe(false);
  });
});
