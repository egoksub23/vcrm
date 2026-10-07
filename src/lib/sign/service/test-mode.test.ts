import { createHash } from "node:crypto";

import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import { TEST_MARK_TEXT } from "../pdf/testmark";
import type { PlacedField } from "../pdf/types";
import { verifySealed } from "../pdf/verify";
import type { SignRole } from "../types";
import { listDocumentsForApi } from "./api";
import type { SignCtx } from "./context";
import { listNeedsAttention } from "./countersign";
import { createDraftFromTemplate } from "./drafts";
import { documentsCsvStream } from "./export";
import { FakeDb } from "./fake-db";
import { runSealing } from "./seal";
import { sendDocument } from "./send";
import { sendTestDocument } from "./test-mode";
import { setSigners } from "./drafts";

// What the template page's "Send a test" does and what a test document is and is not: marked TEST, not counted, not announced, not
// listed where the real ones are, and never sent to anyone but the person who made it. The database half (the count, the 30 days, the
// flag being fixed once sent) is proved by supabase/ci/verify-170.
const rec = vi.hoisted(() => ({ automations: vi.fn(), webhooks: vi.fn() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: (...a: unknown[]) => rec.automations(...a) }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: (...a: unknown[]) => rec.webhooks(...a) }));

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TOKEN = (c: string) => c.repeat(64);

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
  { key: "finance", label: "Finance", kind: "filler", color: 2 },
];
const fields: PlacedField[] = [
  { key: "biz", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.2, w: 0.5, h: 0.04, required: true },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

interface Mail {
  to: string;
  subject: string;
  text: string;
}

let db: FakeDb;
let ctx: SignCtx;
let mail: Mail[];

async function template(over: Record<string, unknown> = {}, version: Record<string, unknown> = {}) {
  const pdf = await makePdf([{ ...A4 }, { ...A4 }]);
  const sha = createHash("sha256").update(pdf).digest("hex");
  db.files.set(`account-${ACCT}/templates/tpl1/v1.pdf`, pdf);
  db.seed("sign_templates", [{ id: "tpl1", account_id: ACCT, name: "Merchant Application", status: "active", category_id: null, current_version_id: "ver1", ...over }]);
  db.seed("sign_template_versions", [
    { id: "ver1", account_id: ACCT, template_id: "tpl1", version_no: 2, source_path: `account-${ACCT}/templates/tpl1/v1.pdf`, source_sha256: sha, original_path: null, page_count: 2, fields, roles, defaults: { reminder_days: [3, 7], sign_in_order: false }, form: null, ...version },
  ]);
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  db = new FakeDb();
  mail = [];
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject, text: a.text }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-08T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: { sign_documents_per_month: 1 } }]);
  db.seed("automations", [{ id: "a1", account_id: ACCT, trigger_type: "sign_document_event", is_active: true }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  // the workspace is AT its monthly limit: a real document is refused, a test is not
  db.rpcHandlers.account_usage = async () => ({ data: { limits: { sign_documents_per_month: 1 }, sign_documents_month: 1 }, error: null });
  db.rpcHandlers.sign_send_document = async (args) => {
    const doc = db.rows("sign_documents").find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: "sent", sent_at: "2026-10-08T08:00:00Z", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at });
    const people = db.rows("sign_signers").filter((s) => s.document_id === args.p_document);
    return {
      data: {
        reference: "SGN-2026-000009",
        invited: people.map((s, i) => ({ signer_id: s.id, token: TOKEN(String.fromCharCode(97 + i)), name: s.full_name, email: s.email, phone: null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no })),
      },
      error: null,
    };
  };
  rec.automations.mockReset().mockResolvedValue(undefined);
  rec.webhooks.mockReset().mockResolvedValue(undefined);
});

/** Everything drawn on every page of a PDF, as text (pdf-lib compresses a page's content). */
async function drawnText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const c = page.node.lookup(PDFName.of("Contents"));
    const streams = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    return streams.map((s) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString("latin1")).join(" ");
  });
}
const marked = (page: string) => page.includes(`<${Buffer.from(TEST_MARK_TEXT).toString("hex").toUpperCase()}>`);

