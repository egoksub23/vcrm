import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { NotifyDeps } from "../notify";
import { A4, makePdf, scribblePng } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import { verifySealed } from "../pdf/verify";
import { hashCode, hashToken } from "../tokens";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { SignError } from "./errors";
import { FakeDb } from "./fake-db";
import { createDraftFromTemplate, createDraftFromUpload, deleteDraft, setSigners, updateDraft } from "./drafts";
import { runSealing } from "./seal";
import { changeRecipient, resendSigner, sendDocument, voidDocument } from "./send";
import { buildView, completeSigning, declineSigning, fileForSigner, lookupByToken, pageState, recordConsent, saveAnswers, sendCode, verifyCode, type Lookup } from "./signing";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "fee", type: "static_text", role: "sender", text: "RM 1.00 per collection", page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.04, required: false },
  { key: "biz", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.2, w: 0.5, h: 0.04, required: true },
  { key: "mname", type: "name", role: "merchant", page: 0, x: 0.1, y: 0.3, w: 0.5, h: 0.04, required: true },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "mdate", type: "date_signed", role: "merchant", page: 0, x: 0.55, y: 0.4, w: 0.3, h: 0.04, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: unknown[];
}

function setup() {
  const db = new FakeDb();
  const mail: Mail[] = [];
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject, text: a.text, attachments: a.attachments }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("sign_categories", [{ id: "cat1", account_id: ACCT, key: "merchant_agreements", name: "Merchant agreements", expiry_days: 10, reminder_days: null, code_required: false, sign_in_order: false, archived: false }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  return { db, ctx, mail };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  t = setup();
});

async function draftWithLayout() {
  const pdf = await makePdf([{ ...A4 }]);
  const { document } = await createDraftFromUpload(t.ctx, { bytes: pdf, filename: "Merchant Application.pdf", categoryId: "cat1", title: "Merchant Application: Kedai Runcit" });
  await updateDraft(t.ctx, document.id, { roles, fields, mergeValues: {} });
  return document;
}

const signerInput = (over: Record<string, unknown> = {}) => ({ roleKey: "merchant", kind: "signer" as const, fullName: "Ali bin Ahmad", email: "ali@kedairuncit.example", channel: "email" as const, orderNo: 1, ...over });

