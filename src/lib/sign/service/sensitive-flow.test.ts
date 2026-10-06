// An end-to-end run of sensitive form fields (F-47) over the in-memory database: a signer saves sensitive answers, what is
// stored is only ciphertext, the sender's screens get a mask, "Reveal" is an audited act, the sealing job prints what the
// form says to print, and no event, mail or log line ever carries a value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDocumentProxy } from "unpdf";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { FormDefinition, L10n } from "../forms";
import { validateForm } from "../forms";
import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import { hashToken } from "../tokens";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { progressForApi } from "./api";
import { createDraftFromTemplate, setSigners } from "./drafts";
import { FakeDb } from "./fake-db";
import { loadProgress } from "./progress";
import { reviewFor } from "./review";
import { runSealing } from "./seal";
import { sendDocument } from "./send";
import { buildView, completeSigning, lookupByToken, saveAnswers, type Lookup } from "./signing";
import { revealAnswer } from "./sensitive-staff";
import { loadFormState } from "./form-state";
import { createTemplateFromUpload, saveTemplateVersion, updateTemplate } from "./templates";
import { writeBackToContact } from "./writeback";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TOK = { merchant: "a".repeat(64), finance: "b".repeat(64) } as const;
type RoleKey = keyof typeof TOK;

const IC = "900101-01-1234";
const TAX = "TAX-998877-55";
const ACCOUNT = "1234567890123";

const L = (en: string): L10n => ({ en });

const FORM: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company"), role: "merchant" },
    { key: "bank", title: L("Bank"), role: "finance" },
  ],
  fields: [
    { key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true },
    { key: "icNumber", type: "text", part: "company", label: L("IC number"), required: true, sensitive: true },
    { key: "taxId", type: "text", part: "company", label: L("Tax ID"), required: false, sensitive: true, printMasked: "none" },
    { key: "accountNo", type: "text", part: "bank", label: L("Account number"), required: true, sensitive: true, printMasked: "last4" },
  ],
};

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance", kind: "filler", color: 1 },
];

const bound = (key: string, data: string, y: number): PlacedField => ({ key, type: "text", role: "sender", page: 0, x: 0.1, y, w: 0.6, h: 0.04, required: false, data });
const fields: PlacedField[] = [
  bound("p_legal", "legalName", 0.1),
  bound("p_ic", "icNumber", 0.15),
  bound("p_acct", "accountNo", 0.2),
  bound("p_tax", "taxId", 0.25),
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.5, w: 0.4, h: 0.08, required: true },
];

interface Mail {
  to: string;
  subject: string;
  text: string;
}

function setup() {
  const db = new FakeDb();
  const mail: Mail[] = [];
  const nowMs = Date.parse("2026-10-06T08:00:00Z");
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
  db.seed("contacts", [{ id: "c1", account_id: ACCT, name: "Ali bin Ahmad", email: "ali@old.example", company: "Kedai Runcit Ali", deleted_at: null }]);

  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  db.rpcHandlers.sign_log = async (a) => {
    const seq = db.rows("sign_events").filter((e) => e.document_id === a.p_document).length + 1;
    db.seed("sign_events", [{ account_id: ACCT, document_id: a.p_document, doc_seq: seq, type: a.p_type, actor_type: a.p_actor_type, signer_id: a.p_signer, actor_user_id: a.p_user, detail: a.p_detail ?? {}, row_hash: seq.toString(16).padStart(64, "0"), created_at: new Date(nowMs).toISOString() }]);
    return { data: null, error: null };
  };
  db.rpcHandlers.sign_send_document = async (args) => {
    const doc = db.rows("sign_documents").find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at, reference: "SGN-2026-000778", sent_at: new Date(nowMs).toISOString() });
    const people = db.rows("sign_signers").filter((s) => s.document_id === args.p_document);
    const invited = people.map((p) => ({ signer_id: p.id, token: TOK[p.role_key as RoleKey], name: p.full_name, email: p.email, phone: null, channel: p.channel, role_key: p.role_key, kind: p.kind, order_no: p.order_no }));
    for (const p of people) {
      Object.assign(p, { status: "sent", invited_at: new Date(nowMs).toISOString(), consented_at: new Date(nowMs).toISOString() });
      db.seed("sign_signer_secrets", [{ signer_id: p.id, account_id: ACCT, token_hash: hashToken(TOK[p.role_key as RoleKey]), code_hash: null, code_expires_at: null, code_attempts: 0 }]);
    }
    return { data: { reference: "SGN-2026-000778", invited }, error: null };
  };
  db.rpcHandlers.sign_complete_signer = async (a) => {
    const s = db.rows("sign_signers").find((x) => x.id === a.p_signer)!;
    Object.assign(s, { status: "signed", signed_at: new Date(nowMs).toISOString() });
    const doc = db.rows("sign_documents").find((d) => d.id === s.document_id)!;
    const done = db.rows("sign_signers").filter((x) => x.document_id === doc.id).every((x) => x.status === "signed");
    doc.status = done ? "sealing" : "in_progress";
    return { data: { sealing: done, invited: [] }, error: null };
  };
  return { db, ctx, mail };
}

