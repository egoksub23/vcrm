import { createHash } from "node:crypto";

import { getDocumentProxy } from "unpdf";
import { beforeEach, describe, expect, it } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { FormDefinition, L10n } from "../forms";
import type { NotifyDeps } from "../notify";
import { A4, makePdf, scribblePng } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import { verifySealed } from "../pdf/verify";
import { hashToken } from "../tokens";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { SignError } from "./errors";
import { FakeDb } from "./fake-db";
import { createDraftFromTemplate, createDraftFromUpload, setSigners, updateDraft } from "./drafts";
import { loadProgress, extendExpiry, uploadedFileForStaff } from "./progress";
import { reviewFor } from "./review";
import { runSealing, valuesFor } from "./seal";
import { remindSigner, sendDocument } from "./send";
import { buildView, completeSigning, lookupByToken, saveAnswers, type Lookup } from "./signing";
import { createTemplateFromDocument, createTemplateFromUpload, duplicateTemplate, saveTemplateVersion, updateTemplate } from "./templates";
import { detectKind, readOwnUpload, removeUpload, uploadFile } from "./uploads";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TOK = { merchant: "a".repeat(64), finance: "b".repeat(64), director: "c".repeat(64) } as const;
type RoleKey = keyof typeof TOK;

// ---- the form under test ----------------------------------------------------------------------------------

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });
const sst = { op: "eq", field: "taxType", value: "sst" } as const;

const FORM: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company details", "Butiran syarikat"), role: "merchant" },
    { key: "tax", title: L("Tax"), role: "merchant" },
    { key: "bank", title: L("Bank account", "Akaun bank"), role: "finance" },
  ],
  fields: [
    { key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true, contactField: "company", writeBack: "always" },
    { key: "contactEmail", type: "email", part: "company", label: L("Email"), required: true, contactField: "email", writeBack: "if_empty" },
    { key: "bizType", type: "choice", part: "company", label: L("Business type"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.") }, { value: "sole", label: L("Sole proprietor", "Pemilik tunggal") }] },
    { key: "brn", type: "text", part: "company", label: L("Registration no."), required: true, format: "digits", minLength: 8, maxLength: 12 },
    { key: "country", type: "text", part: "company", label: L("Country"), required: false, defaultValue: "Malaysia" },
    { key: "ref", type: "text", part: "company", label: L("Reference"), required: false, locked: true, defaultValue: "REF-2026-001" },
    { key: "ssm", type: "file", part: "company", label: L("Company extract"), required: true, accept: ["pdf", "jpg"], maxMb: 1, maxFiles: 2 },
    { key: "notes", type: "multiline", part: "company", label: L("Notes"), required: false, maxLength: 500 },
    { key: "taxType", type: "choice", part: "tax", label: L("Tax type"), required: false, options: [{ value: "sst", label: L("SST") }, { value: "na", label: L("Not applicable", "Tidak berkaitan") }] },
    { key: "taxPct", type: "number", part: "tax", label: L("Tax %"), required: false, visibleIf: sst, requiredIf: sst, min: 0, max: 100, decimals: 2 },
    { key: "taxCert", type: "file", part: "tax", label: L("Tax certificate"), required: false, accept: ["pdf"], maxMb: 2, visibleIf: sst },
    { key: "region", type: "text", part: "tax", label: L("Region"), required: false, contactField: "custom:Region", writeBack: "always" },
    { key: "accountNo", type: "text", part: "bank", label: L("Account number"), required: true, format: "digits" },
    { key: "accountNote", type: "text", part: "bank", label: L("Account note"), required: false, visibleIf: { op: "eq", field: "bizType", value: "sdn_bhd" } },
  ],
};

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance", kind: "filler", color: 1 },
  { key: "director", label: "Director", kind: "signer", color: 2 },
];

const bound = (key: string, type: PlacedField["type"], data: string, y: number, over: Partial<PlacedField> = {}): PlacedField => ({ key, type, role: "sender", page: 0, x: 0.1, y, w: 0.5, h: 0.04, required: false, data, ...over });
const fields: PlacedField[] = [
  bound("p_legal", "text", "legalName", 0.1),
  bound("p_biz", "text", "bizType", 0.15),
  bound("p_brn", "text", "brn", 0.2),
  bound("p_sst", "checkbox", "taxType", 0.25, { dataValue: "sst", w: 0.03, h: 0.03 }),
  bound("p_pct", "number", "taxPct", 0.3),
  bound("p_acct", "text", "accountNo", 0.35),
  bound("p_notes", "text", "notes", 0.4, { multiline: true, w: 0.1, h: 0.02 }),
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.5, w: 0.4, h: 0.08, required: true },
  { key: "mname", type: "name", role: "merchant", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.04, required: true },
  { key: "mdate", type: "date_signed", role: "merchant", page: 0, x: 0.55, y: 0.5, w: 0.3, h: 0.04, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.7, w: 0.4, h: 0.08, required: true },
];

// ---- the world ---------------------------------------------------------------------------------------------

interface Mail {
  to: string;
  subject: string;
  text: string;
}

function setup() {
  const db = new FakeDb();
  const mail: Mail[] = [];
  let nowMs = Date.parse("2026-10-06T08:00:00Z");
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject, text: a.text }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date(nowMs) };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("contacts", [
    { id: "c1", account_id: ACCT, name: "Ali bin Ahmad", email: "ali@old.example", company: "Kedai Runcit Ali", deleted_at: null },
    { id: "c-other", account_id: "someone-else", name: "Not ours", email: "x@y.example", company: "Other Co", deleted_at: null },
  ]);
  db.seed("custom_fields", [{ id: "cf1", account_id: ACCT, field_name: "Region" }]);
  db.seed("contact_custom_values", [{ id: "cv1", contact_id: "c1", custom_field_id: "cf1", value: "Selangor" }]);

  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  db.rpcHandlers.sign_log = async (a) => {
    const seq = db.rows("sign_events").filter((e) => e.document_id === a.p_document).length + 1;
    db.seed("sign_events", [{ account_id: ACCT, document_id: a.p_document, doc_seq: seq, type: a.p_type, actor_type: a.p_actor_type, signer_id: a.p_signer, detail: a.p_detail ?? {}, row_hash: seq.toString(16).padStart(64, "0"), created_at: new Date(nowMs).toISOString() }]);
    return { data: null, error: null };
  };
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
    const done = db.rows("sign_signers").filter((x) => x.document_id === doc.id).every((x) => x.status === "signed");
    doc.status = done ? "sealing" : "in_progress";
    return { data: { sealing: done, invited: [] }, error: null };
  };
  return { db, ctx, mail, advance: (ms: number) => void (nowMs += ms) };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  t = setup();
});

async function makeTemplate(extra: { fields?: PlacedField[] } = {}) {
  const { template } = await createTemplateFromUpload(t.ctx, { bytes: await makePdf([{ ...A4 }]), filename: "Merchant Form.pdf", name: "Merchant form" });
  const saved = await saveTemplateVersion(t.ctx, template.id, { fields: extra.fields ?? fields, roles, form: FORM });
  await updateTemplate(t.ctx, template.id, { status: "active" });
  return { template, ...saved };
}