describe("drafts", () => {
  it("makes a draft from a PDF upload with the category's choices, its files stored and recorded", async () => {
    const pdf = await makePdf([{ ...A4 }, { ...A4 }]);
    const { document, converted } = await createDraftFromUpload(t.ctx, { bytes: pdf, filename: "Terms.pdf", categoryId: "cat1" });
    expect(converted).toBe(false);
    expect(document).toMatchObject({ status: "draft", title: "Terms", page_count: 2, sign_in_order: false, code_required: false, category_id: "cat1", created_by: USER });
    expect(document.base_path).toMatch(new RegExp(`^account-${ACCT}/${document.id}/base/[0-9a-f]{64}\\.pdf$`));
    expect(t.db.files.has(document.base_path!)).toBe(true);
    expect(t.db.rows("sign_document_files")).toHaveLength(1);
    expect(t.db.rpcCalls.some((c) => c.name === "sign_log" && c.args.p_type === "created")).toBe(true);
  });

  it("refuses an upload that is not what it says, with a stable code", async () => {
    const err = await createDraftFromUpload(t.ctx, { bytes: new TextEncoder().encode("hello"), filename: "a.pdf" }).catch((e) => e);
    expect(err).toBeInstanceOf(SignError);
    expect(err.code).toBe("upload_unsupported");
    expect(t.db.rows("sign_documents")).toHaveLength(0);
  });

  it("refuses a category or contact from another workspace", async () => {
    const pdf = await makePdf([{ ...A4 }]);
    t.db.seed("sign_categories", [{ id: "other", account_id: "someone-else", key: "x", name: "X", archived: false }]);
    await expect(createDraftFromUpload(t.ctx, { bytes: pdf, filename: "a.pdf", categoryId: "other" })).rejects.toMatchObject({ code: "category_not_found" });
    await expect(createDraftFromUpload(t.ctx, { bytes: pdf, filename: "a.pdf", contactId: "nobody" })).rejects.toMatchObject({ code: "contact_not_found" });
  });

  it("makes a draft from a template: a copy of its file, fields, roles and defaults", async () => {
    const src = await makePdf([{ ...A4 }]);
    const sha = createHash("sha256").update(src).digest("hex");
    t.db.files.set(`account-${ACCT}/templates/tpl1/v1.pdf`, src);
    t.db.seed("sign_templates", [{ id: "tpl1", account_id: ACCT, name: "Merchant Application", status: "active", category_id: "cat1", current_version_id: "ver1" }]);
    t.db.seed("sign_template_versions", [{ id: "ver1", account_id: ACCT, template_id: "tpl1", version_no: 3, source_path: `account-${ACCT}/templates/tpl1/v1.pdf`, source_sha256: sha, original_path: null, page_count: 1, fields, roles, defaults: { sign_in_order: true, code_required: true, locale: "ms", message: "Please sign." } }]);
    const doc = await createDraftFromTemplate(t.ctx, { templateId: "tpl1" });
    expect(doc).toMatchObject({ title: "Merchant Application", template_version_id: "ver1", sign_in_order: true, code_required: true, locale: "ms", message: "Please sign." });
    expect(doc.fields_snapshot).toHaveLength(fields.length);
    expect(doc.roles_snapshot).toHaveLength(2);
    expect(t.db.files.get(doc.base_path!)).toEqual(src);
    // the template's own file is untouched and not shared
    expect(doc.base_path).not.toBe(`account-${ACCT}/templates/tpl1/v1.pdf`);
    // an inactive template cannot be used
    t.db.rows("sign_templates")[0].status = "archived";
    await expect(createDraftFromTemplate(t.ctx, { templateId: "tpl1" })).rejects.toMatchObject({ code: "template_not_active" });
  });

  it("validates changes to a draft and refuses a sent one", async () => {
    const doc = await draftWithLayout();
    await expect(updateDraft(t.ctx, doc.id, { title: "" })).rejects.toMatchObject({ code: "bad_title" });
    await expect(updateDraft(t.ctx, doc.id, { locale: "fr" })).rejects.toMatchObject({ code: "bad_locale" });
    await expect(updateDraft(t.ctx, doc.id, { expiresAt: "2020-01-01" })).rejects.toMatchObject({ code: "expiry_in_the_past" });
    await expect(updateDraft(t.ctx, doc.id, { fields: [{ ...fields[1], page: 4 }] })).rejects.toMatchObject({ code: "invalid_layout", issues: [{ code: "page_out_of_range" }] });
    await expect(updateDraft(t.ctx, doc.id, { mergeValues: { "bad key": "x" } })).rejects.toMatchObject({ code: "bad_merge_values" });
    const ok = await updateDraft(t.ctx, doc.id, { title: "New title", signInOrder: true, reminderDays: [9, 2, 2], mergeValues: { business_name: "Kedai", empty: "" } });
    expect(ok).toMatchObject({ title: "New title", sign_in_order: true, reminder_days: [2, 9], merge_values: { business_name: "Kedai" } });
    t.db.rows("sign_documents")[0].status = "sent";
    await expect(updateDraft(t.ctx, doc.id, { title: "x" })).rejects.toMatchObject({ code: "document_not_draft" });
  });

  it("checks the signing list and replaces it", async () => {
    const doc = await draftWithLayout();
    await expect(setSigners(t.ctx, doc.id, [signerInput({ fullName: " " })])).rejects.toMatchObject({ code: "signer_name" });
    await expect(setSigners(t.ctx, doc.id, [signerInput({ email: "nope" })])).rejects.toMatchObject({ code: "signer_email" });
    await expect(setSigners(t.ctx, doc.id, [signerInput({ channel: "whatsapp", phone: "0123" })])).rejects.toMatchObject({ code: "signer_phone" });
    await expect(setSigners(t.ctx, doc.id, [signerInput({ roleKey: "ghost" })])).rejects.toMatchObject({ code: "signer_role" });
    const rows = await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2, channel: "whatsapp", phone: "+60 12-345 6789" })]);
    expect(rows.map((r) => r.full_name)).toEqual(["Ali bin Ahmad", "Gokula"]);
    expect(rows[1].phone).toBe("+60123456789");
    const again = await setSigners(t.ctx, doc.id, [signerInput()]);
    expect(again).toHaveLength(1);
    expect(t.db.rows("sign_signers")).toHaveLength(1);
  });

  it("deletes a draft with its own files only", async () => {
    const doc = await draftWithLayout();
    t.db.files.set(`account-${ACCT}/templates/tpl1/v1.pdf`, new Uint8Array([1]));
    t.db.rows("sign_document_files").push({ id: "f", document_id: doc.id, account_id: ACCT, path: `account-${ACCT}/templates/tpl1/v1.pdf` });
    await deleteDraft(t.ctx, doc.id);
    expect(t.db.rows("sign_documents")).toHaveLength(0);
    expect(t.db.files.has(doc.base_path!)).toBe(false);
    expect(t.db.files.has(`account-${ACCT}/templates/tpl1/v1.pdf`)).toBe(true);
  });
});