let t: ReturnType<typeof setup>;
const logged: string[] = [];

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  t = setup();
  logged.length = 0;
  for (const m of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function sentWorld() {
  const { template } = await createTemplateFromUpload(t.ctx, { bytes: await makePdf([{ ...A4 }]), filename: "Merchant Form.pdf", name: "Merchant form" });
  await saveTemplateVersion(t.ctx, template.id, { fields, roles, form: FORM });
  await updateTemplate(t.ctx, template.id, { status: "active" });
  const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id, contactId: "c1" });
  await setSigners(t.ctx, doc.id, [
    { roleKey: "merchant", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedairuncit.example", channel: "email", orderNo: 1 },
    { roleKey: "finance", kind: "filler", fullName: "Siti Finance", email: "siti@kedairuncit.example", channel: "email", orderNo: 2 },
  ]);
  await sendDocument(t.ctx, doc.id);
  return { docId: doc.id };
}

async function look(role: RoleKey): Promise<Lookup> {
  const l = await lookupByToken(t.ctx.admin, TOK[role]);
  expect(l).not.toBeNull();
  return l!;
}

const META = { ip: "203.0.113.9", device: "Chrome", locale: "en" };
const events = (type?: string) => t.db.rows("sign_events").filter((e) => !type || e.type === type);
const answerRow = (key: string) => t.db.rows("sign_answers").find((a) => a.field_key === key);
const SECRETS = [IC, TAX, ACCOUNT];
const everywhere = () => JSON.stringify([events(), t.mail, logged]);

async function fillEverything() {
  await buildView(t.ctx, await look("merchant"), false);
  await saveAnswers(t.ctx, await look("merchant"), { legalName: { text: "Kedai Runcit Ali Sdn Bhd" }, icNumber: { text: IC }, taxId: { text: TAX } });
  await saveAnswers(t.ctx, await look("finance"), { accountNo: { text: ACCOUNT } });
}

async function pageText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: string[] = [];
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  for (const it of content.items) if ("str" in it && it.str.trim()) out.push(it.str.trim());
  return out;
}

describe("what is stored", () => {
  it("keeps a sensitive answer only as ciphertext, and an ordinary one as it always was", async () => {
    await sentWorld();
    await fillEverything();
    for (const key of ["icNumber", "taxId", "accountNo"]) {
      const row = answerRow(key)!;
      expect(row.sensitive).toBe(true);
      expect(row.value).toBeNull();
      expect(typeof row.value_enc).toBe("string");
      expect(row.value_enc).not.toContain("1234");
    }
    expect(JSON.stringify(t.db.rows("sign_answers"))).not.toMatch(/900101|998877|1234567890123/);
    const plain = answerRow("legalName")!;
    expect(plain).toMatchObject({ sensitive: false, value: { text: "Kedai Runcit Ali Sdn Bhd" }, value_enc: null });
  });

  it("writes a new ciphertext each time (the same answer twice does not look the same)", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await saveAnswers(t.ctx, await look("merchant"), { icNumber: { text: IC } });
    const first = answerRow("icNumber")!.value_enc;
    await saveAnswers(t.ctx, await look("merchant"), { icNumber: { text: IC } });
    expect(answerRow("icNumber")!.value_enc).not.toBe(first);
  });

  it("clears a sensitive answer when it is emptied", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await saveAnswers(t.ctx, await look("merchant"), { icNumber: { text: IC } });
    await saveAnswers(t.ctx, await look("merchant"), { icNumber: { text: "" } });
    expect(answerRow("icNumber")).toBeUndefined();
  });

  it("leaves rows written before the field was sensitive exactly as they are", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    const merchant = t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!;
    // an old row: plain value, sensitive false, no ciphertext column at all
    t.db.seed("sign_answers", [{ account_id: ACCT, document_id: merchant.document_id, signer_id: merchant.id, field_key: "icNumber", value: { text: IC }, source: "signer", saved_at: "2026-10-06T08:00:00Z" }]);
    const state = (await loadFormState(t.ctx, t.db.rows("sign_documents")[0] as never, FORM)).state;
    expect(state.map.icNumber).toEqual({ text: IC });
  });
});

