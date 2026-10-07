import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { NotifyDeps } from "../notify";
import { A4, makePdf, scribblePng } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import { hashToken } from "../tokens";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { FakeDb } from "./fake-db";
import { createDraftFromUpload, setSigners, updateDraft } from "./drafts";
import { runExpiry } from "./jobs";
import { runSealing } from "./seal";
import { sendDocument, voidDocument } from "./send";
import { declineSigning, lookupByToken, markViewed, type Lookup } from "./signing";

// The six places a Doc Sign state change is announced (sendDocument, markViewed, sealDocument, declineSigning,
// runExpiry, voidDocument): each makes exactly one call, after the change, and only for the right change. The
// engine and the webhook delivery are recorders; outbound.test.ts covers what the emitter does with the call.
const rec = vi.hoisted(() => ({ automations: vi.fn(), webhooks: vi.fn() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: (...a: unknown[]) => rec.automations(...a) }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: (...a: unknown[]) => rec.webhooks(...a) }));

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "biz", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.2, w: 0.5, h: 0.04, required: true },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

let db: FakeDb;
let ctx: SignCtx;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  db = new FakeDb();
  const deps: NotifyDeps = { emailConfigured: () => true, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "Vircle" }), sendWhatsApp: async () => {} };
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("automations", [{ id: "a1", account_id: ACCT, trigger_type: "sign_document_event", is_active: true }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  rec.automations.mockReset().mockResolvedValue(undefined);
  rec.webhooks.mockReset().mockResolvedValue(undefined);
});

const events = () => rec.webhooks.mock.calls.map((c) => c[2]);