// ---- send ---------------------------------------------------------------------------------------

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

function sendHandler(invited: { signer_id: string; token: string }[]) {
  t.db.rpcHandlers.sign_send_document = async (args) => {
    const doc = t.db.rows("sign_documents").find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at });
    const people = t.db.rows("sign_signers").filter((s) => s.document_id === args.p_document);
    return {
      data: {
        reference: "SGN-2026-000001",
        invited: invited.map((i) => {
          const s = people.find((p) => p.id === i.signer_id)!;
          return { signer_id: s.id, token: i.token, name: s.full_name, email: s.email, phone: s.phone ?? null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no };
        }),
      },
      error: null,
    };
  };
}

describe("sendDocument", () => {
  it("refuses a document that is not ready, listing every problem", async () => {
    const pdf = await makePdf([{ ...A4 }]);
    const { document } = await createDraftFromUpload(t.ctx, { bytes: pdf, filename: "a.pdf" });
    const err = await sendDocument(t.ctx, document.id).catch((e) => e);
    expect(err).toBeInstanceOf(SignError);
    expect(err.code).toBe("not_ready");
    expect(err.issues.map((i: { code: string }) => i.code)).toContain("no_signer");
  });

  it("freezes the file with the sender's values, sends, and delivers the first invitation", async () => {
    const doc = await draftWithLayout();
    const rows = await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2 })]);
    sendHandler(rows.map((r) => ({ signer_id: r.id as string, token: r.role_key === "merchant" ? TOKEN_A : TOKEN_B })));
    const res = await sendDocument(t.ctx, doc.id);
    expect(res.reference).toBe("SGN-2026-000001");
    expect(res.invited).toHaveLength(2);
    expect(res.invited.every((i) => i.delivery.status === "sent")).toBe(true);
    expect(res.invited[0].link).toBeUndefined(); // delivered: the link is not handed back
    expect(t.mail.map((m) => m.to).sort()).toEqual(["ali@kedairuncit.example", "g@vircle.example"]);
    expect(t.mail[0].text).toContain(`https://halo.test/s/${TOKEN_A}`);
    // category expiry 10 days from the sent time
    expect(res.expiresAt).toBe("2026-10-16T08:00:00.000Z");
    // the file that was frozen is a new object and carries the static text
    const call = t.db.rpcCalls.find((c) => c.name === "sign_send_document")!;
    expect(call.args.p_base_path).toMatch(/\/base\/sent-[0-9a-f]{64}\.pdf$/);
    expect(t.db.files.has(call.args.p_base_path as string)).toBe(true);
    expect(call.args.p_actor).toBe(USER);
  });

  it("hands the link back when a message could not be delivered, and records the failure", async () => {
    const doc = await draftWithLayout();
    const rows = await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2 })]);
    sendHandler([{ signer_id: rows[0].id as string, token: TOKEN_A }]);
    t.ctx.deps = { ...t.ctx.deps, sendEmail: async () => { throw new Error("Resend: domain not verified"); } };
    const res = await sendDocument(t.ctx, doc.id);
    expect(res.invited[0].delivery).toMatchObject({ status: "failed" });
    expect(res.invited[0].link).toBe(`https://halo.test/s/${TOKEN_A}`);
    expect(t.db.rpcCalls.some((c) => c.name === "sign_log" && c.args.p_type === "delivery_failed")).toBe(true);
  });

  it("stops at the monthly limit", async () => {
    const doc = await draftWithLayout();
    await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2 })]);
    t.db.rpcHandlers.account_usage = async () => ({ data: { limits: { sign_documents_per_month: 5 }, sign_documents_month: 5 }, error: null });
    const err = await sendDocument(t.ctx, doc.id).catch((e) => e);
    expect(err).toMatchObject({ code: "sign_limit_reached", status: 429 });
    expect(t.db.rpcCalls.some((c) => c.name === "sign_send_document")).toBe(false);
  });

  it("removes the frozen file when the database refuses the send", async () => {
    const doc = await draftWithLayout();
    await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2 })]);
    t.db.rpcHandlers.sign_send_document = async () => ({ data: null, error: { message: "document_not_draft" } });
    const before = t.db.files.size;
    await expect(sendDocument(t.ctx, doc.id)).rejects.toMatchObject({ code: "document_not_draft" });
    expect(t.db.files.size).toBe(before);
  });

  it("voids, resends and changes a recipient through the database functions", async () => {
    const doc = await draftWithLayout();
    const rows = await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2 })]);
    t.db.rows("sign_documents")[0].status = "sent";
    t.db.rows("sign_signers").forEach((s) => Object.assign(s, { status: "sent", invited_at: "2026-10-06T08:00:00Z" }));
    const brief = (s: Record<string, unknown>, token: string) => ({ signer_id: s.id, token, name: s.full_name, email: s.email, phone: null, channel: "email", role_key: s.role_key, kind: "signer", order_no: s.order_no });
    t.db.rpcHandlers.sign_rotate_token = async (a) => ({ data: brief(t.db.rows("sign_signers").find((s) => s.id === a.p_signer)!, TOKEN_B), error: null });
    t.db.rpcHandlers.sign_change_recipient = async (a) => ({ data: brief({ ...t.db.rows("sign_signers").find((s) => s.id === a.p_signer)!, full_name: a.p_name, email: a.p_email }, TOKEN_B), error: null });
    t.db.rpcHandlers.sign_void_document = async () => ({ data: {}, error: null });

    const r = await resendSigner(t.ctx, doc.id, rows[0].id as string);
    expect(r.delivery.status).toBe("sent");
    expect(t.mail.at(-1)!.text).toContain(TOKEN_B);
    const c = await changeRecipient(t.ctx, doc.id, rows[0].id as string, { fullName: "Ali's Finance", email: "finance@kedairuncit.example" });
    expect(c.delivery.status).toBe("sent");
    expect(t.mail.at(-1)!.to).toBe("finance@kedairuncit.example");
    await expect(changeRecipient(t.ctx, doc.id, rows[0].id as string, { fullName: "", email: "x" })).rejects.toMatchObject({ code: "signer_details" });
    await voidDocument(t.ctx, doc.id, "Wrong merchant");
    expect(t.mail.at(-1)!.subject).toContain("Cancelled");
    await expect(resendSigner(t.ctx, doc.id, "nobody")).rejects.toMatchObject({ code: "signer_not_found" });
  });
});