const person = (roleKey: RoleKey, over: Record<string, unknown> = {}) => ({
  roleKey,
  kind: (roleKey === "finance" ? "filler" : "signer") as "filler" | "signer",
  fullName: { merchant: "Ali bin Ahmad", finance: "Siti Finance", director: "Gokula" }[roleKey],
  email: { merchant: "ali@kedairuncit.example", finance: "siti@kedairuncit.example", director: "g@vircle.example" }[roleKey],
  channel: "email" as const,
  orderNo: { merchant: 1, finance: 2, director: 3 }[roleKey],
  ...over,
});

/** A form document, sent, with the three people holding live links. */
async function sentWorld() {
  const { template } = await makeTemplate();
  const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id, contactId: "c1" });
  await setSigners(t.ctx, doc.id, [person("merchant"), person("finance"), person("director")]);
  const sent = await sendDocument(t.ctx, doc.id);
  return { template, doc, sent, docId: doc.id };
}

async function look(role: RoleKey): Promise<Lookup> {
  const l = await lookupByToken(t.ctx.admin, TOK[role]);
  expect(l).not.toBeNull();
  return l!;
}

const events = (type?: string) => t.db.rows("sign_events").filter((e) => !type || e.type === type);
const answerRow = (key: string, role: RoleKey = "merchant") => t.db.rows("sign_answers").find((a) => a.field_key === key && t.db.rows("sign_signers").find((s) => s.id === a.signer_id)?.role_key === role);
const META = { ip: "203.0.113.9", device: "Chrome", locale: "en" };

const pdfBytes = () => makePdf([{ ...A4 }]);
const NO_PATH = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(`account-${ACCT}`);
  expect(text).not.toContain("/upload/");
  expect(text).not.toContain('"path"');
};

/** Fill the merchant's required answers (the company extract included). */
async function fillMerchant(over: Record<string, { text: string }> = {}) {
  // what the contact would have started (when the page was opened) is only entered here when it has not been
  const own = { ...(answerRow("legalName") ? {} : { legalName: { text: "Kedai Runcit Ali" } }), ...(answerRow("contactEmail") ? {} : { contactEmail: { text: "ali@old.example" } }) };
  await saveAnswers(t.ctx, await look("merchant"), { bizType: { text: "sdn_bhd" }, brn: { text: "20190123456" }, ...own, ...over });
  await uploadFile(t.ctx, await look("merchant"), { field: "ssm", file: { bytes: await pdfBytes(), name: "Company Extract (final).pdf" } });
}

// ---- carrying the form -----------------------------------------------------------------------------------------

describe("carrying the form from template to document", () => {
  it("saves a template version with its form, returns warnings, and keeps or removes the form as asked", async () => {
    const { template, version, warnings } = await makeTemplate();
    expect(version.form).toEqual(FORM);
    expect(warnings).toEqual([]);

    const kept = await saveTemplateVersion(t.ctx, template.id, { fields, roles });
    expect(kept.version.form).toEqual(FORM);
    expect(kept.version.version_no).toBe(version.version_no + 1);

    const removed = await saveTemplateVersion(t.ctx, template.id, { fields: fields.filter((f) => !f.data), roles, form: null });
    expect(removed.version.form ?? null).toBeNull();
    // and a later save without a form keeps there being none
    expect((await saveTemplateVersion(t.ctx, template.id, { fields: fields.filter((f) => !f.data), roles })).version.form ?? null).toBeNull();
  });

  it("refuses an unsound form or a placement that prints nothing real, with the issues", async () => {
    const { template } = await makeTemplate();
    const brokenForm: FormDefinition = { ...FORM, fields: [...FORM.fields, { key: "stray", type: "text", part: "nowhere", label: L("Stray"), required: false }] };
    await expect(saveTemplateVersion(t.ctx, template.id, { fields, roles, form: brokenForm })).rejects.toMatchObject({ code: "invalid_layout", issues: expect.arrayContaining([expect.objectContaining({ code: "data_unknown_part", field: "stray" })]) });
    await expect(saveTemplateVersion(t.ctx, template.id, { fields: [...fields, bound("p_ghost", "text", "ghost", 0.8)], roles })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: "placement_unknown_data", field: "p_ghost" })]) });
    // a part for a role the template does not have
    await expect(saveTemplateVersion(t.ctx, template.id, { fields: fields.filter((f) => f.role !== "director"), roles: roles.slice(0, 1) })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: "part_unknown_role" })]) });
    // placements that bind data with no form at all
    await expect(saveTemplateVersion(t.ctx, template.id, { fields, roles, form: null })).rejects.toMatchObject({ code: "invalid_layout", issues: expect.arrayContaining([expect.objectContaining({ code: "placement_unknown_data" })]) });
  });

  it("warns, never blocks, when fixed text cannot fit its box", async () => {
    const { template } = await makeTemplate();
    const fixed: PlacedField = { key: "fixed", type: "static_text", role: "sender", text: "x ".repeat(450), page: 0, x: 0.1, y: 0.9, w: 0.05, h: 0.01, required: false };
    const r = await saveTemplateVersion(t.ctx, template.id, { fields: [...fields, fixed], roles });
    expect(r.warnings).toEqual([{ code: "static_text_does_not_fit", field: "fixed" }]);
    expect(r.version.fields).toHaveLength(fields.length + 1);
  });

  it("copies the form to a draft, a duplicate and a template made from a document", async () => {
    const { template } = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id, contactId: "c1" });
    expect(doc.form_snapshot).toEqual(FORM);
    const dup = await duplicateTemplate(t.ctx, template.id, "Copy");
    expect(dup.version.form).toEqual(FORM);
    const fromDoc = await createTemplateFromDocument(t.ctx, doc.id, { name: "From draft" });
    expect(fromDoc.version.form).toEqual(FORM);
  });

  it("does not let a draft edit the form, and still checks the placements against it", async () => {
    const { template } = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    const after = await updateDraft(t.ctx, doc.id, { title: "Changed", form: null } as never);
    expect(after.title).toBe("Changed");
    expect(after.form_snapshot).toEqual(FORM);
    await expect(updateDraft(t.ctx, doc.id, { fields: [...fields, bound("p_ghost", "text", "ghost", 0.8)] })).rejects.toMatchObject({ code: "invalid_layout", issues: expect.arrayContaining([expect.objectContaining({ code: "placement_unknown_data" })]) });
    await expect(updateDraft(t.ctx, doc.id, { fields: fields.map((f) => (f.key === "p_pct" ? { ...f, type: "signature" as const } : f)) })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: "placement_type_mismatch" })]) });
  });

  it("gives a draft from an upload no form, and refuses a bound placement on it", async () => {
    const { document } = await createDraftFromUpload(t.ctx, { bytes: await pdfBytes(), filename: "plain.pdf" });
    expect(document.form_snapshot ?? null).toBeNull();
    await expect(updateDraft(t.ctx, document.id, { roles, fields })).rejects.toMatchObject({ code: "invalid_layout", issues: expect.arrayContaining([expect.objectContaining({ code: "placement_unknown_data" })]) });
  });
});

// ---- sending ---------------------------------------------------------------------------------------------------------

