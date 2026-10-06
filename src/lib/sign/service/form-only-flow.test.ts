import { getDocumentProxy } from "unpdf";
import { beforeEach, describe, expect, it } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { FormDefinition, L10n } from "../forms";
import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import { verifySealed } from "../pdf/verify";
import { hashToken } from "../tokens";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { FakeDb } from "./fake-db";
import { createDraftFromTemplate, setSigners, updateDraft } from "./drafts";
import { reviewFor } from "./review";
import { runSealing } from "./seal";
import { sendDocument } from "./send";
import { buildView, completeSigning, fileForSigner, lookupByToken, recordConsent, saveAnswers, type Lookup } from "./signing";
import { createFormTemplate, createTemplateFromDocument, createTemplateFromUpload, duplicateTemplate, saveTemplateVersion, updateTemplate } from "./templates";
import { uploadFile } from "./uploads";

// A form without a signature (migration 169, F-97), end to end against the in-memory database: a template of mode `form`, a
// document sent from it, a person who fills the parts over two sittings and submits, write-back to the contact, a sealed submission
// record that verifies, and the messages. The database functions themselves are proved by supabase/ci/verify-169.

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TOK = { applicant: "a".repeat(64), accounts: "b".repeat(64) } as const;
type RoleKey = keyof typeof TOK;

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });

const FORM: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company details", "Butiran syarikat"), role: "applicant" },
    { key: "einvoice", title: L("E-invoice", "e-Invois"), role: "applicant" },
    { key: "bank", title: L("Bank account"), role: "accounts" },
  ],
  fields: [
    { key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true, contactField: "company", writeBack: "always" },
    { key: "email", type: "email", part: "company", label: L("Email"), required: true, contactField: "email", writeBack: "if_empty" },
    { key: "tin", type: "text", part: "einvoice", label: L("Tax identification number (TIN)"), required: true, sensitive: true },
    { key: "msic", type: "text", part: "einvoice", label: L("MSIC code"), required: true, format: "digits", minLength: 5, maxLength: 5 },
    { key: "sst", type: "yesno", part: "einvoice", label: L("Registered for SST"), required: false },
    { key: "extract", type: "file", part: "einvoice", label: L("SSM extract"), required: false, accept: ["pdf"], maxMb: 1, maxFiles: 2 },
    { key: "accountNo", type: "text", part: "bank", label: L("Account number"), required: true, format: "digits" },
  ],
};

const roles: SignRole[] = [
  { key: "applicant", label: "Merchant", kind: "filler", color: 0 },
  { key: "accounts", label: "Accounts", kind: "filler", color: 1 },
];

interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments: string[];
}

function setup() {
  const db = new FakeDb();
  const mail: Mail[] = [];
  let nowMs = Date.parse("2026-10-06T08:00:00Z");
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject, text: a.text, attachments: (a.attachments ?? []).map((x) => x.filename) }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date(nowMs) };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("contacts", [{ id: "c1", account_id: ACCT, name: "Ali bin Ahmad", email: "ali@old.example", company: "Kedai Runcit Ali", deleted_at: null }]);

  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  db.rpcHandlers.sign_log = async (a) => {
    const seq = db.rows("sign_events").filter((e) => e.document_id === a.p_document).length + 1;
    db.seed("sign_events", [{ account_id: ACCT, document_id: a.p_document, doc_seq: seq, type: a.p_type, actor_type: a.p_actor_type, signer_id: a.p_signer, detail: a.p_detail ?? {}, row_hash: seq.toString(16).padStart(64, "0"), created_at: new Date(nowMs).toISOString() }]);
    return { data: null, error: null };
  };
  // the database's sign_send_document: the form-only rules are proved in verify-169; here the app's side of the call is
  db.rpcHandlers.sign_send_document = async (args) => {
    const doc = db.rows("sign_documents").find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at, reference: "SGN-2026-000777", sent_at: new Date(nowMs).toISOString() });
    const people = db.rows("sign_signers").filter((s) => s.document_id === args.p_document);
    const invited = people.map((p) => ({ signer_id: p.id, token: TOK[p.role_key as RoleKey], name: p.full_name, email: p.email, phone: null, channel: p.channel, role_key: p.role_key, kind: p.kind, order_no: p.order_no }));
    for (const p of people) {
      Object.assign(p, { status: "sent", invited_at: new Date(nowMs).toISOString(), consented_at: new Date(nowMs).toISOString() });
      db.seed("sign_signer_secrets", [{ signer_id: p.id, account_id: ACCT, token_hash: hashToken(TOK[p.role_key as RoleKey]), code_hash: null, code_expires_at: null, code_attempts: 0 }]);
    }
    return { data: { reference: "SGN-2026-000777", invited }, error: null };
  };
  db.rpcHandlers.sign_complete_signer = async (a) => {
    const s = db.rows("sign_signers").find((x) => x.id === a.p_signer)!;
    Object.assign(s, { status: "signed", signed_at: new Date(nowMs).toISOString() });
    const doc = db.rows("sign_documents").find((d) => d.id === s.document_id)!;
    await db.rpcHandlers.sign_log({ p_document: doc.id, p_type: "submitted", p_actor_type: "signer", p_signer: s.id, p_detail: { role: s.role_key } });
    const done = db.rows("sign_signers").filter((x) => x.document_id === doc.id).every((x) => x.status === "signed");
    doc.status = done ? "sealing" : "in_progress";
    if (done) await db.rpcHandlers.sign_log({ p_document: doc.id, p_type: "all_submitted", p_actor_type: "system" });
    return { data: { sealing: done, invited: [] }, error: null };
  };
  return { db, ctx, mail, advance: (ms: number) => void (nowMs += ms) };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  t = setup();
});