// ---- signing ---------------------------------------------------------------------------------------

/** A sent document with two signers and live links, ready for the signers' side. */
async function sentDocument(opts: { codeRequired?: boolean; ordered?: boolean } = {}) {
  const doc = await draftWithLayout();
  const rows = await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2 })]);
  const d = t.db.rows("sign_documents")[0];
  Object.assign(d, { status: "sent", code_required: !!opts.codeRequired, sign_in_order: !!opts.ordered, expires_at: "2026-10-16T08:00:00Z", base_sha256: "f".repeat(64) });
  // the frozen base is the draft's working file in these tests
  const [m, dir] = rows;
  Object.assign(t.db.rows("sign_signers").find((s) => s.id === m.id)!, { status: "sent", invited_at: "2026-10-06T08:00:00Z" });
  if (!opts.ordered) Object.assign(t.db.rows("sign_signers").find((s) => s.id === dir.id)!, { status: "sent", invited_at: "2026-10-06T08:00:00Z" });
  t.db.seed("sign_signer_secrets", [
    { signer_id: m.id, account_id: ACCT, token_hash: hashToken(TOKEN_A), code_hash: null, code_expires_at: null, code_attempts: 0 },
    { signer_id: dir.id, account_id: ACCT, token_hash: hashToken(TOKEN_B), code_hash: null, code_expires_at: null, code_attempts: 0 },
  ]);
  return { doc, merchant: m, director: dir };
}