describe("who can read it", () => {
  it("gives the signer their own answer back, and gives no one else's page the value", async () => {
    await sentWorld();
    await fillEverything();
    const mine = await buildView(t.ctx, await look("merchant"), false);
    expect(JSON.stringify(mine)).toContain(IC);
    const finance = await buildView(t.ctx, await look("finance"), false);
    expect(JSON.stringify(finance)).not.toContain(IC);
    expect(JSON.stringify(finance)).not.toContain(TAX);
    expect(JSON.stringify(finance)).toContain(ACCOUNT);
  });

  it("counts a sensitive answer for completeness and soundness without any plaintext column", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    await saveAnswers(t.ctx, await look("merchant"), { legalName: { text: "Kedai" } });
    // the required sensitive answer is missing
    await expect(completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META)).rejects.toMatchObject({ code: "missing_required" });
    await saveAnswers(t.ctx, await look("merchant"), { icNumber: { text: IC } });
    const done = await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    expect(done.sealing).toBe(false);
  });

  it("shows the sender a mask with a flag, never the value, and ordinary answers in full", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    const progress = await loadProgress(t.ctx, docId);
    const ic = progress.answers.find((a) => a.key === "icNumber")!;
    expect(ic).toMatchObject({ sensitive: true, value: { text: "•••• 1234" } });
    expect(progress.answers.find((a) => a.key === "accountNo")!.value).toEqual({ text: "•••• 0123" });
    expect(progress.answers.find((a) => a.key === "legalName")).toMatchObject({ value: { text: "Kedai Runcit Ali Sdn Bhd" } });
    expect(progress.answers.find((a) => a.key === "legalName")!.sensitive).toBeUndefined();
    const text = JSON.stringify(progress);
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it("never lets a contact write-back carry a sensitive answer, even from a form that asks for it", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    const doc = t.db.rows("sign_documents").find((d) => d.id === docId)!;
    const signer = t.db.rows("sign_signers").find((s) => s.role_key === "merchant")!;
    const form: FormDefinition = { ...FORM, fields: FORM.fields.map((f) => (f.key === "icNumber" ? { ...f, contactField: "company", writeBack: "always" as const } : f)) };
    const state = (await loadFormState(t.ctx, doc as never, FORM)).state;
    const changes = await writeBackToContact(t.ctx, doc as never, signer as never, form, state);
    expect(changes).toEqual([]);
    expect(t.db.rows("contacts")[0].company).toBe("Kedai Runcit Ali");
    expect(events("writeback")).toHaveLength(0);
  });
});

describe("Reveal", () => {
  it("returns the value, and records who looked at which field of which document, never the value", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    const out = await revealAnswer(t.ctx, docId, "icNumber");
    expect(out).toEqual({ field: "icNumber", value: { text: IC } });
    const seen = events("sensitive_viewed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ document_id: docId, actor_type: "user", actor_user_id: USER, detail: { field: "icNumber" } });
    expect(JSON.stringify(seen[0])).not.toContain(IC);
  });

  it("is refused for a field that is not sensitive, one that does not exist, one without an answer, and a bad key", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    for (const key of ["legalName", "nope", 42, null, undefined]) {
      await expect(revealAnswer(t.ctx, docId, key)).rejects.toMatchObject({ code: "answer_not_found", status: 404 });
    }
    await expect(revealAnswer(t.ctx, "00000000-0000-4000-8000-000000000000", "icNumber")).rejects.toMatchObject({ code: "document_not_found" });
    expect(events("sensitive_viewed")).toHaveLength(0);
    // nobody has answered taxId in a fresh document
    t.db.tables.sign_answers = t.db.rows("sign_answers").filter((a) => a.field_key !== "taxId");
    await expect(revealAnswer(t.ctx, docId, "taxId")).rejects.toMatchObject({ code: "answer_not_found" });
  });

  it("shows nothing when the view cannot be recorded", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    t.db.rpcHandlers.sign_log = async () => ({ data: null, error: { message: "chain is busy" } });
    await expect(revealAnswer(t.ctx, docId, "icNumber")).rejects.toMatchObject({ code: "audit_unavailable", status: 503 });
  });

  it("cannot reveal another workspace's answer", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    const other: SignCtx = { ...t.ctx, accountId: "99999999-9999-4999-8999-999999999999" };
    await expect(revealAnswer(other, docId, "icNumber")).rejects.toMatchObject({ code: "document_not_found" });
  });
});