describe("sending a test from a template", () => {
  it("sends the signed-in person every place that needs someone, as a test, to their own address", async () => {
    await template();
    const r = await sendTestDocument(ctx, "tpl1");
    const doc = db.rows("sign_documents")[0];
    expect(doc).toMatchObject({ test: true, status: "sent", template_version_id: "ver1", created_by: USER, reminder_days: [], sign_in_order: false });
    // the finance filler has nothing to fill, so nobody is needed for it; the other two roles are the person
    expect(db.rows("sign_signers").map((s) => [s.role_key, s.email, s.full_name, s.internal_user_id])).toEqual([
      ["merchant", "gokula@vircle.example", "Gokula (Merchant)", USER],
      ["director", "gokula@vircle.example", "Gokula (Director)", USER],
    ]);
    expect(r).toMatchObject({ documentId: doc.id, reference: "SGN-2026-000009", orderIgnored: false, people: [{ roleKey: "merchant", email: "gokula@vircle.example" }, { roleKey: "director", email: "gokula@vircle.example" }] });
    expect(r.invited.map((i) => i.delivery.status)).toEqual(["sent", "sent"]);
    // every message says TEST, and goes to the person
    expect(mail.map((m) => m.to)).toEqual(["gokula@vircle.example", "gokula@vircle.example"]);
    expect(mail.every((m) => m.subject.includes("[TEST]") && m.text.includes("[TEST]"))).toBe(true);
    // the created event says it was a test
    expect(db.rpcCalls.find((c) => c.name === "sign_log" && c.args.p_type === "created")?.args.p_detail).toMatchObject({ source: "template", test: true });
  });

  it("puts the TEST mark on every page of the file that is sent, and the file the signers see is that file", async () => {
    await template();
    await sendTestDocument(ctx, "tpl1");
    const doc = db.rows("sign_documents")[0];
    const pages = await drawnText(db.files.get(doc.base_path as string)!);
    expect(pages).toHaveLength(2);
    expect(pages.every(marked)).toBe(true);
    // the fingerprint recorded is the fingerprint of that marked file
    expect(createHash("sha256").update(db.files.get(doc.base_path as string)!).digest("hex")).toBe(doc.base_sha256);
    // the template's own file is untouched
    expect((await drawnText(db.files.get(`account-${ACCT}/templates/tpl1/v1.pdf`)!)).some(marked)).toBe(false);
  });

  it("does not count against the monthly limit: it is sent at the limit and the limit is never asked", async () => {
    await template();
    await sendTestDocument(ctx, "tpl1");
    expect(db.rpcCalls.some((c) => c.name === "account_usage")).toBe(false);
    // the same workspace, the same moment, a real document: refused
    const real = await createDraftFromTemplate(ctx, { templateId: "tpl1" });
    await setSigners(ctx, real.id, [
      { roleKey: "merchant", kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 },
      { roleKey: "director", kind: "signer", fullName: "Gokula", email: "g@vircle.example", channel: "email", orderNo: 2 },
    ]);
    await expect(sendDocument(ctx, real.id)).rejects.toMatchObject({ code: "sign_limit_reached", status: 429 });
  });

  it("tells no webhook and no automation about a test, and still tells them about a real document", async () => {
    await template();
    await sendTestDocument(ctx, "tpl1");
    expect(rec.webhooks).not.toHaveBeenCalled();
    expect(rec.automations).not.toHaveBeenCalled();
    // a real one, with room in the limit
    db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
    const real = await createDraftFromTemplate(ctx, { templateId: "tpl1" });
    await setSigners(ctx, real.id, [
      { roleKey: "merchant", kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 },
      { roleKey: "director", kind: "signer", fullName: "Gokula", email: "g@vircle.example", channel: "email", orderNo: 2 },
    ]);
    await sendDocument(ctx, real.id);
    expect(rec.webhooks.mock.calls.map((c) => c[2])).toEqual(["sign.sent"]);
    expect(db.rows("sign_documents").find((d) => d.id === real.id)?.test ?? false).toBe(false);
  });

  it("can try a template that is still a draft, but not an archived one", async () => {
    await template({ status: "draft" });
    await expect(sendTestDocument(ctx, "tpl1")).resolves.toMatchObject({ reference: "SGN-2026-000009" });
    db.tables.sign_documents = [];
    db.tables.sign_signers = [];
    db.rows("sign_templates")[0].status = "archived";
    await expect(sendTestDocument(ctx, "tpl1")).rejects.toMatchObject({ code: "template_not_active" });
    // a real document still needs an active template
    db.rows("sign_templates")[0].status = "draft";
    await expect(createDraftFromTemplate(ctx, { templateId: "tpl1" })).rejects.toMatchObject({ code: "template_not_active" });
  });

  it("allows another address of the same person (the same mailbox with a +tag) and nobody else's", async () => {
    await template();
    const ok = await sendTestDocument(ctx, "tpl1", { emails: { director: "gokula+director@vircle.example" } });
    expect(ok.people).toEqual([
      { roleKey: "merchant", email: "gokula@vircle.example" },
      { roleKey: "director", email: "gokula+director@vircle.example" },
    ]);
    db.tables.sign_documents = [];
    db.tables.sign_signers = [];
    mail.length = 0;
    for (const bad of [{ email: "ali@kedai.example" }, { emails: { director: "boss@vircle.example" } }, { emails: { merchant: "gokula@evil.example" } }, { emails: { merchant: "not an email" } }]) {
      await expect(sendTestDocument(ctx, "tpl1", bad)).rejects.toMatchObject({ code: "test_email_not_yours", status: 400 });
    }
    // nothing was sent, and no draft was left behind by the refusals
    expect(mail).toEqual([]);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(db.rows("sign_signers")).toHaveLength(0);
  });

  it("drops the signing order when one address holds several places, and keeps it when each place has its own address", async () => {
    await template({}, { defaults: { sign_in_order: true } });
    const same = await sendTestDocument(ctx, "tpl1");
    expect(same.orderIgnored).toBe(true);
    expect(db.rows("sign_documents")[0].sign_in_order).toBe(false);
    db.tables.sign_documents = [];
    db.tables.sign_signers = [];
    const own = await sendTestDocument(ctx, "tpl1", { emails: { director: "gokula+two@vircle.example" } });
    expect(own.orderIgnored).toBe(false);
    expect(db.rows("sign_documents")[0].sign_in_order).toBe(true);
    expect(db.rows("sign_signers").map((s) => s.order_no)).toEqual([1, 2]);
  });

  it("says so when the template has nobody to sign or fill it, and leaves nothing behind", async () => {
    await template({}, { fields: [], roles: [] });
    await expect(sendTestDocument(ctx, "tpl1")).rejects.toMatchObject({ code: "test_no_roles", status: 409 });
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("deletes the draft when the send itself fails, and keeps a document that did go out", async () => {
    await template();
    db.rpcHandlers.sign_send_document = async () => ({ data: null, error: { message: "document_not_draft" } });
    await expect(sendTestDocument(ctx, "tpl1")).rejects.toMatchObject({ code: "document_not_draft" });
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("is for a signed-in person only, and uses the template of this workspace only", async () => {
    await template();
    await expect(sendTestDocument({ ...ctx, userId: null }, "tpl1")).rejects.toMatchObject({ code: "signed_out", status: 401 });
    db.rows("sign_templates")[0].account_id = "someone-else";
    await expect(sendTestDocument(ctx, "tpl1")).rejects.toMatchObject({ code: "template_not_found" });
  });
});

describe("where a test document is left out", () => {
  const doc = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    account_id: ACCT,
    reference: `SGN-${id}`,
    title: `Doc ${id}`,
    status: "declined",
    category_id: null,
    created_at: "2026-10-05T01:00:00Z",
    updated_at: "2026-10-07T01:00:00Z",
    sent_at: null,
    completed_at: null,
    expires_at: null,
    contacts: null,
    sign_signers: [],
    test: false,
    ...over,
  });

  it("the public API's list", async () => {
    db.seed("sign_documents", [doc("real"), doc("test", { test: true })]);
    const page = await listDocumentsForApi(ctx, { status: null, contactId: null, templateId: null, reference: null, createdAfter: null }, { limit: 50, cursor: null });
    expect(page.documents.map((d) => d.id)).toEqual(["real"]);
  });

  it("the CSV export", async () => {
    db.seed("sign_documents", [doc("real"), doc("test", { test: true })]);
    const text = await new Response(documentsCsvStream(ctx, { group: "all", category: "all", search: "", from: null, to: null, contactId: null })).text();
    expect(text).toContain("SGN-real");
    expect(text).not.toContain("SGN-test");
  });

  it("the CSV export, unless the Test group is what was asked for", async () => {
    db.seed("sign_documents", [doc("real"), doc("test", { test: true })]);
    const text = await new Response(documentsCsvStream(ctx, { group: "test", category: "all", search: "", from: null, to: null, contactId: null })).text();
    expect(text).toContain("SGN-test");
    expect(text).not.toContain("SGN-real");
  });

  it("'Needs attention'", async () => {
    db.seed("sign_documents", [doc("real"), doc("test", { test: true })]);
    expect((await listNeedsAttention(ctx)).map((i) => i.documentId)).toEqual(["real"]);
  });

  it("is never made by a draft that was not asked to be a test (bulk and the API never ask)", async () => {
    await template();
    const real = await createDraftFromTemplate(ctx, { templateId: "tpl1" });
    expect(real.test ?? false).toBe(false);
    expect(db.rows("sign_documents")[0]).not.toHaveProperty("test", true);
  });
});

describe("sealing a test document", () => {
  it.each([false, true])("marks every page of the signed file and of its certificate, and both files still verify (certificate also embedded: %s)", async (embed) => {
    await template();
    if (embed) db.rows("sign_settings")[0].embed_certificate = true;
    await sendTestDocument(ctx, "tpl1");
    const d = db.rows("sign_documents")[0];
    // everyone signs; the sealing job takes it
    Object.assign(d, { status: "sealing", sent_at: "2026-10-08T08:00:00Z" });
    for (const s of db.rows("sign_signers")) Object.assign(s, { status: "signed", signed_at: "2026-10-08T08:30:00Z", ip: "203.0.113.9", device: "Chrome" });
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
    db.seed("sign_answers", [{ account_id: ACCT, document_id: d.id, signer_id: db.rows("sign_signers")[0].id, field_key: "biz", value: { text: "Kedai Test" } }]);
    db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: d.id, account_id: ACCT }], error: null });
    db.rpcHandlers.sign_finish_sealing = async (a) => {
      Object.assign(d, { status: "completed", final_path: a.p_final_path, final_sha256: a.p_final_sha256 });
      return { data: {}, error: null };
    };
    db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });

    const out = await runSealing({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now }, 1);
    expect(out).toEqual({ claimed: 1, completed: 1, retry: 0 });
    const fin = db.rpcCalls.find((c) => c.name === "sign_finish_sealing")!;
    const bytes = db.files.get(fin.args.p_final_path as string)!;
    const pages = await drawnText(bytes);
    // two pages of the document (and, only when the workspace asked for them inside the file, the certificate pages): all of them carry the mark
    if (embed) expect(pages.length).toBeGreaterThan(2);
    else expect(pages).toHaveLength(2);
    expect(pages.every(marked)).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fin.args.p_final_sha256);
    // the certificate is a file of its own and carries the mark on every page too
    const certificate = db.files.get(fin.args.p_certificate_path as string)!;
    expect(verifySealed(certificate).ok).toBe(true);
    const certificatePages = await drawnText(certificate);
    expect(certificatePages.length).toBeGreaterThan(0);
    expect(certificatePages.every(marked)).toBe(true);
    // and nothing was announced to the outside
    expect(rec.webhooks).not.toHaveBeenCalled();
  });
});