async function look(token: string): Promise<Lookup> {
  const l = await lookupByToken(t.ctx.admin, token);
  expect(l).not.toBeNull();
  return l!;
}

describe("a signer's link", () => {
  it("finds the signer by the hash of the token, and nothing else", async () => {
    await sentDocument();
    expect((await look(TOKEN_A)).signer.full_name).toBe("Ali bin Ahmad");
    expect(await lookupByToken(t.ctx.admin, "c".repeat(64))).toBeNull();
    expect(await lookupByToken(t.ctx.admin, "short")).toBeNull();
    expect(await lookupByToken(t.ctx.admin, undefined)).toBeNull();
    expect(await lookupByToken(t.ctx.admin, hashToken(TOKEN_A))).toBeNull(); // the hash itself is not a link
  });

  it("shows the page state, the fields of the signer's role and what is still missing", async () => {
    await sentDocument();
    const l = await look(TOKEN_A);
    expect(pageState(l.doc, l.signer)).toBe("active");
    const view = await buildView(t.ctx, l, false);
    expect(view).toMatchObject({ state: "active", needsCode: false, needsConsent: true, document: { title: "Merchant Application: Kedai Runcit" }, workspace: { name: "Vircle Sdn Bhd" } });
    expect(view.content!.fields).toHaveLength(fields.length);
    // the merchant must fill the business name and sign; the name and date write themselves
    expect(view.content!.missing).toEqual(["biz", "msig"]);
    expect(view.content!.others.map((o) => o.name)).toEqual(["Gokula"]);
  });

  it("shows no content before the code when the document needs one", async () => {
    await sentDocument({ codeRequired: true });
    const l = await look(TOKEN_A);
    const view = await buildView(t.ctx, l, false);
    expect(view.needsCode).toBe(true);
    expect(view.content).toBeNull();
    expect(await fileForSigner(t.ctx, l, false)).toBeNull();
    expect((await buildView(t.ctx, l, true)).content).not.toBeNull();
    expect(await fileForSigner(t.ctx, l, true)).not.toBeNull();
  });

  it("says how a document ended", async () => {
    await sentDocument();
    const l = await look(TOKEN_A);
    for (const [status, state] of [["expired", "expired"], ["voided", "voided"], ["declined", "declined"], ["completed", "completed"], ["sealing", "sealing"]] as const) {
      expect(pageState({ ...l.doc, status }, l.signer)).toBe(state);
    }
    expect(pageState({ ...l.doc, status: "in_progress" }, { ...l.signer, status: "signed" })).toBe("signed");
    expect(pageState({ ...l.doc, status: "sent" }, { ...l.signer, status: "pending" })).toBe("not_invited");
  });
});