describe("sending a form document", () => {
  it("refuses to send while a part has nobody to complete it", async () => {
    const { template } = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    await setSigners(t.ctx, doc.id, [person("merchant"), person("director")]);
    const err = await sendDocument(t.ctx, doc.id).catch((e) => e);
    expect(err).toBeInstanceOf(SignError);
    expect(err).toMatchObject({ code: "not_ready", issues: expect.arrayContaining([{ code: "part_without_person", part: "bank", role: "finance" }]) });
  });

  it("invites the filler like any signer, asking them to complete rather than sign", async () => {
    const { sent } = await sentWorld();
    expect(sent.invited.map((i) => i.roleKey).sort()).toEqual(["director", "finance", "merchant"]);
    const toFinance = t.mail.find((m) => m.to === "siti@kedairuncit.example")!;
    expect(toFinance.subject).toContain("complete");
    expect(toFinance.text).toContain(`https://halo.test/s/${TOK.finance}`);
    const toMerchant = t.mail.find((m) => m.to === "ali@kedairuncit.example")!;
    expect(toMerchant.subject).toContain("sign");
  });
});

// ---- the signer's view and prefill ----------------------------------------------------------------------------------

describe("the signer's view of a form", () => {
  it("starts unanswered fields from the contact and the defaults the first time, and shows only this signer's parts", async () => {
    await sentWorld();
    const l = await look("merchant");
    const view = await buildView(t.ctx, l, false);
    const form = view.content!.form!;
    expect(form.partKeys).toEqual(["company", "tax"]);
    expect(form.definition.parts.map((p) => p.key)).toEqual(["company", "tax"]);
    // nothing of the finance part or of any field of it
    expect(form.definition.fields.map((f) => f.key)).not.toContain("accountNo");
    expect(Object.keys(form.answers).sort()).toEqual(["contactEmail", "country", "legalName", "ref", "region"]);
    expect(form.answers.legalName).toEqual({ text: "Kedai Runcit Ali" });
    expect(form.answers.contactEmail).toEqual({ text: "ali@old.example" });
    expect(form.answers.region).toEqual({ text: "Selangor" });
    expect(form.answers.country).toEqual({ text: "Malaysia" });
    // contact answers wait for confirmation; the sender's default does not
    expect([...form.unconfirmed].sort()).toEqual(["contactEmail", "legalName", "region"]);
    expect(answerRow("legalName")).toMatchObject({ source: "contact" });
    expect(answerRow("country")).toMatchObject({ source: "sender" });
    expect(form.progress.find((p) => p.key === "company")).toMatchObject({ state: "in_progress", done: 2, total: 5 });
    expect(form.ready).toBe(false);
    // data answers are never placed-field answers
    expect(Object.keys(view.content!.answers)).toEqual([]);
    // the merchant's own places and the places that print the form's answers, not the director's place
    expect(view.content!.fields).toHaveLength(fields.length - 1);
    expect(view.content!.fields.map((f) => f.key)).not.toContain("dsig");
    NO_PATH(view);
  });

  it("is idempotent, never overwrites an answer, and does not start again once the page was opened", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await saveAnswers(t.ctx, await look("merchant"), { legalName: { text: "Changed Sdn Bhd" } });
    await buildView(t.ctx, await look("merchant"), false);
    expect(t.db.rows("sign_answers").filter((a) => a.field_key === "legalName")).toHaveLength(1);
    expect(answerRow("legalName")).toMatchObject({ value: { text: "Changed Sdn Bhd" }, source: "signer" });

    // a person whose page was already opened is not prefilled afterwards
    t.db.tables.sign_answers = [];
    Object.assign(t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!, { viewed_at: "2026-10-06T08:00:00Z" });
    const again = await buildView(t.ctx, await look("merchant"), false);
    expect(again.content!.form!.answers).toEqual({});
  });

  it("skips an empty contact value and one the field would not accept", async () => {
    await sentWorld();
    Object.assign(t.db.rows("contacts").find((c) => c.id === "c1")!, { company: "  ", email: "not an email" });
    t.db.tables.contact_custom_values = [];
    const form = (await buildView(t.ctx, await look("merchant"), false)).content!.form!;
    expect(Object.keys(form.answers).sort()).toEqual(["country", "ref"]);
  });

  it("shows a signer with no parts no form, and a filler only their own parts plus the facts their rules need", async () => {
    await sentWorld();
    expect((await buildView(t.ctx, await look("director"), false)).content!.form).toBeNull();

    await saveAnswers(t.ctx, await look("merchant"), { bizType: { text: "sdn_bhd" }, legalName: { text: "Secret Holdings Sdn Bhd" } });
    const fin = (await buildView(t.ctx, await look("finance"), false)).content!.form!;
    expect(fin.partKeys).toEqual(["bank"]);
    // the filler's field refers to the business type, so that field and its answer come along, nothing else of the merchant
    expect(fin.definition.fields.map((f) => f.key).sort()).toEqual(["accountNo", "accountNote", "bizType"]);
    expect(Object.keys(fin.answers)).toEqual(["bizType"]);
    expect(JSON.stringify(fin)).not.toContain("Secret");
    NO_PATH(fin);
  });

  it("never gives one person another's answers through the placed-field answers", async () => {
    await sentWorld();
    await saveAnswers(t.ctx, await look("merchant"), { bizType: { text: "sdn_bhd" }, brn: { text: "20190123456" } });
    await uploadFile(t.ctx, await look("merchant"), { field: "ssm", file: { bytes: await pdfBytes(), name: "x.pdf" } });
    Object.assign(t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!, { status: "signed" });
    const dir = await buildView(t.ctx, await look("director"), false);
    expect(dir.content!.othersAnswers).toEqual({});
    expect(dir.content!.answers).toEqual({});
    expect(JSON.stringify(dir)).not.toContain("20190123456");
    NO_PATH(dir);
  });
});

// ---- saving answers ----------------------------------------------------------------------------------------------------