const META = { ip: "203.0.113.9", device: "Chrome", locale: "en" };
const events = (type?: string) => t.db.rows("sign_events").filter((e) => !type || e.type === type);

async function makeTemplate(form: FormDefinition = FORM) {
  const { template } = await createFormTemplate(t.ctx, { name: "E-invoice details" });
  await saveTemplateVersion(t.ctx, template.id, { fields: [], roles, form });
  await updateTemplate(t.ctx, template.id, { status: "active" });
  return template;
}

const people = (accounts = true) => [
  { roleKey: "applicant", kind: "signer" as const, fullName: "Ali bin Ahmad", email: "ali@kedairuncit.example", channel: "email" as const, orderNo: 1 },
  ...(accounts ? [{ roleKey: "accounts", kind: "signer" as const, fullName: "Siti Accounts", email: "siti@kedairuncit.example", channel: "email" as const, orderNo: 2 }] : []),
];

async function sentWorld(opts: { accounts?: boolean; contact?: boolean } = {}) {
  const template = await makeTemplate();
  const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id, ...(opts.contact === false ? {} : { contactId: "c1" }) });
  await setSigners(t.ctx, doc.id, people(opts.accounts ?? true));
  const sent = await sendDocument(t.ctx, doc.id);
  return { template, doc, sent, docId: doc.id };
}

async function look(role: RoleKey): Promise<Lookup> {
  const l = await lookupByToken(t.ctx.admin, TOK[role]);
  expect(l).not.toBeNull();
  return l!;
}

const pdf = () => makePdf([{ ...A4 }]);

async function fillApplicant() {
  await saveAnswers(t.ctx, await look("applicant"), { legalName: { text: "Kedai Runcit Ali Sdn Bhd" }, email: { text: "ali@kedairuncit.example" } });
  await saveAnswers(t.ctx, await look("applicant"), { tin: { text: "C20881234567" }, msic: { text: "47112" }, sst: { checked: true } });
  await uploadFile(t.ctx, await look("applicant"), { field: "extract", file: { bytes: await pdf(), name: "ssm-extract.pdf" } });
}

// ---- the template -------------------------------------------------------------------------------------------------------