describe("no value leaks into the trail", () => {
  it("keeps every audit event, mail and log line free of the values, through the whole life of the document", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    await revealAnswer(t.ctx, docId, "icNumber");
    await loadProgress(t.ctx, docId);
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    await completeSigning(t.ctx, await look("finance"), {}, META);
    // a rejected answer says why, not what
    await expect(saveAnswers(t.ctx, await look("finance"), { accountNo: { text: ACCOUNT } })).rejects.toBeTruthy();
    const text = everywhere();
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it("does not echo a rejected sensitive answer", async () => {
    await sentWorld();
    await buildView(t.ctx, await look("merchant"), false);
    const out = await saveAnswers(t.ctx, await look("merchant"), { icNumber: { text: "x".repeat(2000) } });
    expect(out.rejected).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("xxxx");
  });
});

describe("a stored answer is only readable where it belongs", () => {
  it("refuses one that has been tampered with, and one copied onto another row", async () => {
    await sentWorld();
    await fillEverything();
    const ic = answerRow("icNumber")!;
    const tax = answerRow("taxId")!;
    const original = ic.value_enc;
    // swapped between two answers of the same document
    ic.value_enc = tax.value_enc;
    await expect(buildView(t.ctx, await look("merchant"), false)).rejects.toMatchObject({ code: "sensitive_unreadable", status: 500 });
    // altered
    ic.value_enc = String(original).replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    await expect(buildView(t.ctx, await look("merchant"), false)).rejects.toMatchObject({ code: "sensitive_unreadable" });
    // the failure says nothing of the value
    expect(logged.join(" ")).not.toContain(IC);
    ic.value_enc = original;
    await expect(buildView(t.ctx, await look("merchant"), false)).resolves.toBeTruthy();
  });

  it("refuses an answer written for another document", async () => {
    await sentWorld();
    await fillEverything();
    const ic = answerRow("icNumber")!;
    ic.value_enc = encrypt(JSON.stringify({ d: "00000000-0000-4000-8000-000000000000", k: "icNumber", v: { text: IC } }));
    await expect(buildView(t.ctx, await look("merchant"), false)).rejects.toMatchObject({ code: "sensitive_unreadable" });
  });
});

describe("the public API", () => {
  it("shows where each part stands and no answer at all", async () => {
    const { docId } = await sentWorld();
    await fillEverything();
    const doc = t.db.rows("sign_documents").find((d) => d.id === docId)!;
    const out = await progressForApi(t.ctx, doc as never);
    expect(out).not.toBeNull();
    expect(out!.map((r) => r.roleKey).sort()).toEqual(["finance", "merchant"]);
    const text = JSON.stringify(out);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain("Kedai Runcit Ali Sdn Bhd");
  });
});

describe("the form is refused when it uses the flag badly", () => {
  it("rejects a sensitive field that fills the contact, with the stable codes", () => {
    const bad: FormDefinition = { ...FORM, fields: [...FORM.fields, { key: "co", type: "text", part: "company", label: L("Company"), required: false, sensitive: true, contactField: "company" }] };
    expect(validateForm(bad, roles, fields).map((i) => i.code)).toContain("sensitive_contact_field");
  });

  it("refuses to save a template version that does", async () => {
    const { template } = await createTemplateFromUpload(t.ctx, { bytes: await makePdf([{ ...A4 }]), filename: "x.pdf", name: "X" });
    const bad: FormDefinition = { ...FORM, fields: FORM.fields.map((f) => (f.key === "legalName" ? { ...f, type: "choice" as const, options: [{ value: "a", label: L("A") }], sensitive: true } : f)) };
    await expect(saveTemplateVersion(t.ctx, template.id, { fields, roles, form: bad })).rejects.toMatchObject({ code: "invalid_layout", issues: [{ code: "bad_sensitive", field: "legalName" }] });
  });
});

describe("sealing", () => {
  async function seal() {
    const { docId } = await sentWorld();
    await fillEverything();
    await completeSigning(t.ctx, await look("merchant"), { msig: { typed: "Ali" } }, META);
    await completeSigning(t.ctx, await look("finance"), {}, META);
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
    return t.db.files.get(fin.args.p_final_path as string)!;
  }

  it("prints in full by default, only the last four characters when the form says so, and nothing when it says none", async () => {
    const bytes = await seal();
    const text = await pageText(bytes);
    const all = text.join(" ");
    expect(all).toContain(IC); // the default: the signed document shows what was agreed
    expect(all).toContain("**** 0123"); // last4
    expect(all).not.toContain(ACCOUNT);
    expect(all).not.toContain(TAX); // none
    expect(all).not.toContain("TAX-");
  });

  it("keeps the values off the certificate pages and out of the history", async () => {
    await seal();
    for (const s of [TAX, ACCOUNT]) expect(everywhere()).not.toContain(s);
  });
});

describe("the signer's own review", () => {
  it("previews what will be printed (masked where the form masks the print), to the signer only", async () => {
    await sentWorld();
    await fillEverything();
    const review = await reviewFor(t.ctx, await look("merchant"));
    expect(review.printed.p_ic).toEqual({ text: IC });
    expect(review.printed.p_acct).toEqual({ text: "**** 0123" });
    expect(review.printed.p_tax).toBeUndefined();
  });
});