describe("saving answers to the form", () => {
  it("saves valid answers, and rejects the rest with a code, whatever the key", async () => {
    await sentWorld();
    const r = await saveAnswers(t.ctx, await look("merchant"), {
      bizType: { text: "sdn_bhd" },
      legalName: { text: "  Kedai Runcit Ali Sdn Bhd " },
      brn: { text: "123" },
      accountNo: { text: "1" },
      taxPct: { text: "6" },
      ref: { text: "tampered" },
      ssm: { text: "x" },
      nothing: { text: "x" },
    });
    expect(r.saved).toEqual(["bizType", "legalName"]);
    const byField = Object.fromEntries(r.rejected.map((x) => [x.field, x]));
    expect(byField.brn).toEqual({ field: "brn", code: "text_too_short", detail: "8" });
    expect(byField.accountNo.code).toBe("not_your_field"); // another role's field
    expect(byField.nothing.code).toBe("not_your_field");
    expect(byField.taxPct.code).toBe("not_shown"); // shown only for SST
    expect(byField.ref.code).toBe("locked");
    expect(byField.ssm.code).toBe("use_upload");
    expect(answerRow("legalName")).toMatchObject({ value: { text: "Kedai Runcit Ali Sdn Bhd" }, source: "signer" });
    expect(answerRow("accountNo")).toBeUndefined();
    expect(r.progress).toBeDefined();
    expect(r.ready).toBe(false);
    expect(r.unconfirmed).toEqual(expect.not.arrayContaining(["legalName"]));
    NO_PATH(r);
  });

  it("accepts a field in the same batch as the answer that shows it, and then hides it with it", async () => {
    await sentWorld();
    const ok = await saveAnswers(t.ctx, await look("merchant"), { taxType: { text: "sst" }, taxPct: { text: "6" } });
    expect(ok).toMatchObject({ saved: ["taxType", "taxPct"], rejected: [] });
    // the same field in a batch that hides it is refused
    const no = await saveAnswers(t.ctx, await look("merchant"), { taxType: { text: "na" }, taxPct: { text: "8" } });
    expect(no.saved).toEqual(["taxType"]);
    expect(no.rejected).toEqual([{ field: "taxPct", code: "not_shown" }]);
    expect(answerRow("taxPct")).toMatchObject({ value: { text: "6" } });
  });

  it("clears an answer when it is emptied, and keeps a placed field's answers working beside the form", async () => {
    await sentWorld();
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123456" }, msig: { typed: "Ali" } });
    expect(answerRow("brn")).toBeDefined();
    expect(answerRow("msig")).toMatchObject({ value: { typed: "Ali" } });
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "" } });
    expect(answerRow("brn")).toBeUndefined();
  });

  it("writes part events when a part becomes done or stops being done, and never a value", async () => {
    await sentWorld();
    await fillMerchant();
    expect(events("part_completed").map((e) => e.detail)).toEqual([{ part: "company" }]);
    expect((await buildView(t.ctx, await look("merchant"), false)).content!.form!.progress.find((p) => p.key === "company")!.state).toBe("done");
    // the answer that keeps it done is removed: reopened
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "" } });
    expect(events("part_reopened").map((e) => e.detail)).toEqual([{ part: "company" }]);
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123456" } });
    expect(events("part_completed")).toHaveLength(2);
    const trail = JSON.stringify(t.db.rows("sign_events").map((e) => e.detail));
    for (const secret of ["Kedai", "20190123456", "ali@old.example", "Selangor"]) expect(trail).not.toContain(secret);
  });

  it("logs a saved event at most once every five minutes per person", async () => {
    await sentWorld();
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123456" } });
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123457" } });
    expect(events("saved")).toHaveLength(1);
    t.advance(4 * 60_000);
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123458" } });
    expect(events("saved")).toHaveLength(1);
    t.advance(2 * 60_000);
    await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123459" } });
    expect(events("saved")).toHaveLength(2);
    // another person has their own clock
    await saveAnswers(t.ctx, await look("finance"), { accountNo: { text: "1234567890" } });
    expect(events("saved")).toHaveLength(3);
    // a save that saved nothing leaves no trace
    t.advance(10 * 60_000);
    await saveAnswers(t.ctx, await look("merchant"), { accountNo: { text: "1" } });
    expect(events("saved")).toHaveLength(3);
  });

  it("confirms the contact's answers of a part as the signer's own, and only for their own parts", async () => {
    await sentWorld();
    const v = await buildView(t.ctx, await look("merchant"), false);
    expect([...v.content!.form!.unconfirmed].sort()).toEqual(["contactEmail", "legalName", "region"]);
    const r = await saveAnswers(t.ctx, await look("merchant"), {}, { confirmParts: ["company", "bank", "ghost"] });
    expect(r.rejected).toEqual([{ field: "bank", code: "not_your_part" }, { field: "ghost", code: "not_your_part" }]);
    expect(r.unconfirmed).toEqual(["region"]); // the tax part was not confirmed
    expect(answerRow("legalName")).toMatchObject({ source: "signer" });
    expect(answerRow("region")).toMatchObject({ source: "contact" });
    // the sender's defaults are not touched
    expect(answerRow("country")).toMatchObject({ source: "sender" });
  });

  it("needs the signer to have agreed, and an open document", async () => {
    await sentWorld();
    Object.assign(t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!, { consented_at: null });
    await expect(saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123456" } })).rejects.toMatchObject({ code: "consent_required" });
    Object.assign(t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!, { consented_at: "2026-10-06T08:00:00Z" });
    t.db.rows("sign_documents")[0].status = "voided";
    await expect(saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123456" } })).rejects.toMatchObject({ code: "signer_not_open" });
  });
});

// ---- uploads ----------------------------------------------------------------------------------------------------------------