describe("a template of mode form", () => {
  it("is made without a file, with one role that only fills in, and carries the mode on its version", async () => {
    const { template, version } = await createFormTemplate(t.ctx, { name: "E-invoice details" });
    expect(template.mode).toBe("form");
    expect(version.mode).toBe("form");
    expect(version.roles).toEqual([{ key: "applicant", label: "Applicant", kind: "filler", color: 0 }]);
    expect(version.fields).toEqual([]);
    expect(version.page_count).toBe(1);
    expect(t.db.files.has(version.source_path)).toBe(true);
  });

  it("cannot be made active before the form has a part, and then can", async () => {
    const { template } = await createFormTemplate(t.ctx, { name: "Details" });
    await expect(updateTemplate(t.ctx, template.id, { status: "active" })).rejects.toMatchObject({ code: "invalid_layout", issues: [{ code: "form_mode_needs_a_form" }] });
    await saveTemplateVersion(t.ctx, template.id, { fields: [], roles: [{ key: "applicant", label: "Applicant", kind: "filler", color: 0 }], form: { version: 1, parts: [{ key: "p", title: L("P"), role: "applicant" }], fields: [] } });
    expect((await updateTemplate(t.ctx, template.id, { status: "active" })).status).toBe("active");
  });

  it("refuses a signature, any place on the page, and a role that signs, with the reason", async () => {
    const { template } = await createFormTemplate(t.ctx, { name: "Details" });
    const sig: PlacedField = { key: "sig", type: "signature", role: "applicant", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.06, required: true };
    const text: PlacedField = { key: "txt", type: "text", role: "applicant", page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.04, required: false };
    await expect(saveTemplateVersion(t.ctx, template.id, { fields: [sig], roles, form: FORM })).rejects.toMatchObject({ code: "invalid_layout", issues: expect.arrayContaining([{ code: "form_mode_signature", field: "sig" }]) });
    await expect(saveTemplateVersion(t.ctx, template.id, { fields: [text], roles, form: FORM })).rejects.toMatchObject({ issues: expect.arrayContaining([{ code: "form_mode_placement", field: "txt" }]) });
    await expect(saveTemplateVersion(t.ctx, template.id, { fields: [], roles: [{ key: "applicant", label: "Merchant", kind: "signer", color: 0 }, roles[1]], form: FORM })).rejects.toMatchObject({ issues: expect.arrayContaining([{ code: "form_mode_signer_role", role: "applicant" }]) });
  });

  it("keeps its mode through a new version, a duplicate and 'save as template'", async () => {
    const template = await makeTemplate();
    const v2 = await saveTemplateVersion(t.ctx, template.id, { fields: [], roles, form: FORM });
    expect(v2.version.mode).toBe("form");
    const copy = await duplicateTemplate(t.ctx, template.id, "Copy");
    expect(copy.template.mode).toBe("form");
    expect(copy.version.mode).toBe("form");
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    const fromDoc = await createTemplateFromDocument(t.ctx, doc.id, { name: "From draft" });
    expect(fromDoc.template.mode).toBe("form");
  });

  it("leaves an agreement to sign exactly as it was: no mode column is written for it", async () => {
    const { template, version } = await createTemplateFromUpload(t.ctx, { bytes: await pdf(), filename: "Agreement.pdf", name: "Agreement" });
    expect(template.mode ?? "sign").toBe("sign");
    expect("mode" in (t.db.rows("sign_templates")[0] as object)).toBe(false);
    expect("mode" in (t.db.rows("sign_template_versions")[0] as object)).toBe(false);
    expect(version.mode ?? "sign").toBe("sign");
    const sig: PlacedField = { key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.06, required: true };
    const saved = await saveTemplateVersion(t.ctx, template.id, { fields: [sig], roles: [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }] });
    expect(saved.version.fields).toHaveLength(1);
  });
});

// ---- the document and sending ---------------------------------------------------------------------------------------------