async function draft() {
  const pdf = await makePdf([{ ...A4 }]);
  const { document } = await createDraftFromUpload(ctx, { bytes: pdf, filename: "Merchant Application.pdf", title: "Merchant Application: Kedai" });
  await updateDraft(ctx, document.id, { roles, fields });
  const rows = await setSigners(ctx, document.id, [
    { roleKey: "merchant", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email", orderNo: 1 },
    { roleKey: "director", kind: "signer", fullName: "Gokula", email: "g@vircle.example", channel: "email", orderNo: 2 },
  ]);
  return { document, rows };
}

/** A sent document with live links, for the signers' side. */
async function sent() {
  const { document, rows } = await draft();
  Object.assign(db.rows("sign_documents")[0], { status: "sent", expires_at: "2026-10-16T08:00:00Z", base_sha256: "f".repeat(64) });
  for (const s of db.rows("sign_signers")) Object.assign(s, { status: "sent", invited_at: "2026-10-06T08:00:00Z" });
  db.seed("sign_signer_secrets", [
    { signer_id: rows[0].id, account_id: ACCT, token_hash: hashToken(TOKEN_A), code_hash: null, code_expires_at: null, code_attempts: 0 },
    { signer_id: rows[1].id, account_id: ACCT, token_hash: hashToken(TOKEN_B), code_hash: null, code_expires_at: null, code_attempts: 0 },
  ]);
  return { document, rows };
}
const look = async (token: string): Promise<Lookup> => (await lookupByToken(ctx.admin, token))!;

describe("the hook points", () => {
  it("sendDocument announces `sent` after the database has moved the document", async () => {
    const { document, rows } = await draft();
    db.rpcHandlers.sign_send_document = async (args) => {
      Object.assign(db.rows("sign_documents")[0], { status: "sent", sent_at: "2026-10-06T08:00:00Z", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at });
      return { data: { reference: "SGN-2026-000001", invited: [{ signer_id: rows[0].id, token: TOKEN_A, name: "Ali bin Ahmad", email: "ali@kedai.example", phone: null, channel: "email", role_key: "merchant", kind: "signer", order_no: 1 }] }, error: null };
    };
    await sendDocument(ctx, document.id);
    expect(events()).toEqual(["sign.sent"]);
    expect(rec.webhooks.mock.calls[0][3]).toMatchObject({ document_id: document.id, status: "sent", title: "Merchant Application: Kedai" });
    expect(rec.automations.mock.calls[0][0]).toMatchObject({ triggerType: "sign_document_event", context: { sign: { event: "sent" } } });
  });

  it("a document that is refused is not announced", async () => {
    const pdf = await makePdf([{ ...A4 }]);
    const { document } = await createDraftFromUpload(ctx, { bytes: pdf, filename: "a.pdf" });
    await expect(sendDocument(ctx, document.id)).rejects.toMatchObject({ code: "not_ready" });
    expect(events()).toEqual([]);
  });

  it("markViewed announces `viewed` only the first time (the database answers true once)", async () => {
    await sent();
    let first = true;
    db.rpcHandlers.sign_mark_viewed = async () => {
      const answer = first;
      first = false;
      return { data: answer, error: null };
    };
    await markViewed(ctx, await look(TOKEN_A), "203.0.113.9", "Chrome");
    await markViewed(ctx, await look(TOKEN_A), "203.0.113.9", "Chrome");
    expect(events()).toEqual(["sign.viewed"]);
    expect(rec.webhooks.mock.calls[0][3].signer).toEqual({ name: "Ali bin Ahmad", role: "Merchant" });
  });

  it("markViewed on a document that is no longer open announces nothing", async () => {
    await sent();
    db.rows("sign_documents")[0].status = "completed";
    db.rpcHandlers.sign_mark_viewed = async () => ({ data: true, error: null });
    await markViewed(ctx, await look(TOKEN_A), null, null);
    expect(events()).toEqual([]);
  });

  it("declineSigning announces `declined` after the database accepted it, and not when it refused", async () => {
    await sent();
    db.rpcHandlers.sign_decline_signer = async () => ({ data: null, error: { message: "signer_not_open" } });
    await expect(declineSigning(ctx, await look(TOKEN_A), "Clause 4", { ip: null, device: null })).rejects.toMatchObject({ code: "signer_not_open" });
    expect(events()).toEqual([]);
    db.rpcHandlers.sign_decline_signer = async () => {
      Object.assign(db.rows("sign_documents")[0], { status: "declined" });
      Object.assign(db.rows("sign_signers")[0], { status: "declined" });
      return { data: {}, error: null };
    };
    await declineSigning(ctx, await look(TOKEN_A), "Clause 4", { ip: null, device: null });
    expect(events()).toEqual(["sign.declined"]);
    expect(rec.webhooks.mock.calls[0][3]).toMatchObject({ status: "declined", signer: { name: "Ali bin Ahmad", role: "Merchant" } });
    // the reason a signer typed is theirs and stays out
    expect(JSON.stringify(rec.webhooks.mock.calls[0][3])).not.toContain("Clause 4");
  });

  it("voidDocument announces `voided` for a document that was sent, not for a draft", async () => {
    await sent();
    db.rpcHandlers.sign_void_document = async () => {
      db.rows("sign_documents")[0].status = "voided";
      return { data: {}, error: null };
    };
    await voidDocument(ctx, db.rows("sign_documents")[0].id as string, "Wrong merchant");
    expect(events()).toEqual(["sign.voided"]);
    expect(rec.webhooks.mock.calls[0][3].status).toBe("voided");
    expect(JSON.stringify(rec.webhooks.mock.calls[0][3])).not.toContain("Wrong merchant");

    rec.webhooks.mockClear();
    const { document } = await draft();
    await voidDocument(ctx, document.id, null);
    expect(events()).toEqual([]);
  });

  it("runExpiry announces `expired` for each document the database expired", async () => {
    await sent();
    db.rpcHandlers.sign_expire_due = async () => {
      db.rows("sign_documents")[0].status = "expired";
      return { data: [{ document_id: db.rows("sign_documents")[0].id, account_id: ACCT }], error: null };
    };
    expect(await runExpiry({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now })).toEqual({ expired: 1 });
    expect(events()).toEqual(["sign.expired"]);
    expect(rec.webhooks.mock.calls[0][1]).toBe(ACCT);
  });

  it("sealing announces `completed` with the fingerprint of the sealed file and the verify page", async () => {
    const { document, rows } = await draft();
    Object.assign(db.rows("sign_documents")[0], { status: "sealing", reference: "SGN-2026-000123", sent_at: "2026-10-06T02:00:00Z", base_sha256: "f".repeat(64), contact_id: null });
    Object.assign(db.rows("sign_signers").find((s) => s.id === rows[0].id)!, { status: "signed", signed_at: "2026-10-06T06:03:00Z" });
    Object.assign(db.rows("sign_signers").find((s) => s.id === rows[1].id)!, { status: "signed", signed_at: "2026-10-06T08:00:00Z" });
    const png = `data:image/png;base64,${Buffer.from(await scribblePng()).toString("base64")}`;
    db.seed("sign_answers", [
      { account_id: ACCT, document_id: document.id, signer_id: rows[0].id, field_key: "biz", value: { text: "Kedai" } },
      { account_id: ACCT, document_id: document.id, signer_id: rows[0].id, field_key: "msig", value: { image: png, mime: "image/png" } },
      { account_id: ACCT, document_id: document.id, signer_id: rows[1].id, field_key: "dsig", value: { typed: "Gokula" } },
    ]);
    db.seed("sign_events", [{ account_id: ACCT, document_id: document.id, doc_seq: 1, type: "sent", signer_id: null, row_hash: "1".repeat(64), detail: {}, created_at: "2026-10-06T02:00:00Z" }]);
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
    db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: document.id, account_id: ACCT }], error: null });
    db.rpcHandlers.sign_finish_sealing = async (a) => {
      Object.assign(db.rows("sign_documents")[0], { status: "completed", completed_at: "2026-10-06T08:01:00Z", final_path: a.p_final_path, final_sha256: a.p_final_sha256 });
      return { data: {}, error: null };
    };
    db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });

    expect(await runSealing({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now }, 2)).toEqual({ claimed: 1, completed: 1, retry: 0 });
    expect(events()).toEqual(["sign.completed"]);
    const fin = db.rpcCalls.find((c) => c.name === "sign_finish_sealing")!;
    const data = rec.webhooks.mock.calls[0][3];
    expect(data.final_sha256).toBe(fin.args.p_final_sha256);
    expect(createHash("sha256").update(db.files.get(fin.args.p_final_path as string)!).digest("hex")).toBe(data.final_sha256);
    expect(data.verify_url).toBe(`https://halo.test/verify/${document.id}`);
    expect(data.status).toBe("completed");
    // the signed file is never linked
    expect(JSON.stringify(data)).not.toContain(String(fin.args.p_final_path));
  });

  it("a sealing that fails is not announced", async () => {
    const { document } = await draft();
    Object.assign(db.rows("sign_documents")[0], { status: "sealing", reference: "SGN-1" });
    db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: document.id, account_id: ACCT }], error: null });
    db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });
    db.files.set(db.rows("sign_documents")[0].base_path as string, new TextEncoder().encode("not a pdf"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSealing({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now }, 2)).toMatchObject({ claimed: 1, completed: 0, retry: 1 });
    spy.mockRestore();
    expect(events()).toEqual([]);
  });

  it("a workspace without Doc Sign emits nothing from any hook point", async () => {
    db.tables.account_platform = [{ account_id: ACCT, status: "active", features: { sign: false }, limits: {} }];
    await sent();
    db.rpcHandlers.sign_void_document = async () => ({ data: {}, error: null });
    await voidDocument(ctx, db.rows("sign_documents")[0].id as string, null);
    expect(events()).toEqual([]);
    expect(rec.automations).not.toHaveBeenCalled();
  });
});