describe("uploading files", () => {
  const upload = async (role: RoleKey, field: string, bytes: Uint8Array, name = "scan.pdf") => uploadFile(t.ctx, await look(role), { field, file: { bytes, name } });
  const withPrefix = (prefix: number[], size: number) => {
    const b = new Uint8Array(size);
    b.set(prefix);
    return b;
  };
  const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d];

  it("recognises PDF, JPEG and PNG by their first bytes and nothing else", async () => {
    expect(detectKind(await pdfBytes())).toBe("pdf");
    expect(detectKind(await scribblePng())).toBe("png");
    expect(detectKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpg");
    expect(detectKind(new TextEncoder().encode("hello"))).toBeNull();
    expect(detectKind(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectKind(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBeNull(); // an executable
    expect(detectKind(new Uint8Array())).toBeNull();
  });

  it("stores a good file privately with its fingerprint, records it, answers the field and logs it", async () => {
    await sentWorld();
    const bytes = await pdfBytes();
    const r = await upload("merchant", "ssm", bytes, "Company Extract (final).pdf");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(r.file).toEqual({ id: expect.any(String), name: "Company Extract final.pdf", mime: "application/pdf", size: bytes.byteLength, sha256: sha });
    expect(r.ready).toBe(false);
    NO_PATH(r);

    const row = t.db.rows("sign_document_files").find((f) => f.kind === "signer_upload")!;
    expect(row).toMatchObject({ id: r.file.id, signer_id: t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!.id, sha256: sha, size_bytes: bytes.byteLength, mime: "application/pdf" });
    expect(String(row.path)).toBe(`account-${ACCT}/${t.db.rows("sign_documents")[0].id}/upload/${r.file.id}-Company Extract final.pdf`);
    expect(t.db.files.get(String(row.path))).toEqual(bytes);
    const answer = answerRow("ssm")!;
    expect(answer).toMatchObject({ source: "signer", value: { files: [{ id: r.file.id, sha256: sha }] } });

    const logged = events("uploaded");
    expect(logged).toHaveLength(1);
    expect(logged[0].detail).toEqual({ field: "ssm", name: "Company Extract final.pdf", size: bytes.byteLength, hash: sha.slice(0, 16) });
    // the signer sees it as a summary, without the path
    const view = await buildView(t.ctx, await look("merchant"), false);
    expect(view.content!.form!.answers.ssm).toEqual({ files: [r.file] });
    NO_PATH(view);
  });

  it("refuses what is not a PDF, JPEG or PNG, what the field does not accept, what is too big and too many", async () => {
    await sentWorld();
    await expect(upload("merchant", "ssm", new TextEncoder().encode("hello"), "note.pdf")).rejects.toMatchObject({ code: "unsupported_file", status: 400 });
    await expect(upload("merchant", "ssm", withPrefix([0x4d, 0x5a], 200), "setup.pdf")).rejects.toMatchObject({ code: "unsupported_file" });
    // a real PNG, but this field takes PDF or JPEG
    await expect(upload("merchant", "ssm", await scribblePng(), "scan.png")).rejects.toMatchObject({ code: "file_type_not_allowed", issues: [{ code: "file_type_not_allowed", field: "ssm", detail: "pdf,jpg" }] });
    // a file with nothing in it
    await expect(upload("merchant", "ssm", new Uint8Array())).rejects.toMatchObject({ code: "no_file" });
    await expect(uploadFile(t.ctx, await look("merchant"), { field: "ssm", file: null })).rejects.toMatchObject({ code: "no_file" });
    // over the field's own 1 MB limit
    await expect(upload("merchant", "ssm", withPrefix(PDF_HEAD, 1024 * 1024 + 1))).rejects.toMatchObject({ code: "file_too_large", status: 413, issues: [{ code: "file_too_large", field: "ssm", detail: "1" }] });
    // two files at most
    await upload("merchant", "ssm", await pdfBytes(), "a.pdf");
    await upload("merchant", "ssm", await pdfBytes(), "b.pdf");
    await expect(upload("merchant", "ssm", await pdfBytes(), "c.pdf")).rejects.toMatchObject({ code: "too_many_files", issues: [{ code: "too_many_files", field: "ssm", detail: "2" }] });
    expect(t.db.rows("sign_document_files").filter((f) => f.kind === "signer_upload")).toHaveLength(2);
    expect([...t.db.files.keys()].filter((k) => k.includes("/upload/"))).toHaveLength(2);
  });

  it("holds a field to its own limits even when it is the default one", async () => {
    await sentWorld();
    // taxCert takes PDF only, up to 2 MB, one file, and only while shown
    await expect(upload("merchant", "taxCert", await pdfBytes())).rejects.toMatchObject({ code: "not_shown", status: 409 });
    await saveAnswers(t.ctx, await look("merchant"), { taxType: { text: "sst" } });
    await upload("merchant", "taxCert", await pdfBytes());
    await expect(upload("merchant", "taxCert", await pdfBytes())).rejects.toMatchObject({ code: "too_many_files", issues: [{ detail: "1" }] });
  });

  it("stops at 50 MB of uploads for the whole document", async () => {
    const { docId } = await sentWorld();
    t.db.seed("sign_document_files", [{ id: "big", account_id: ACCT, document_id: docId, kind: "signer_upload", signer_id: "someone", path: `account-${ACCT}/${docId}/upload/big-x.pdf`, name: "x.pdf", mime: "application/pdf", size_bytes: 50 * 1024 * 1024 - 10, sha256: "0".repeat(64) }]);
    await expect(upload("merchant", "ssm", await pdfBytes())).rejects.toMatchObject({ code: "document_upload_limit", status: 413 });
  });

  it("takes files only for a file field of the signer's own part", async () => {
    await sentWorld();
    await expect(upload("merchant", "brn", await pdfBytes())).rejects.toMatchObject({ code: "not_a_file_field" });
    await expect(upload("finance", "ssm", await pdfBytes())).rejects.toMatchObject({ code: "not_your_field", status: 403 });
    await expect(upload("director", "ssm", await pdfBytes())).rejects.toMatchObject({ code: "not_your_field" });
    await expect(upload("merchant", "nope", await pdfBytes())).rejects.toMatchObject({ code: "not_your_field" });
    await expect(upload("merchant", "__proto__", await pdfBytes())).rejects.toMatchObject({ code: "not_your_field" });
    Object.assign(t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!, { consented_at: null });
    await expect(upload("merchant", "ssm", await pdfBytes())).rejects.toMatchObject({ code: "consent_required" });
  });

  it("removes a file everywhere, logs it, and lets nobody else remove or read it", async () => {
    await sentWorld();
    const a = await upload("merchant", "ssm", await pdfBytes(), "a.pdf");
    const b = await upload("merchant", "ssm", await pdfBytes(), "b.pdf");
    const path = String(t.db.rows("sign_document_files").find((f) => f.id === a.file.id)!.path);

    await expect(removeUpload(t.ctx, await look("finance"), { field: "ssm", id: a.file.id })).rejects.toMatchObject({ code: "not_your_field" });
    await expect(readOwnUpload(t.ctx, await look("finance"), { field: "ssm", id: a.file.id })).rejects.toMatchObject({ code: "not_your_field" });
    await expect(removeUpload(t.ctx, await look("merchant"), { field: "ssm", id: "11111111-2222-4333-8444-555555555555" })).rejects.toMatchObject({ code: "file_not_found", status: 404 });

    const own = await readOwnUpload(t.ctx, await look("merchant"), { field: "ssm", id: a.file.id });
    expect(own).toMatchObject({ mime: "application/pdf", name: "a.pdf" });
    expect(own.bytes.byteLength).toBeGreaterThan(100);

    const r = await removeUpload(t.ctx, await look("merchant"), { field: "ssm", id: a.file.id });
    NO_PATH(r);
    expect(t.db.files.has(path)).toBe(false);
    expect(t.db.rows("sign_document_files").some((f) => f.id === a.file.id)).toBe(false);
    expect(answerRow("ssm")!.value).toMatchObject({ files: [{ id: b.file.id }] });
    expect(events("upload_removed")[0].detail).toEqual({ field: "ssm", name: "a.pdf", hash: expect.stringMatching(/^[0-9a-f]{16}$/) });

    // the last one removed leaves no answer at all
    await removeUpload(t.ctx, await look("merchant"), { field: "ssm", id: b.file.id });
    expect(answerRow("ssm")).toBeUndefined();
    await expect(readOwnUpload(t.ctx, await look("merchant"), { field: "ssm", id: b.file.id })).rejects.toMatchObject({ code: "file_not_found" });
  });

  it("will not read a file whose stored path points outside the document's own folder", async () => {
    const { docId } = await sentWorld();
    const r = await upload("merchant", "ssm", await pdfBytes(), "a.pdf");
    const stored = answerRow("ssm")!;
    (stored.value as { files: { path: string }[] }).files[0].path = `account-${ACCT}/templates/tpl/v1.pdf`;
    t.db.files.set(`account-${ACCT}/templates/tpl/v1.pdf`, new Uint8Array([1, 2, 3]));
    await expect(readOwnUpload(t.ctx, await look("merchant"), { field: "ssm", id: r.file.id })).rejects.toMatchObject({ code: "file_not_found" });
    expect(docId).toBeTruthy();
  });
});

// ---- the gate ---------------------------------------------------------------------------------------------------------------

describe("the gate when the signature arrives", () => {
  it("refuses while a required answer is missing, naming the data fields, and does not touch the database's sign step", async () => {
    await sentWorld();
    const err = await completeSigning(t.ctx, await look("merchant"), {}, META).catch((e) => e);
    expect(err).toMatchObject({ code: "missing_required", status: 400 });
    // the placed signature and the form's data fields, in one list
    expect((err.issues as { field: string }[]).map((i) => i.field).sort()).toEqual(["bizType", "brn", "contactEmail", "legalName", "msig", "ssm"]);
    expect(err.issues.every((i: { code: string }) => i.code === "missing_required")).toBe(true);
    expect(t.db.rpcCalls.some((c) => c.name === "sign_complete_signer")).toBe(false);

    await fillMerchant();
    // the placed signature is still needed too
    const noSig = await completeSigning(t.ctx, await look("merchant"), {}, META).catch((e) => e);
    expect(noSig).toMatchObject({ code: "missing_required", issues: [{ code: "missing_required", field: "msig" }] });
  });

  it("refuses an answer that is no longer sound for its field", async () => {
    await sentWorld();
    await fillMerchant();
    (answerRow("brn")!.value as { text: string }).text = "abc"; // as if the definition had changed under it
    const err = await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid_answers", issues: [{ code: "text_too_short", field: "brn" }] });
    expect(t.db.rpcCalls.some((c) => c.name === "sign_complete_signer")).toBe(false);
  });

  it("refuses an answer too long for where it is printed, naming the place, until it is shortened", async () => {
    await sentWorld();
    await fillMerchant({ notes: { text: "A very long note that cannot be squeezed into a tiny box on the page. ".repeat(5) } });
    const err = await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META).catch((e) => e);
    expect(err).toMatchObject({ code: "answer_does_not_fit", status: 400, issues: [{ code: "answer_does_not_fit", field: "notes", detail: "p_notes" }] });
    expect(t.db.rpcCalls.some((c) => c.name === "sign_complete_signer")).toBe(false);

    await saveAnswers(t.ctx, await look("merchant"), { notes: { text: "ok" } });
    await expect(completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META)).resolves.toMatchObject({ sealing: false });
    expect(t.db.rpcCalls.filter((c) => c.name === "sign_complete_signer")).toHaveLength(1);
  });

  it("gives a person with no parts the plain signing path", async () => {
    await sentWorld();
    const r = await saveAnswers(t.ctx, await look("director"), { dsig: { typed: "Gokula" }, legalName: { text: "x" } });
    expect(r.saved).toEqual(["dsig"]);
    expect(r.rejected).toEqual([{ field: "legalName", code: "not_your_field" }]);
    expect(r.progress).toEqual([]);
    expect(r.ready).toBe(true);
    await expect(completeSigning(t.ctx, await look("director"), {}, META)).resolves.toMatchObject({ sealing: false });
  });

  it("lets a filler complete their part without a signature, and holds them only to their own answers' fit", async () => {
    await sentWorld();
    // the merchant's answer does not fit, but it is not the filler's to shorten
    await saveAnswers(t.ctx, await look("merchant"), { notes: { text: "A very long note that cannot be squeezed into a tiny box on the page. ".repeat(5) } });
    const early = await completeSigning(t.ctx, await look("finance"), {}, META).catch((e) => e);
    expect(early).toMatchObject({ code: "missing_required", issues: [{ code: "missing_required", field: "accountNo" }] });
    const saved = await saveAnswers(t.ctx, await look("finance"), { accountNo: { text: "1234567890" }, legalName: { text: "x" } });
    expect(saved.saved).toEqual(["accountNo"]);
    expect(saved.rejected).toEqual([{ field: "legalName", code: "not_your_field" }]);
    expect(saved.ready).toBe(true);
    expect(events("part_completed").map((e) => e.detail)).toEqual([{ part: "bank" }]);
    await expect(completeSigning(t.ctx, await look("finance"), {}, META)).resolves.toMatchObject({ sealing: false });
    expect(t.db.rows("sign_signers").find((s) => s.role_key === "finance")!.status).toBe("signed");
  });
});

// ---- write-back ----------------------------------------------------------------------------------------------------------------

describe("write-back to the contact", () => {
  const contact = () => t.db.rows("contacts").find((c) => c.id === "c1")!;
  const writebacks = () => events("writeback").map((e) => e.detail);

  it("writes what the signer confirmed, with the old and the new value in the trail, respecting 'only if empty'", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await fillMerchant({ legalName: { text: "Kedai Runcit Ali Sdn Bhd" }, contactEmail: { text: "ali@new.example" }, region: { text: "Johor" } });
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);

    expect(contact()).toMatchObject({ company: "Kedai Runcit Ali Sdn Bhd", email: "ali@old.example", name: "Ali bin Ahmad" });
    expect(t.db.rows("contact_custom_values").find((v) => v.contact_id === "c1" && v.custom_field_id === "cf1")).toMatchObject({ value: "Johor" });
    expect(writebacks()).toEqual([
      { field: "company", old: "Kedai Runcit Ali", new: "Kedai Runcit Ali Sdn Bhd" },
      { field: "custom:Region", old: "Selangor", new: "Johor" },
    ]);
    // only the signer's own rows in the workspace were touched
    expect(t.db.rows("contacts").find((c) => c.id === "c-other")).toMatchObject({ company: "Other Co" });
  });

  it("does not write an answer the signer never confirmed, nor one that has not changed", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false); // the contact's values arrive as unconfirmed answers
    await fillMerchant();
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    expect(contact()).toMatchObject({ company: "Kedai Runcit Ali", email: "ali@old.example" });
    expect(writebacks()).toEqual([]);
  });

  it("writes nothing for an answer confirmed without a change", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await saveAnswers(t.ctx, await look("merchant"), {}, { confirmParts: ["company", "tax"] });
    await fillMerchant();
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    expect(contact()).toMatchObject({ company: "Kedai Runcit Ali", email: "ali@old.example" });
    expect(writebacks()).toEqual([]);
  });

  it("never fails the signing when the write to the contact fails, and does not claim what was not written", async () => {
    await sentWorld();
    Object.assign(contact(), { email: "" });
    await buildView(t.ctx, await look("merchant"), false);
    await fillMerchant({ contactEmail: { text: "ali@new.example" } });
    t.db.failNext.contacts = "boom";
    const out = await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    expect(out.sealing).toBe(false);
    expect(t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!.status).toBe("signed");
    // the contact was not changed, so the trail does not claim it
    expect(contact().email).toBe("");
    expect(writebacks().some((w) => (w as { field: string }).field === "email")).toBe(false);
  });

  it("fills an empty email when the field says only-if-empty", async () => {
    await sentWorld();
    Object.assign(contact(), { email: "" });
    await buildView(t.ctx, await look("merchant"), false);
    await fillMerchant({ contactEmail: { text: "ali@new.example" } });
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    expect(contact().email).toBe("ali@new.example");
    expect(writebacks()).toContainEqual({ field: "email", old: "", new: "ali@new.example" });
  });

  it("writes nothing when the document has no contact", async () => {
    await sentWorld();
    t.db.rows("sign_documents")[0].contact_id = null;
    await fillMerchant({ legalName: { text: "No Contact Sdn Bhd" } });
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    expect(writebacks()).toEqual([]);
    expect(contact().company).toBe("Kedai Runcit Ali");
  });
});