describe("a document of mode form", () => {
  it("copies the mode from its template and makes everyone a person who fills in, whatever kind the caller asked for", async () => {
    const template = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    expect(doc.mode).toBe("form");
    expect(doc.base_path).toBeTruthy();
    expect(doc.fields_snapshot).toEqual([]);
    const rows = await setSigners(t.ctx, doc.id, people());
    expect(rows.map((r) => r.kind)).toEqual(["filler", "filler"]);
  });

  it("refuses a signature or a place on the page at the draft too", async () => {
    const template = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    const sig: PlacedField = { key: "sig", type: "signature", role: "applicant", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.06, required: true };
    await expect(updateDraft(t.ctx, doc.id, { fields: [sig] })).rejects.toMatchObject({ code: "invalid_layout", issues: expect.arrayContaining([{ code: "form_mode_signature", field: "sig" }]) });
  });

  it("is sent with nobody signing: only a person to fill each part is needed, and the send counts as a document sent", async () => {
    const template = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    await setSigners(t.ctx, doc.id, people(false));
    // the "accounts" part has nobody
    await expect(sendDocument(t.ctx, doc.id)).rejects.toMatchObject({ code: "not_ready", issues: expect.arrayContaining([{ code: "part_without_person", part: "bank", role: "accounts" }]) });
    await setSigners(t.ctx, doc.id, people());
    const before = t.db.rpcCalls.filter((c) => c.name === "account_usage").length;
    const sent = await sendDocument(t.ctx, doc.id);
    expect(sent.invited.map((i) => i.roleKey).sort()).toEqual(["accounts", "applicant"]);
    // the monthly limit is checked through the same call as for an agreement
    expect(t.db.rpcCalls.filter((c) => c.name === "account_usage").length).toBeGreaterThan(before);
    expect(t.db.rows("sign_documents")[0].status).toBe("sent");
  });

  it("is not sent without a form, and has nobody on the list reported as a person missing, not a signer", async () => {
    const template = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    Object.assign(t.db.rows("sign_documents")[0], { form_snapshot: null });
    const err = await sendDocument(t.ctx, doc.id).catch((e) => e);
    expect(err).toMatchObject({ code: "not_ready" });
    expect(err.issues.map((i: { code: string }) => i.code)).toContain("form_mode_needs_a_form");
    expect(err.issues.map((i: { code: string }) => i.code)).toContain("no_person");
    expect(err.issues.map((i: { code: string }) => i.code)).not.toContain("no_signer");
    expect(err.issues.map((i: { code: string }) => i.code)).not.toContain("signer_without_signature");
  });

  it("invites with 'complete your details', never 'sign'", async () => {
    await sentWorld();
    const toApplicant = t.mail.find((m) => m.to === "ali@kedairuncit.example")!;
    expect(toApplicant.subject).toBe("Please complete your details: E-invoice details");
    expect(toApplicant.text).toContain("There is nothing to sign.");
    expect(toApplicant.text).toContain("Complete your details: https://halo.test/s/" + TOK.applicant);
    expect(toApplicant.text.toLowerCase()).not.toContain("review and sign");
  });

  it("is stored as a form, and its creation is in the trail", async () => {
    await sentWorld();
    expect(events("created")).toHaveLength(1);
    expect(t.db.rows("sign_documents")[0].mode).toBe("form");
  });
});

// ---- the person's page --------------------------------------------------------------------------------------------------------

describe("the page of a person who fills in and submits", () => {
  it("says it is a form, asks to agree to submit, and shows only their parts", async () => {
    await sentWorld();
    const view = await buildView(t.ctx, await look("applicant"), false);
    expect(view.document.mode).toBe("form");
    expect(view.consent.text).toContain("submit this form");
    expect(view.consent.text).not.toContain("signature");
    expect(view.consent.version).toBe("default-form-v1-en");
    expect(view.content!.form!.partKeys).toEqual(["company", "einvoice"]);
    expect(view.content!.form!.definition.fields.map((f) => f.key)).not.toContain("accountNo");
    const ms = (await buildView(t.ctx, { ...(await look("applicant")), doc: { ...(await look("applicant")).doc, locale: "ms" } }, false)).consent.text;
    expect(ms).toContain("menghantar borang");
  });

  it("uses the workspace's own consent wording when it has set one, for a form too", async () => {
    await sentWorld();
    Object.assign(t.db.rows("sign_settings")[0], { consent_texts: { en: "Our own wording." } });
    const view = await buildView(t.ctx, await look("applicant"), false);
    expect(view.consent.text).toBe("Our own wording.");
    expect(view.consent.version.startsWith("custom-en-")).toBe(true);
  });

  it("hands out no document to read before it is complete (the base file is only a stand-in)", async () => {
    await sentWorld();
    expect(await fileForSigner(t.ctx, await look("applicant"), true)).toBeNull();
  });

  it("goes to review with every answer printed nowhere, since nothing is printed on a page", async () => {
    await sentWorld();
    await fillApplicant();
    const review = await reviewFor(t.ctx, await look("applicant"));
    expect(review).toEqual({ printed: {}, fitProblems: [] });
  });

  it("records the agreement in words that say submit", async () => {
    await sentWorld();
    t.db.rpcHandlers.sign_record_consent = async () => ({ data: true, error: null });
    await recordConsent(t.ctx, await look("applicant"), "en", null, null);
    expect(t.db.rpcCalls.find((c) => c.name === "sign_record_consent")!.args.p_version).toBe("default-form-v1-en");
  });
});

// ---- submitting, write-back and the record --------------------------------------------------------------------------------------