describe("the verification code", () => {
  it("is sent by email, stored only as a hash, and rate limited", async () => {
    await sentDocument({ codeRequired: true });
    const l = await look(TOKEN_A);
    const ok = await sendCode(t.ctx, l, async () => true);
    expect(ok).toMatchObject({ ok: true, delivery: { status: "sent" } });
    const stored = t.db.rows("sign_signer_secrets").find((s) => s.signer_id === l.signer.id)!;
    expect(stored.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const code = /\b(\d{6})\b/.exec(t.mail.at(-1)!.text)![1];
    expect(stored.code_hash).toBe(hashCode(code, l.signer.id));
    expect(await sendCode(t.ctx, l, async () => false)).toEqual({ ok: false, reason: "rate_limited" });
    // a document without a code needs none
    t.db.rows("sign_documents")[0].code_required = false;
    expect(await sendCode(t.ctx, await look(TOKEN_A), async () => true)).toEqual({ ok: false, reason: "not_needed" });
  });

  it("accepts the right code once and counts every try", async () => {
    await sentDocument({ codeRequired: true });
    const l = await look(TOKEN_A);
    await sendCode(t.ctx, l, async () => true);
    const code = /\b(\d{6})\b/.exec(t.mail.at(-1)!.text)![1];
    t.db.rpcHandlers.sign_code_attempt = async (a) => {
      const s = t.db.rows("sign_signer_secrets").find((r) => r.signer_id === a.p_signer)!;
      s.code_attempts = (s.code_attempts as number) + 1;
      return { data: { code_hash: s.code_hash, code_expires_at: s.code_expires_at, code_attempts: s.code_attempts }, error: null };
    };
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await verifyCode(t.ctx, l, wrong, "1.2.3.4", "x")).toMatchObject({ ok: false, reason: "wrong", attemptsLeft: 4 });
    expect(await verifyCode(t.ctx, l, code, "1.2.3.4", "x")).toEqual({ ok: true });
    // single use: the code is cleared
    expect(t.db.rows("sign_signer_secrets").find((s) => s.signer_id === l.signer.id)!.code_hash).toBeNull();
    expect(await verifyCode(t.ctx, l, code, "1.2.3.4", "x")).toMatchObject({ ok: false, reason: "no_code" });
  });

  it("locks out after five wrong tries even if the sixth is right", async () => {
    await sentDocument({ codeRequired: true });
    const l = await look(TOKEN_A);
    await sendCode(t.ctx, l, async () => true);
    const code = /\b(\d{6})\b/.exec(t.mail.at(-1)!.text)![1];
    const wrong = code === "000000" ? "111111" : "000000";
    t.db.rpcHandlers.sign_code_attempt = async (a) => {
      const s = t.db.rows("sign_signer_secrets").find((r) => r.signer_id === a.p_signer)!;
      s.code_attempts = (s.code_attempts as number) + 1;
      return { data: { code_hash: s.code_hash, code_expires_at: s.code_expires_at, code_attempts: s.code_attempts }, error: null };
    };
    for (let i = 0; i < 5; i++) await verifyCode(t.ctx, l, wrong, null, null);
    expect(await verifyCode(t.ctx, l, code, null, null)).toMatchObject({ ok: false, reason: "too_many_attempts" });
  });
});