// ---- the review ----------------------------------------------------------------------------------------------------------------------

describe("the review before signing", () => {
  it("is refused until every required answer of the signer's parts is given", async () => {
    await sentWorld();
    const err = await reviewFor(t.ctx, await look("merchant")).catch((e) => e);
    expect(err).toMatchObject({ code: "form_incomplete", status: 409 });
    expect((err.issues as { field: string }[]).map((i) => i.field).sort()).toEqual(["bizType", "brn", "contactEmail", "legalName", "ssm"]);
  });

  it("prints every role's answers as they will appear, leaves hidden ones out, and lists answers that do not fit", async () => {
    await sentWorld();
    await saveAnswers(t.ctx, await look("finance"), { accountNo: { text: "1234567890" } });
    await fillMerchant({ taxType: { text: "sst" }, taxPct: { text: "6" } });
    const r = await reviewFor(t.ctx, await look("merchant"));
    expect(r.printed).toMatchObject({
      p_biz: { text: "Sdn. Bhd." },
      p_brn: { text: "20190123456" },
      p_sst: { checked: true },
      p_pct: { text: "6" },
      p_acct: { text: "1234567890" }, // the filler's answer
    });
    expect(r.fitProblems).toEqual([]);
    NO_PATH(r);

    // the tax is switched off: the stale percentage no longer prints
    await saveAnswers(t.ctx, await look("merchant"), { taxType: { text: "na" }, notes: { text: "A very long note that cannot be squeezed into a tiny box on the page. ".repeat(5) } });
    const after = await reviewFor(t.ctx, await look("merchant"));
    expect(after.printed.p_pct).toBeUndefined();
    expect(after.printed.p_sst).toBeUndefined();
    expect(after.fitProblems).toEqual([{ field: "notes", placement: "p_notes" }]);
  });

  it("answers a person with no parts, and a document with no form", async () => {
    await sentWorld();
    await expect(reviewFor(t.ctx, await look("director"))).resolves.toMatchObject({ fitProblems: [] });
  });
});