async function sealWith(docId: string) {
  const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
  t.db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
  t.db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: docId, account_id: ACCT }], error: null });
  t.db.rpcHandlers.sign_finish_sealing = async (a) => {
    Object.assign(t.db.rows("sign_documents")[0], { status: "completed", final_path: a.p_final_path, final_sha256: a.p_final_sha256, completed_at: new Date().toISOString() });
    return { data: {}, error: null };
  };
  t.db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });
  const out = await runSealing({ admin: t.ctx.admin, origin: t.ctx.origin, deps: t.ctx.deps, now: t.ctx.now }, 2);
  const fin = t.db.rpcCalls.find((c) => c.name === "sign_finish_sealing");
  return { out, bytes: fin ? t.db.files.get(fin.args.p_final_path as string)! : null, sha256: fin ? (fin.args.p_final_sha256 as string) : null };
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) for (const it of (await (await doc.getPage(i)).getTextContent()).items) if ("str" in it) out.push(it.str);
  return out.join(" ").replace(/\s+/g, " ");
}

describe("submitting a form without a signature", () => {
  it("takes the parts over several sittings, autosaves, and refuses to submit while a required answer is missing", async () => {
    await sentWorld();
    await saveAnswers(t.ctx, await look("applicant"), { legalName: { text: "Kedai Runcit Ali Sdn Bhd" } });
    // a second sitting: what was saved is still there
    const again = await buildView(t.ctx, await look("applicant"), false);
    expect(again.content!.form!.answers.legalName).toEqual({ text: "Kedai Runcit Ali Sdn Bhd" });
    await expect(completeSigning(t.ctx, await look("applicant"), {}, META)).rejects.toMatchObject({ code: "missing_required" });
    expect(t.db.rows("sign_signers").find((s) => s.role_key === "applicant")!.status).toBe("sent");
  });

  it("completes when everyone has submitted: the person is done, the document waits for the other, then goes to sealing", async () => {
    await sentWorld();
    await fillApplicant();
    const first = await completeSigning(t.ctx, await look("applicant"), {}, META);
    expect(first.sealing).toBe(false);
    expect(t.db.rows("sign_documents")[0].status).toBe("in_progress");
    expect(events("submitted")).toHaveLength(1);
    await saveAnswers(t.ctx, await look("accounts"), { accountNo: { text: "1234567890" } });
    const last = await completeSigning(t.ctx, await look("accounts"), {}, META);
    expect(last.sealing).toBe(true);
    expect(t.db.rows("sign_documents")[0].status).toBe("sealing");
    expect(events("all_submitted")).toHaveLength(1);
  });
});