describe("answering and finishing", () => {
  const png = async () => `data:image/png;base64,${Buffer.from(await scribblePng()).toString("base64")}`;

  it("needs agreement before anything is saved", async () => {
    await sentDocument();
    await expect(saveAnswers(t.ctx, await look(TOKEN_A), { biz: { text: "Kedai" } })).rejects.toMatchObject({ code: "consent_required" });
  });

  it("saves valid answers for the signer's own fields only, and reports the rest", async () => {
    await sentDocument();
    t.db.rpcHandlers.sign_record_consent = async (a) => {
      Object.assign(t.db.rows("sign_signers").find((s) => s.id === a.p_signer)!, { consented_at: "2026-10-06T08:01:00Z", consent_version: a.p_version });
      return { data: true, error: null };
    };
    await recordConsent(t.ctx, await look(TOKEN_A), "ms", "1.2.3.4", "Chrome");
    const l = await look(TOKEN_A);
    const r = await saveAnswers(t.ctx, l, { biz: { text: "  Kedai Runcit Ali  " }, dsig: { typed: "Gokula" }, msig: { image: "https://evil.example/x.png" }, nope: { text: "x" } });
    expect(r.saved).toEqual(["biz"]);
    expect(r.rejected).toEqual([{ field: "dsig", code: "not_your_field" }, { field: "msig", code: "bad_image" }, { field: "nope", code: "not_your_field" }]);
    expect(t.db.rows("sign_answers")).toHaveLength(1);
    expect(t.db.rows("sign_answers")[0]).toMatchObject({ field_key: "biz", value: { text: "Kedai Runcit Ali" }, signer_id: l.signer.id });
    // an empty value clears the answer
    await saveAnswers(t.ctx, l, { biz: { text: "" } });
    expect(t.db.rows("sign_answers")).toHaveLength(0);
  });

  it("will not finish with a required field empty, nor with an invalid answer", async () => {
    await sentDocument();
    t.db.rpcHandlers.sign_record_consent = async (a) => {
      Object.assign(t.db.rows("sign_signers").find((s) => s.id === a.p_signer)!, { consented_at: "2026-10-06T08:01:00Z" });
      return { data: true, error: null };
    };
    await recordConsent(t.ctx, await look(TOKEN_A), "en", null, null);
    const l = await look(TOKEN_A);
    const missing = await completeSigning(t.ctx, l, { biz: { text: "Kedai" } }, { ip: null, device: null, locale: "en" }).catch((e) => e);
    expect(missing).toMatchObject({ code: "missing_required", issues: [{ code: "missing_required", field: "msig" }] });
    const invalid = await completeSigning(t.ctx, l, { biz: { text: "x".repeat(300) } }, { ip: null, device: null, locale: "en" }).catch((e) => e);
    expect(invalid).toMatchObject({ code: "invalid_answers" });
    expect(t.db.rpcCalls.some((c) => c.name === "sign_complete_signer")).toBe(false);
  });

  it("finishes: saves the last answers, calls the database, and delivers the next invitation", async () => {
    await sentDocument({ ordered: true });
    t.db.rpcHandlers.sign_record_consent = async (a) => {
      Object.assign(t.db.rows("sign_signers").find((s) => s.id === a.p_signer)!, { consented_at: "2026-10-06T08:01:00Z" });
      return { data: true, error: null };
    };
    await recordConsent(t.ctx, await look(TOKEN_A), "en", null, null);
    const l = await look(TOKEN_A);
    const director = t.db.rows("sign_signers").find((s) => s.role_key === "director")!;
    t.db.rpcHandlers.sign_complete_signer = async () => ({
      data: { sealing: false, invited: [{ signer_id: director.id, token: TOKEN_B, name: "Gokula", email: "g@vircle.example", phone: null, channel: "email", role_key: "director", kind: "signer", order_no: 2 }] },
      error: null,
    });
    const out = await completeSigning(t.ctx, l, { biz: { text: "Kedai Runcit Ali" }, msig: { image: await png() } }, { ip: "203.0.113.9", device: "Chrome on Android", locale: "ms" });
    expect(out).toMatchObject({ sealing: false, invited: [{ name: "Gokula", delivery: { status: "sent" } }] });
    const call = t.db.rpcCalls.find((c) => c.name === "sign_complete_signer")!;
    expect(call.args).toMatchObject({ p_ip: "203.0.113.9", p_device: "Chrome on Android", p_locale: "ms" });
    expect(String(call.args.p_consent)).toMatch(/^default-v1-/);
    expect(t.mail.at(-1)!.to).toBe("g@vircle.example");
    expect(t.mail.at(-1)!.text).toContain(TOKEN_B);
  });

  it("maps the database's refusals (already signed, not open) to clear errors", async () => {
    await sentDocument();
    t.db.rpcHandlers.sign_record_consent = async (a) => {
      Object.assign(t.db.rows("sign_signers").find((s) => s.id === a.p_signer)!, { consented_at: "2026-10-06T08:01:00Z" });
      return { data: true, error: null };
    };
    await recordConsent(t.ctx, await look(TOKEN_A), "en", null, null);
    t.db.rpcHandlers.sign_complete_signer = async () => ({ data: null, error: { message: "already_signed" } });
    await expect(completeSigning(t.ctx, await look(TOKEN_A), { biz: { text: "K" }, msig: { typed: "Ali" } }, { ip: null, device: null, locale: null })).rejects.toMatchObject({ code: "already_signed", status: 409 });
    t.db.rows("sign_documents")[0].status = "voided";
    await expect(saveAnswers(t.ctx, await look(TOKEN_A), { biz: { text: "x" } })).rejects.toMatchObject({ code: "signer_not_open" });
  });

  it("declines, and tells the sender and the others who were waiting", async () => {
    await sentDocument();
    t.db.rpcHandlers.sign_decline_signer = async () => ({ data: {}, error: null });
    await declineSigning(t.ctx, await look(TOKEN_A), "Clause 4", { ip: null, device: null });
    const to = t.mail.map((m) => m.to).sort();
    expect(to).toEqual(["g@vircle.example", "gokula@vircle.example"]);
    expect(t.mail[0].text).toContain("Ali bin Ahmad declined");
    expect(t.mail[0].text).toContain("Clause 4");
  });
});

// ---- sealing -----------------------------------------------------------------------------------------