// ---- the sender's side ----------------------------------------------------------------------------------------------------------------

describe("what the sender sees", () => {
  it("reports each role's progress, the visible answers with their source and time, and answers that do not fit", async () => {
    const { docId } = await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await fillMerchant({ notes: { text: "A very long note that cannot be squeezed into a tiny box on the page. ".repeat(5) } });
    t.advance(60_000);
    await saveAnswers(t.ctx, await look("finance"), { accountNo: { text: "1234567890" } });

    const p = await loadProgress(t.ctx, docId);
    expect(p.form).toEqual(FORM);
    expect(p.roles.map((r) => r.roleKey)).toEqual(["merchant", "finance"]);
    const merchant = p.roles[0];
    expect(merchant.signer).toMatchObject({ name: "Ali bin Ahmad", status: "sent" });
    expect(merchant.parts.map((x) => [x.key, x.state, x.title.en])).toEqual([["company", "done", "Company details"], ["tax", "done", "Tax"]]);
    expect(merchant.percent).toBe(100);
    const finance = p.roles[1];
    expect(finance).toMatchObject({ percent: 100, signer: { name: "Siti Finance" } });
    expect(finance.lastActivityAt).toBe("2026-10-06T08:01:00.000Z");
    expect(p.lastActivityAt).toBe("2026-10-06T08:01:00.000Z");

    const keys = p.answers.map((a) => a.key);
    expect(keys).not.toContain("taxPct"); // hidden for now
  });

  it("shows the account note only when its rule holds, files without paths, and the fit problem for the sender", async () => {
    const { docId } = await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await fillMerchant({ notes: { text: "A very long note that cannot be squeezed into a tiny box on the page. ".repeat(5) } });
    const p = await loadProgress(t.ctx, docId);
    const row = (k: string) => p.answers.find((a) => a.key === k)!;
    expect(row("accountNote")).toMatchObject({ value: null, role: "finance" }); // visible (Sdn. Bhd.), unanswered
    expect(row("legalName")).toMatchObject({ source: "contact", value: { text: "Kedai Runcit Ali" }, role: "merchant" });
    expect(row("ssm").value).toMatchObject({ files: [{ name: "Company Extract final.pdf", mime: "application/pdf" }] });
    expect(row("ssm").savedAt).toBe("2026-10-06T08:00:00.000Z");
    expect(p.issues).toEqual([{ code: "answer_does_not_fit", field: "notes", detail: "p_notes" }]);
    NO_PATH(p);
  });

  it("has nothing to show for a document without a form", async () => {
    const { document } = await createDraftFromUpload(t.ctx, { bytes: await pdfBytes(), filename: "plain.pdf" });
    await expect(loadProgress(t.ctx, document.id)).rejects.toMatchObject({ code: "no_form", status: 404 });
  });

  it("serves an uploaded file to the sender, from this document only, and records it", async () => {
    const { docId } = await sentWorld();
    const r = await uploadFile(t.ctx, await look("merchant"), { field: "ssm", file: { bytes: await pdfBytes(), name: "a.pdf" } });
    const file = await uploadedFileForStaff(t.ctx, docId, r.file.id);
    expect(file).toMatchObject({ name: "a.pdf", mime: "application/pdf" });
    expect(events("downloaded")[0].detail).toEqual({ file: r.file.id });
    // another document of the same workspace, another workspace, and a file that is not an upload
    await expect(uploadedFileForStaff(t.ctx, "00000000-0000-4000-8000-000000000000", r.file.id)).rejects.toMatchObject({ code: "file_not_found" });
    await expect(uploadedFileForStaff({ ...t.ctx, accountId: "someone-else" }, docId, r.file.id)).rejects.toMatchObject({ code: "file_not_found" });
    t.db.seed("sign_document_files", [{ id: "signed-1", account_id: ACCT, document_id: docId, kind: "signed", path: `account-${ACCT}/${docId}/final/x.pdf`, name: "x.pdf", mime: "application/pdf", size_bytes: 1 }]);
    await expect(uploadedFileForStaff(t.ctx, docId, "signed-1")).rejects.toMatchObject({ code: "file_not_found" });
  });
});

describe("giving more time", () => {
  it("extends only an open document, only to a later time, and records the old and new time", async () => {
    const { docId } = await sentWorld();
    expect(t.db.rows("sign_documents")[0].expires_at).toBe("2026-10-20T08:00:00.000Z");
    await expect(extendExpiry(t.ctx, docId, "2026-10-19T08:00:00Z")).rejects.toMatchObject({ code: "expiry_not_later", status: 400 });
    await expect(extendExpiry(t.ctx, docId, "2026-10-20T08:00:00Z")).rejects.toMatchObject({ code: "expiry_not_later" });
    await expect(extendExpiry(t.ctx, docId, "2020-01-01T00:00:00Z")).rejects.toMatchObject({ code: "expiry_in_the_past" });
    await expect(extendExpiry(t.ctx, docId, "soon")).rejects.toMatchObject({ code: "bad_expiry" });
    await expect(extendExpiry(t.ctx, docId, undefined)).rejects.toMatchObject({ code: "bad_expiry" });
    await expect(extendExpiry(t.ctx, docId, "2031-01-01T00:00:00Z")).rejects.toMatchObject({ code: "expiry_too_far" });

    await expect(extendExpiry(t.ctx, docId, "2026-10-27T08:00:00Z")).resolves.toEqual({ expiresAt: "2026-10-27T08:00:00.000Z" });
    const doc = t.db.rows("sign_documents")[0];
    expect(doc.expires_at).toBe("2026-10-27T08:00:00.000Z");
    expect(doc.status).toBe("sent"); // nothing else reopened
    expect(events("expiry_extended")[0].detail).toEqual({ old: "2026-10-20T08:00:00.000Z", new: "2026-10-27T08:00:00.000Z" });

    for (const status of ["draft", "sealing", "completed", "declined", "expired", "voided"]) {
      doc.status = status;
      await expect(extendExpiry(t.ctx, docId, "2026-11-01T08:00:00Z"), status).rejects.toMatchObject({ code: "document_not_open", status: 409 });
    }
    doc.status = "in_progress";
    await expect(extendExpiry(t.ctx, docId, "2026-11-01T08:00:00Z")).resolves.toBeTruthy();
  });

  it("will not touch a document of another workspace", async () => {
    const { docId } = await sentWorld();
    await expect(extendExpiry({ ...t.ctx, accountId: "someone-else" }, docId, "2026-11-01T08:00:00Z")).rejects.toMatchObject({ code: "document_not_found" });
  });
});