describe("a form of one person, end to end", () => {
  const ONE: FormDefinition = { version: 1, parts: FORM.parts.slice(0, 2), fields: FORM.fields.filter((f) => f.part !== "bank") };

  async function oneWorld() {
    const template = await makeTemplate(ONE);
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id, contactId: "c1" });
    await setSigners(t.ctx, doc.id, people(false));
    await sendDocument(t.ctx, doc.id);
    return doc.id;
  }

  it("writes the contact, seals a record that verifies, masks the sensitive answer, and tells everyone it was submitted", async () => {
    const docId = await oneWorld();
    await fillApplicant();
    const done = await completeSigning(t.ctx, await look("applicant"), {}, META);
    expect(done.sealing).toBe(true);

    // write-back: the confirmed company and the empty-only email
    const contact = t.db.rows("contacts")[0];
    expect(contact.company).toBe("Kedai Runcit Ali Sdn Bhd");
    expect(contact.email).toBe("ali@old.example"); // "if empty": the contact had one
    expect(events("writeback").length).toBeGreaterThan(0);

    const sealed = await sealWith(docId);
    expect(sealed.out).toEqual({ claimed: 1, completed: 1, retry: 0 });
    const doc = t.db.rows("sign_documents")[0];
    expect(doc.status).toBe("completed");
    expect(doc.final_path).toBeTruthy();

    // the sealed file is the record plus the certificate pages, and checks out
    const verified = verifySealed(sealed.bytes!);
    expect(verified.ok).toBe(true);
    expect(verified.sha256).toBe(sealed.sha256);
    const text = await textOf(sealed.bytes!);
    expect(text).toContain("Submission record");
    expect(text).toContain("Company details");
    expect(text).toContain("Kedai Runcit Ali Sdn Bhd");
    expect(text).toContain("47112");
    expect(text).toContain("Yes");
    // the sensitive answer is a mask, never the value
    expect(text).toContain("**** 4567");
    expect(text).not.toContain("C20881234567");
    // the file is listed with its fingerprint
    const upload = t.db.rows("sign_document_files").find((f) => f.kind === "signer_upload")!;
    expect(text.replace(/\s/g, "")).toContain(String(upload.sha256));
    expect(text).toContain("ssm-extract.pdf");
    // the certificate says submission, not signing
    expect(text).toContain("Certificate of Submission");
    expect(text).toContain("Ali bin Ahmad submitted their details");
    expect(text).toContain("Everyone had submitted");
    expect(text).not.toContain("Certificate of Completion");

    // the record is the document's final file and is kept like any other
    expect(t.db.rows("sign_document_files").find((f) => f.kind === "signed")!.name).toBe("SGN-2026-000777-record.pdf");

    // the submitter and the sender were told, with the record attached
    const toApplicant = t.mail.find((m) => m.to === "ali@kedairuncit.example" && m.subject.startsWith("Received"))!;
    expect(toApplicant.subject).toBe("Received: E-invoice details");
    expect(toApplicant.attachments).toEqual(["SGN-2026-000777-record.pdf"]);
    expect(toApplicant.text).toContain("A record of what was submitted is attached");
    expect(t.mail.some((m) => m.to === "gokula@vircle.example" && m.subject.startsWith("Received"))).toBe(true);
    expect(t.mail.some((m) => /Signed:/.test(m.subject))).toBe(false);

    // and what the person is given afterwards is the record
    const file = await fileForSigner(t.ctx, await look("applicant"), true);
    expect(file).toMatchObject({ kind: "final", filename: "SGN-2026-000777-record.pdf" });
  });

  it("keeps the sensitive answer out of everything but its own ciphertext", async () => {
    await oneWorld();
    await fillApplicant();
    const stored = JSON.stringify(t.db.rows("sign_answers"));
    expect(stored).not.toContain("C20881234567");
    expect(t.db.rows("sign_answers").find((a) => a.field_key === "tin")!.value_enc).toBeTruthy();
    expect(JSON.stringify(t.db.rows("sign_events"))).not.toContain("C20881234567");
  });

  it("hands the record to the outbound event as a form", async () => {
    const docId = await oneWorld();
    await fillApplicant();
    await completeSigning(t.ctx, await look("applicant"), {}, META);
    const { buildSignEventData } = await import("./outbound");
    const doc = t.db.rows("sign_documents").find((d) => d.id === docId)!;
    const data = buildSignEventData(doc as never, t.db.rows("sign_signers") as never, "completed", "https://halo.test", { templateId: null, templateName: null, categoryName: null });
    expect(data.mode).toBe("form");
  });
});

// ---- the one thing that is not a form: an agreement to sign is unchanged -----------------------------------------------------

describe("an agreement to sign next to it", () => {
  it("is still sent only with a signer and a signature, with the words it always had", async () => {
    const { template } = await createTemplateFromUpload(t.ctx, { bytes: await pdf(), filename: "Agreement.pdf", name: "Agreement" });
    const merchant: SignRole = { key: "merchant", label: "Merchant", kind: "signer", color: 0 };
    const sig: PlacedField = { key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.06, required: true };
    await saveTemplateVersion(t.ctx, template.id, { fields: [sig], roles: [merchant] });
    await updateTemplate(t.ctx, template.id, { status: "active" });
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    expect(doc.mode ?? "sign").toBe("sign");
    await setSigners(t.ctx, doc.id, [{ roleKey: "merchant", kind: "signer", fullName: "Ali", email: "ali@example.test", channel: "email", orderNo: 1 }]);
    t.db.rpcHandlers.sign_send_document = async (args) => {
      const row = t.db.rows("sign_documents").find((x) => x.id === args.p_document)!;
      Object.assign(row, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, reference: "SGN-2026-000778" });
      const invited = t.db.rows("sign_signers").map((p) => ({ signer_id: p.id, token: "d".repeat(64), name: p.full_name, email: p.email, phone: null, channel: p.channel, role_key: p.role_key, kind: p.kind, order_no: 1 }));
      return { data: { reference: "SGN-2026-000778", invited }, error: null };
    };
    await sendDocument(t.ctx, doc.id);
    const mailed = t.mail[0];
    expect(mailed.subject).toBe("Gokula asked you to sign: Agreement");
    expect(mailed.text).toContain("Review and sign:");
    expect(mailed.text).not.toContain("complete your details");
  });
});