describe("sealing", () => {
  it("builds the final file, seals it, verifies what it stored, completes the document and tells everyone", async () => {
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    const doc = await draftWithLayout();
    const rows = await setSigners(t.ctx, doc.id, [signerInput(), signerInput({ roleKey: "director", fullName: "Gokula", email: "g@vircle.example", orderNo: 2 })]);
    const d = t.db.rows("sign_documents")[0];
    Object.assign(d, { status: "sealing", reference: "SGN-2026-000123", sent_at: "2026-10-06T02:00:00Z", base_sha256: "f".repeat(64) });
    const [m, dir] = rows;
    const sg = (id: unknown) => t.db.rows("sign_signers").find((s) => s.id === id)!;
    Object.assign(sg(m.id), { status: "signed", signed_at: "2026-10-06T06:03:00Z", ip: "203.0.113.9", device: "Chrome" });
    Object.assign(sg(dir.id), { status: "signed", signed_at: "2026-10-06T08:00:00Z", ip: "198.51.100.4", device: "Safari" });
    const png = `data:image/png;base64,${Buffer.from(await scribblePng()).toString("base64")}`;
    t.db.seed("sign_answers", [
      { account_id: ACCT, document_id: doc.id, signer_id: m.id, field_key: "biz", value: { text: "Kedai Runcit Ali Sdn Bhd" } },
      { account_id: ACCT, document_id: doc.id, signer_id: m.id, field_key: "msig", value: { image: png, mime: "image/png" } },
      { account_id: ACCT, document_id: doc.id, signer_id: dir.id, field_key: "dsig", value: { typed: "Gokula" } },
    ]);
    t.db.seed("sign_events", [
      { account_id: ACCT, document_id: doc.id, doc_seq: 1, type: "sent", signer_id: null, row_hash: "1".repeat(64), detail: {}, created_at: "2026-10-06T02:00:00Z" },
      { account_id: ACCT, document_id: doc.id, doc_seq: 2, type: "signed", signer_id: m.id, row_hash: "2".repeat(64), detail: {}, created_at: "2026-10-06T06:03:00Z" },
      { account_id: ACCT, document_id: doc.id, doc_seq: 3, type: "saved", signer_id: m.id, row_hash: "3".repeat(64), detail: {}, created_at: "2026-10-06T06:04:00Z" },
    ]);
    // a certificate is already on file (a small key keeps the test quick)
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    t.db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
    t.db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: doc.id, account_id: ACCT }], error: null });
    t.db.rpcHandlers.sign_finish_sealing = async (a) => {
      Object.assign(t.db.rows("sign_documents")[0], { status: "completed", final_path: a.p_final_path, final_sha256: a.p_final_sha256 });
      return { data: {}, error: null };
    };
    t.db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });

    const out = await runSealing({ admin: t.ctx.admin, origin: t.ctx.origin, deps: t.ctx.deps, now: t.ctx.now }, 2);
    expect(out).toEqual({ claimed: 1, completed: 1, retry: 0 });

    const fin = t.db.rpcCalls.find((c) => c.name === "sign_finish_sealing")!;
    const bytes = t.db.files.get(fin.args.p_final_path as string)!;
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fin.args.p_final_sha256);
    const v = verifySealed(bytes);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.signer?.subject).toContain("Test seal");
    expect(t.db.rows("sign_document_files").some((f) => f.kind === "signed")).toBe(true);

    // everyone got the signed copy, attached: both signers and the sender
    expect(t.mail.map((m) => m.to).sort()).toEqual(["ali@kedairuncit.example", "g@vircle.example", "gokula@vircle.example"]);
    expect(t.mail.every((m) => Array.isArray(m.attachments) && m.attachments.length === 1)).toBe(true);
  });

  it("keeps the document in sealing, records why, and removes a half-written file when something fails", async () => {
    const doc = await draftWithLayout();
    Object.assign(t.db.rows("sign_documents")[0], { status: "sealing", reference: "SGN-1" });
    t.db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: doc.id, account_id: ACCT }], error: null });
    t.db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });
    // no signers at all and a corrupted base file make the render fail
    t.db.files.set(doc.base_path!, new TextEncoder().encode("not a pdf"));
    const out = await runSealing({ admin: t.ctx.admin, origin: t.ctx.origin, deps: t.ctx.deps, now: t.ctx.now }, 2);
    expect(out).toEqual({ claimed: 1, completed: 0, retry: 1 });
    expect(t.db.rpcCalls.some((c) => c.name === "sign_fail_sealing")).toBe(true);
    expect(t.db.rpcCalls.some((c) => c.name === "sign_finish_sealing")).toBe(false);
  });
});