describe("reminders", () => {
  const brief = (role: RoleKey) => {
    const s = t.db.rows("sign_signers").find((x) => x.role_key === role)!;
    return { signer_id: s.id, token: TOK[role], name: s.full_name, email: s.email, phone: null, channel: "email", role_key: role, kind: s.kind, order_no: s.order_no };
  };

  it("names the parts still to complete, by title in the document's language", async () => {
    const { docId } = await sentWorld();
    t.db.rpcHandlers.sign_rotate_token = async (a) => ({ data: brief(t.db.rows("sign_signers").find((s) => s.id === a.p_signer)!.role_key as RoleKey), error: null });
    const merchant = t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!;
    await remindSigner(t.ctx, docId, merchant.id as string);
    expect(t.mail.at(-1)!.text).toContain("You still have 2 parts to complete: Company details, Tax.");

    // the tax part is done, so one part is left
    await saveAnswers(t.ctx, await look("merchant"), { taxType: { text: "na" } });
    await remindSigner(t.ctx, docId, merchant.id as string);
    expect(t.mail.at(-1)!.text).toContain("You still have 1 part to complete: Company details.");

    // in the document's language
    t.db.rows("sign_documents")[0].locale = "ms";
    await remindSigner(t.ctx, docId, merchant.id as string);
    expect(t.mail.at(-1)!.text).toContain("Anda masih ada 1 bahagian untuk dilengkapkan: Butiran syarikat.");

    // everything done: no sentence
    await fillMerchant();
    await remindSigner(t.ctx, docId, merchant.id as string);
    expect(t.mail.at(-1)!.text).not.toMatch(/bahagian|parts to complete/);
  });
});

// ---- sealing ----------------------------------------------------------------------------------------------------------------------------------

async function pageText(bytes: Uint8Array): Promise<{ page: number; str: string; x: number; y: number }[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: { page: number; str: string; x: number; y: number }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      out.push({ page: i, str: it.str, x, y });
    }
  }
  return out;
}

describe("sealing a form document", () => {
  it("prints the answers on the places bound to them, lists the upload on the certificate and keeps the rest of the trail off it", async () => {
    const { docId } = await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await fillMerchant({ legalName: { text: "Kedai Runcit Ali Sdn Bhd" }, region: { text: "Johor" } });
    await saveAnswers(t.ctx, await look("merchant"), { taxType: { text: "sst" }, taxPct: { text: "6" } });
    await saveAnswers(t.ctx, await look("finance"), { accountNo: { text: "1234567890" } });
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    await completeSigning(t.ctx, await look("finance"), {}, META);
    await completeSigning(t.ctx, await look("director"), { dsig: { typed: "Gokula" } }, META);
    const doc = t.db.rows("sign_documents")[0];
    expect(doc.status).toBe("sealing");

    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    t.db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
    t.db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: docId, account_id: ACCT }], error: null });
    t.db.rpcHandlers.sign_finish_sealing = async (a) => {
      Object.assign(t.db.rows("sign_documents")[0], { status: "completed", final_path: a.p_final_path, final_sha256: a.p_final_sha256 });
      return { data: {}, error: null };
    };
    t.db.rpcHandlers.sign_fail_sealing = async () => ({ data: null, error: null });
    expect(await runSealing({ admin: t.ctx.admin, origin: t.ctx.origin, deps: t.ctx.deps, now: t.ctx.now }, 2)).toEqual({ claimed: 1, completed: 1, retry: 0 });

    const fin = t.db.rpcCalls.find((c) => c.name === "sign_finish_sealing")!;
    const bytes = t.db.files.get(fin.args.p_final_path as string)!;
    expect(verifySealed(bytes).ok).toBe(true);

    const text = await pageText(bytes);
    const first = text.filter((x) => x.page === 1);
    const at = (s: string) => first.find((x) => x.str.trim() === s) ?? first.find((x) => x.str.includes(s));
    const H = 841.89;
    // each answer sits in its own box (a box's top is y * page height; the baseline is inside it)
    const inBox = (item: { y: number } | undefined, y: number, h = 0.04) => !!item && item.y > y * H && item.y < (y + h) * H;
    expect(inBox(at("Kedai Runcit Ali Sdn Bhd"), 0.1)).toBe(true);
    expect(inBox(at("Sdn. Bhd."), 0.15)).toBe(true); // the choice by its label, not its value
    expect(inBox(at("20190123456"), 0.2)).toBe(true);
    expect(inBox(at("6"), 0.3)).toBe(true);
    expect(inBox(at("1234567890"), 0.35)).toBe(true); // the filler's answer, printed too
    expect(first.some((x) => x.str.includes("sdn_bhd"))).toBe(false);

    // the certificate pages list the upload (name and the start of its fingerprint); nothing of the form's answers is on them
    const upload = t.db.rows("sign_document_files").find((f) => f.kind === "signer_upload")!;
    const cert = text.filter((x) => x.page > 1).map((x) => x.str).join(" ").replace(/\s+/g, "");
    expect(cert).toContain("uploaded");
    expect(cert).toContain("CompanyExtractfinal.pdf");
    expect(cert).toContain(String(upload.sha256).slice(0, 16));
    for (const hidden of ["KedaiRuncitAliSdnBhd", "Johor", "1234567890", "ali@old.example"]) expect(cert).not.toContain(hidden);
    // the uploaded file is not appended as a page: the original page plus certificate pages only
    expect(text.some((x) => x.page === 2 && x.str.includes("Fixture"))).toBe(false);
  });

  it("merges the bound placements' values over the answered ones, and leaves a bound placement out of the answered fields", async () => {
    await sentWorld();
    await fillMerchant();
    const doc = t.db.rows("sign_documents")[0];
    const signers = t.db.rows("sign_signers") as never[];
    const answers = t.db.rows("sign_answers").map((a) => ({ signer_id: a.signer_id as string, field_key: a.field_key as string, value: a.value as never }));
    const v = valuesFor(doc.fields_snapshot as PlacedField[], signers, answers, { definition: FORM, locale: "ms" });
    expect(v.p_brn).toEqual({ text: "20190123456" });
    expect(v.p_biz).toEqual({ text: "Sdn. Bhd." });
    expect(v.legalName).toBeUndefined();
    const plain = valuesFor(doc.fields_snapshot as PlacedField[], signers, answers);
    expect(plain.p_brn).toBeUndefined();
  });
});

describe("a form is only the server's to judge", () => {
  it("lets no response of the signer's side carry a storage path", async () => {
    await sentWorld();
    const view1 = await buildView(t.ctx, await look("merchant"), false);
    const saved = await saveAnswers(t.ctx, await look("merchant"), { brn: { text: "20190123456" } });
    const up = await uploadFile(t.ctx, await look("merchant"), { field: "ssm", file: { bytes: await pdfBytes(), name: "a.pdf" } });
    const view2 = await buildView(t.ctx, await look("merchant"), false);
    const fin = await buildView(t.ctx, await look("finance"), false);
    for (const body of [view1, saved, up, view2, fin]) NO_PATH(body);
    // the upload is still there for the server
    expect(answerRow("ssm")!.value).toMatchObject({ files: [{ path: expect.stringContaining("/upload/") }] });
  });
});
