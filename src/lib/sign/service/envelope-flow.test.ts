import { createHash } from "node:crypto";

import { getDocumentProxy } from "unpdf";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";

import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import { createSelfSignedP12 } from "../pdf/p12";
import type { PlacedField } from "../pdf/types";
import { verifySealed } from "../pdf/verify";
import type { SignDocumentRow, SignRole, SignSignerRow } from "../types";
import type { SignCtx } from "./context";
import { updateDraft, setSigners, deleteDraft } from "./drafts";
import { installEnvelopeRpcs } from "./envelope-fake";
import { finishEnvelope } from "./envelope-signing";
import { changeEnvelopeRecipient, createEnvelopeDraft, deleteEnvelope, envelopeData, remindEnvelopePerson, resendEnvelopePerson, sendEnvelope, settleEnvelope, setEnvelopeSigners, updateEnvelope, voidEnvelope, type EnvelopePersonInput } from "./envelopes";
import { FakeDb } from "./fake-db";
import { runExpiry } from "./jobs";
import { runSealing } from "./seal";
import { changeRecipient, remindSigner, resendSigner, sendDocument, voidDocument } from "./send";
import { buildView, completeSigning, declineSigning, lookupByToken, markViewed, pickDocument, recordConsent, saveAnswers, type Lookup } from "./signing";
import { loadVerification } from "./verify";
import { loadEnvelope } from "./envelope-data";

// An envelope through the real services, from the draft to the one completion message, with the database's functions of migration 171
// stood in by envelope-fake.ts (the SQL itself is proved by supabase/ci/verify-171-sign-envelopes.sql). The engine and the webhook delivery are
// recorders, as in outbound-hooks.test.ts.
const rec = vi.hoisted(() => ({ automations: vi.fn(), webhooks: vi.fn() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: (...a: unknown[]) => rec.automations(...a) }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: (...a: unknown[]) => rec.webhooks(...a) }));

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const TPL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TPL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TPL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TPL_X = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
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
  attachments?: unknown[];
}

let db: FakeDb;
let ctx: SignCtx;
let mail: Mail[];
let tokens: Map<string, string>;
let counter: number;
let tokenN: number;

const ALI = { fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email" as const };
const BALA = { fullName: "Bala Krishnan", email: "bala@kedai.example", channel: "email" as const };

async function seedTemplate(id: string, name: string, own: { roles?: SignRole[]; fields?: PlacedField[] } = {}) {
  const bytes = await makePdf([{ ...A4 }]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  db.files.set(`account-${ACCT}/templates/${id}/v1.pdf`, bytes);
  db.seed("sign_templates", [{ id, account_id: ACCT, name, status: "active", category_id: null, current_version_id: `ver-${id}` }]);
  db.seed("sign_template_versions", [{ id: `ver-${id}`, account_id: ACCT, template_id: id, version_no: 1, source_path: `account-${ACCT}/templates/${id}/v1.pdf`, source_sha256: sha, original_path: null, page_count: 1, fields: own.fields ?? fields, roles: own.roles ?? roles, defaults: {}, mode: "sign" }]);
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  db = new FakeDb();
  mail = [];
  counter = 0;
  tokenN = 0;
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject, text: a.text, attachments: a.attachments }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  // what the database fills in for a new row
  db.insertDefaults.sign_envelopes = () => ({ status: "draft", reference: `ENV-2026-00000${++counter}`, locale: "en", sign_in_order: false, code_required: false, message: null, reminder_days: null, expires_at: null, sent_at: null, completed_at: null, void_reason: null, end_notified_at: null });
  db.insertDefaults.sign_documents = () => ({ reference: `SGN-2026-00000${++counter}`, mode: "sign", test: false, merge_values: {}, form_snapshot: null, envelope_id: null, envelope_position: null, final_path: null, final_sha256: null, completed_at: null, retain_until: null, void_reason: null, sent_at: null, expires_at: null });
  db.insertDefaults.sign_signers = () => ({ status: "pending", kind: "signer", invited_at: null, viewed_at: null, signed_at: null, consented_at: null, consent_version: null, last_reminded_at: null, reminder_count: 0, part_keys: null, delegated_by: null, forward_count: 0, forward_history: [], party_id: null, locale: null, ip: null, device: null, phone: null });
  const fake = installEnvelopeRpcs(db, { newToken: () => (++tokenN).toString(16).padStart(64, "0"), now: () => "2026-10-06T08:00:00.000Z" });
  tokens = fake.tokens;
  rec.automations.mockReset().mockResolvedValue(undefined);
  rec.webhooks.mockReset().mockResolvedValue(undefined);
  await seedTemplate(TPL_A, "Merchant Agreement");
  await seedTemplate(TPL_B, "Fee Schedule");
  // a document only the merchant is on (so a director can be left off it)
  await seedTemplate(TPL_C, "Merchant NDA", { roles: [roles[0]], fields: fields.filter((f) => f.role === "merchant") });
});

const person = (who: typeof ALI, docIds: string[], role: string, step = 1): EnvelopePersonInput => ({ ...who, step, roles: Object.fromEntries(docIds.map((d) => [d, role])) });

/** A draft envelope of the two templates with Ali (merchant, step 1) and Bala (director, step 2) on both documents. */
async function draftEnvelope(opts: { ordered?: boolean; onlyAliOnSecond?: boolean } = {}) {
  // `onlyAliOnSecond`: the second document is the NDA, which only the merchant is on
  const { envelope, documents } = await createEnvelopeDraft(ctx, { title: "Onboarding pack", templateIds: [TPL_A, opts.onlyAliOnSecond ? TPL_C : TPL_B] });
  const ids = documents.map((d) => d.id);
  if (opts.ordered) await updateEnvelope(ctx, envelope.id, { signInOrder: true });
  await setEnvelopeSigners(ctx, envelope.id, [person(ALI, ids, "merchant", 1), person(BALA, opts.onlyAliOnSecond ? [ids[0]] : ids, "director", 2)]);
  return { envelope, documents, ids };
}

const signerRows = () => db.rows("sign_signers") as unknown as SignSignerRow[];
const docRows = () => db.rows("sign_documents") as unknown as SignDocumentRow[];
const aliAnchor = () => signerRows().find((s) => s.email === "ali@kedai.example" && s.party_id === s.id)!;
const balaAnchor = () => signerRows().find((s) => s.email === "bala@kedai.example" && s.party_id === s.id)!;
const look = async (anchor: SignSignerRow): Promise<Lookup> => {
  const token = tokens.get(anchor.id);
  expect(token).toBeTruthy();
  const l = await lookupByToken(ctx.admin, token);
  expect(l).not.toBeNull();
  return l!;
};
const docRow = (id: string) => docRows().find((d) => d.id === id)!;
const loadEnvelopeId = async () => db.rows("sign_envelopes")[0].id as string;
const meta = { ip: "203.0.113.9", device: "Chrome", locale: "en" as const };
const rpcs = (name: string) => db.rpcCalls.filter((c) => c.name === name);

/** Ali fills in and signs everything; Bala then does. Leaves both documents sealing. */
async function everyoneSigns(ids: string[]) {
  await recordConsent(ctx, await look(aliAnchor()), "en", null, null);
  for (const id of ids) await saveAnswers(ctx, pickDocument(await look(aliAnchor()), id)!, { biz: { text: "Kedai Runcit Ali" }, msig: { typed: "Ali" } });
  await finishEnvelope(ctx, await look(aliAnchor()), {}, meta);
  await recordConsent(ctx, await look(balaAnchor()), "en", null, null);
  for (const id of ids) await saveAnswers(ctx, pickDocument(await look(balaAnchor()), id)!, { dsig: { typed: "Bala" } });
  await finishEnvelope(ctx, await look(balaAnchor()), {}, meta);
}

describe("making an envelope", () => {
  it("makes the envelope and its documents from the templates, in order, each a draft with its place and the envelope's options", async () => {
    const { envelope, documents } = await createEnvelopeDraft(ctx, { title: "Onboarding pack", templateIds: [TPL_A, TPL_B] });
    expect(envelope).toMatchObject({ title: "Onboarding pack", status: "draft", reference: "ENV-2026-000001", created_by: USER });
    expect(documents.map((d) => [d.title, d.envelope_position, d.envelope_id, d.status])).toEqual([
      ["Merchant Agreement", 1, envelope.id, "draft"],
      ["Fee Schedule", 2, envelope.id, "draft"],
    ]);
    // forwarding is off in an envelope, and the documents carry the same options as the envelope
    expect(documents.every((d) => d.allow_forwarding === false && d.sign_in_order === envelope.sign_in_order && d.code_required === envelope.code_required)).toBe(true);
    // every document has its own file copy, never the template's
    expect(new Set(documents.map((d) => d.base_path)).size).toBe(2);
  });

  it("refuses the wrong number of documents, the same template twice, and a template that is not this workspace's", async () => {
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A] })).rejects.toMatchObject({ code: "envelope_size" });
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_A] })).rejects.toMatchObject({ code: "envelope_duplicate_template" });
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B, TPL_A, TPL_B, TPL_A, TPL_B, TPL_A] })).rejects.toMatchObject({ code: "envelope_size" });
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_X] })).rejects.toMatchObject({ code: "template_not_found" });
    db.seed("sign_templates", [{ id: TPL_X, account_id: OTHER, name: "Theirs", status: "active", category_id: null, current_version_id: null }]);
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_X] })).rejects.toMatchObject({ code: "template_not_found" });
    expect(db.rows("sign_envelopes")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("removes everything it made when one of the documents cannot be made", async () => {
    // the second template is active but has no saved version: the document cannot be made
    db.seed("sign_templates", [{ id: TPL_X, account_id: ACCT, name: "No version", status: "active", category_id: null, current_version_id: null }]);
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_X] })).rejects.toMatchObject({ code: "template_has_no_version" });
    expect(db.rows("sign_envelopes")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect([...db.files.keys()].filter((p) => p.includes("/base/"))).toEqual([]);
  });

  it("writes the options of the envelope onto every document, and refuses to change them on one document alone", async () => {
    const { envelope, documents } = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B] });
    await updateEnvelope(ctx, envelope.id, { signInOrder: true, codeRequired: true, message: "  Please sign all three.  ", locale: "ms", reminderDays: [9, 2, 2] });
    for (const d of documents) {
      expect(docRow(d.id)).toMatchObject({ sign_in_order: true, code_required: true, message: "Please sign all three.", locale: "ms", reminder_days: [2, 9] });
    }
    await expect(updateDraft(ctx, documents[0].id, { codeRequired: false })).rejects.toMatchObject({ code: "document_in_envelope" });
    await expect(updateDraft(ctx, documents[0].id, { locale: "en" })).rejects.toMatchObject({ code: "document_in_envelope" });
    // the document's own content is still its own
    await expect(updateDraft(ctx, documents[0].id, { title: "Master agreement", mergeValues: { fee: "RM 1" } })).resolves.toMatchObject({ title: "Master agreement" });
    await expect(updateEnvelope(ctx, envelope.id, { title: "" })).rejects.toMatchObject({ code: "bad_title" });
    await expect(updateEnvelope(ctx, envelope.id, { expiresAt: "2020-01-01" })).rejects.toMatchObject({ code: "expiry_in_the_past" });
  });
});

describe("the shared signing list", () => {
  it("saves one person as a row on each document they are on, tied by a party id whose anchor is their first document's row", async () => {
    const { ids } = await draftEnvelope({ onlyAliOnSecond: false });
    const rows = signerRows();
    expect(rows).toHaveLength(4);
    const ali = rows.filter((r) => r.email === "ali@kedai.example");
    expect(ali.map((r) => r.document_id)).toEqual(ids);
    expect(new Set(ali.map((r) => r.party_id)).size).toBe(1);
    expect(ali[0].id).toBe(ali[0].party_id);
    expect(ali[1].id).not.toBe(ali[1].party_id);
    // the two people are different parties
    expect(aliAnchor().party_id).not.toBe(balaAnchor().party_id);
  });

  it("gives a person who is on only one document a row there, and nowhere else", async () => {
    const { ids } = await draftEnvelope({ onlyAliOnSecond: true });
    const bala = signerRows().filter((r) => r.email === "bala@kedai.example");
    expect(bala).toHaveLength(1);
    expect(bala[0].document_id).toBe(ids[0]);
  });

  it("refuses a list that is not sound and says which person and document it is about", async () => {
    const { envelope, ids } = await draftEnvelope();
    const err = async (people: EnvelopePersonInput[]) => (await setEnvelopeSigners(ctx, envelope.id, people).catch((e) => e)) as { code: string; issues: { code: string; detail?: string; document?: string; role?: string }[] };
    expect((await err([person(ALI, ids, "merchant"), person({ ...BALA, email: "ALI@kedai.example" }, ids, "director")])).issues.map((i) => i.code)).toContain("duplicate_person");
    expect((await err([person(ALI, ids, "merchant"), person(BALA, ids, "merchant")])).issues.filter((i) => i.code === "role_two_people").map((i) => i.document)).toEqual(ids);
    expect((await err([person(ALI, ids, "ghost")])).issues[0]).toMatchObject({ code: "signer_role", role: "ghost", document: ids[0] });
    expect((await err([person({ ...ALI, email: "nope" }, ids, "merchant")])).issues[0]).toMatchObject({ code: "signer_email", detail: "0" });
    expect((await err([person({ ...ALI, channel: "whatsapp" as never }, ids, "merchant")])).issues[0]).toMatchObject({ code: "signer_phone" });
    // a person on no document is not saved (a half-made row)
    const rows = await setEnvelopeSigners(ctx, envelope.id, [person(ALI, ids, "merchant"), { ...BALA, roles: {} }]);
    expect(rows.map((r) => r.email)).toEqual(["ali@kedai.example", "ali@kedai.example"]);
    // the people of an envelope are saved through the envelope only
    await expect(setSigners(ctx, ids[0], [{ roleKey: "merchant", kind: "signer", fullName: "X", email: "x@kedai.example", channel: "email", orderNo: 1 }])).rejects.toMatchObject({ code: "document_in_envelope" });
  });

  it("will not change a sent envelope's list", async () => {
    const { envelope, ids } = await draftEnvelope();
    db.rows("sign_envelopes")[0].status = "sent";
    await expect(setEnvelopeSigners(ctx, envelope.id, [person(ALI, ids, "merchant")])).rejects.toMatchObject({ code: "envelope_not_draft" });
    await expect(updateEnvelope(ctx, envelope.id, { title: "x" })).rejects.toMatchObject({ code: "envelope_not_draft" });
  });
});

describe("sending", () => {
  it("lists every problem of every document, each with its document, before anything is sent", async () => {
    const { envelope, ids } = await draftEnvelope();
    // the second document has lost its director
    await setEnvelopeSigners(ctx, envelope.id, [person(ALI, ids, "merchant", 1), person(BALA, [ids[0]], "director", 2)]);
    const err = (await sendEnvelope(ctx, envelope.id).catch((e) => e)) as { code: string; issues: { code: string; document?: string; role?: string }[] };
    expect(err.code).toBe("envelope_not_ready");
    expect(err.issues).toContainEqual(expect.objectContaining({ code: "role_without_person", role: "director", document: ids[1] }));
    expect(err.issues.every((i) => !i.document || ids.includes(i.document))).toBe(true);
    expect(rpcs("sign_send_envelope")).toHaveLength(0);
    expect(rec.webhooks).not.toHaveBeenCalled();
  });

  it("refuses the whole envelope when the month's limit has no room for all its documents, and stores nothing", async () => {
    const { envelope } = await draftEnvelope();
    db.rpcHandlers.account_usage = async () => ({ data: { limits: { sign_documents_per_month: 5 }, sign_documents_month: 4 }, error: null });
    const before = db.files.size;
    const err = (await sendEnvelope(ctx, envelope.id).catch((e) => e)) as { code: string; status: number; issues: { code: string; detail: string }[] };
    expect(err).toMatchObject({ code: "sign_limit_reached", status: 429 });
    expect(err.issues[0]).toMatchObject({ code: "envelope_exceeds_limit", detail: "2:1" });
    expect(rpcs("sign_send_envelope")).toHaveLength(0);
    expect(db.files.size).toBe(before);
    expect(mail).toHaveLength(0);
    // with room for both, it goes
    db.rpcHandlers.account_usage = async () => ({ data: { limits: { sign_documents_per_month: 5 }, sign_documents_month: 3 }, error: null });
    await expect(sendEnvelope(ctx, envelope.id)).resolves.toMatchObject({ envelopeId: envelope.id });
  });

  it("sends every document in one call with one expiry, and invites each person of the first step ONCE with ONE link", async () => {
    const { envelope, ids } = await draftEnvelope();
    const res = await sendEnvelope(ctx, envelope.id);
    expect(res).toMatchObject({ envelopeId: envelope.id, reference: "ENV-2026-000001", expiresAt: "2026-10-20T08:00:00.000Z" });
    expect(res.documents.map((d) => d.id)).toEqual(ids);
    const call = rpcs("sign_send_envelope");
    expect(call).toHaveLength(1);
    expect(call[0].args).toMatchObject({ p_envelope: envelope.id, p_expires_at: "2026-10-20T08:00:00.000Z", p_actor: USER });
    expect((call[0].args.p_docs as { document_id: string; base_path: string }[]).map((d) => d.document_id)).toEqual(ids);
    expect((call[0].args.p_docs as { base_path: string }[]).every((d) => /\/base\/sent-[0-9a-f]{64}\.pdf$/.test(d.base_path))).toBe(true);
    // without signing order both people are invited at once: one message each, never one per document
    expect(mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example"]);
    expect(res.invited).toHaveLength(2);
    const aliMail = mail.find((m) => m.to === "ali@kedai.example")!;
    expect(aliMail.subject).toBe("Gokula asked you to sign 2 documents: Onboarding pack");
    expect(aliMail.text).toContain("1. Merchant Agreement");
    expect(aliMail.text).toContain("2. Fee Schedule");
    expect(aliMail.text.match(/https:\/\/halo\.test\/s\/[0-9a-f]{64}/g)).toHaveLength(1); // one link for both documents
    expect(aliMail.text).toContain(`https://halo.test/s/${tokens.get(aliAnchor().id)}`);
  });
});

describe("one person, one link, one sitting", () => {
  it("finds the person's documents through their link, and only theirs", async () => {
    const { ids } = await draftEnvelope({ onlyAliOnSecond: false });
    await sendEnvelope(ctx, (await loadEnvelopeId()));
    const ali = await look(aliAnchor());
    expect(ali.party?.members.map((m) => m.doc.id)).toEqual(ids);
    expect(ali.party?.members.every((m) => m.signer.email === "ali@kedai.example")).toBe(true);
    const view = await buildView(ctx, ali, true);
    expect(view.envelope).toMatchObject({ title: "Onboarding pack", reference: "ENV-2026-000001", count: 2, current: ids[0], state: "active" });
    expect(view.envelope?.documents.map((d) => [d.title, d.position, d.state])).toEqual([["Merchant Agreement", 1, "active"], ["Fee Schedule", 2, "active"]]);
    expect(view.needsConsent).toBe(true);
  });

  it("never lists a document the person is not a signer of, and a person's page never shows another person's rows", async () => {
    const { ids } = await draftEnvelope({ onlyAliOnSecond: true });
    await sendEnvelope(ctx, await loadEnvelopeId());
    const bala = await look(balaAnchor());
    expect(bala.party?.members.map((m) => m.doc.id)).toEqual([ids[0]]);
    // asking for the second document with Bala's link is the answer a bad link gets
    expect(pickDocument(bala, ids[1])).toBeNull();
    const view = await buildView(ctx, bala, true);
    expect(view.envelope?.count).toBe(1);
    expect(view.envelope?.documents.map((d) => d.id)).toEqual([ids[0]]);
    // and not even the title of the other document is in anything Bala's page was given
    expect(JSON.stringify(view)).not.toContain("Merchant NDA");
    expect(JSON.stringify(view)).not.toContain("ali@kedai.example");
    // another document id (a plain uuid of anywhere else) finds nothing either
    expect(pickDocument(bala, "00000000-0000-4000-8000-000000000000")).toBeNull();
    // a link that is not an envelope's has no other document to pick
    const plain = { ...bala, party: null };
    expect(pickDocument(plain, ids[0])).toBeNull();
  });

  it("shows only the envelope's title and count before the code, and no document of it", async () => {
    await draftEnvelope();
    await updateEnvelope(ctx, await loadEnvelopeId(), { codeRequired: true });
    await sendEnvelope(ctx, await loadEnvelopeId());
    const ali = await look(aliAnchor());
    const view = await buildView(ctx, ali, false);
    expect(view.needsCode).toBe(true);
    expect(view.content).toBeNull();
    expect(view.envelope).toMatchObject({ title: "Onboarding pack", count: 2, documents: [] });
    expect((await buildView(ctx, ali, true)).envelope?.documents).toHaveLength(2);
  });

  it("does not take a link whose row names another person's party (only an anchor's own link is a link)", async () => {
    await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    const bala = balaAnchor();
    // a row that was tampered with: Bala's link now names Ali's party
    db.rows("sign_signers").find((s) => s.id === bala.id)!.party_id = aliAnchor().party_id;
    expect(await lookupByToken(ctx.admin, tokens.get(bala.id))).toBeNull();
  });

  it("records the first look and the agreement once for every document, with one timestamp and one wording", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    const ali = await look(aliAnchor());
    await markViewed(ctx, ali, "203.0.113.9", "Chrome");
    expect(rpcs("sign_envelope_mark_viewed")).toHaveLength(1);
    expect(rpcs("sign_mark_viewed")).toHaveLength(0);
    expect(rec.webhooks.mock.calls.filter((c) => c[2] === "sign.viewed").map((c) => c[3].document_id)).toEqual(ids);
    await recordConsent(ctx, await look(aliAnchor()), "ms", "203.0.113.9", "Chrome");
    expect(rpcs("sign_envelope_record_consent")).toHaveLength(1);
    expect(rpcs("sign_record_consent")).toHaveLength(0);
    const rows = signerRows().filter((r) => r.email === "ali@kedai.example");
    expect(rows.map((r) => r.consented_at)).toEqual(["2026-10-06T08:00:00.000Z", "2026-10-06T08:00:00.000Z"]);
    expect(new Set(rows.map((r) => r.consent_version)).size).toBe(1);
    // Bala's rows were not touched by Ali's consent
    expect(signerRows().filter((r) => r.email === "bala@kedai.example").every((r) => !r.consented_at)).toBe(true);
    expect((await buildView(ctx, await look(aliAnchor()), true)).needsConsent).toBe(false);
  });

  it("uses the code of the link for every document: one cookie, one code", async () => {
    await draftEnvelope();
    await updateEnvelope(ctx, await loadEnvelopeId(), { codeRequired: true });
    await sendEnvelope(ctx, await loadEnvelopeId());
    const ali = await look(aliAnchor());
    const { codeRequiredFor, sendCode } = await import("./signing");
    expect(codeRequiredFor(ali)).toBe(true);
    // the code goes to the address of the link, from the document the link belongs to, whichever document is asked for
    const second = pickDocument(ali, ali.party!.members[1].doc.id)!;
    expect(second.tokenSigner.id).toBe(aliAnchor().id);
    await expect(sendCode(ctx, second, async () => true)).resolves.toMatchObject({ ok: true });
    const stored = db.rows("sign_signer_secrets").find((s) => s.signer_id === aliAnchor().id)!;
    expect(stored.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mail.at(-1)!.to).toBe("ali@kedai.example");
  });
});

describe("finishing in order, and finishing again after a failure", () => {
  it("completes each document in order, skips the ones already done, and never signs a document twice", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    mail.length = 0;
    await recordConsent(ctx, await look(aliAnchor()), "en", null, null);
    for (const id of ids) await saveAnswers(ctx, pickDocument(await look(aliAnchor()), id)!, { biz: { text: "Kedai Runcit Ali" }, msig: { typed: "Ali" } });
    const first = await finishEnvelope(ctx, await look(aliAnchor()), {}, meta);
    expect(first).toEqual({ completed: ids, remaining: [], sealing: false });
    const calls = rpcs("sign_complete_signer").map((c) => signerRows().find((s) => s.id === c.args.p_signer)!.document_id);
    expect(calls).toEqual(ids);
    // pressing Finish again does nothing and signs nothing twice
    const again = await finishEnvelope(ctx, await look(aliAnchor()), {}, meta);
    expect(again).toEqual({ completed: [], remaining: [], sealing: false });
    expect(rpcs("sign_complete_signer")).toHaveLength(2);
    // the envelope reads in progress, and the page now says everything was signed
    expect((await loadEnvelope(ctx, (await loadEnvelopeId()))).status).toBe("in_progress");
    expect((await buildView(ctx, await look(aliAnchor()), true)).envelope?.state).toBe("signed");
  });

  it("stops at the document that cannot be finished, names it, keeps the earlier ones signed, and resumes where it stopped", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    await recordConsent(ctx, await look(aliAnchor()), "en", null, null);
    // the first document is ready; the second has nothing entered
    await saveAnswers(ctx, pickDocument(await look(aliAnchor()), ids[0])!, { biz: { text: "Kedai Runcit Ali" }, msig: { typed: "Ali" } });
    const err = (await finishEnvelope(ctx, await look(aliAnchor()), {}, meta).catch((e) => e)) as { code: string; issues: { code: string; field?: string; document?: string }[] };
    expect(err.code).toBe("missing_required");
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.issues.every((i) => i.document === ids[1])).toBe(true);
    expect(err.issues.map((i) => i.field).sort()).toEqual(["biz", "msig"]);
    // the first document stayed signed, the second was not touched
    const signed = (id: string) => signerRows().find((s) => s.document_id === id && s.email === "ali@kedai.example")!.status;
    expect([signed(ids[0]), signed(ids[1])]).toEqual(["signed", "viewed" === signed(ids[1]) ? "viewed" : "sent"]);
    expect(rpcs("sign_complete_signer")).toHaveLength(1);
    // the page shows what remains
    const view = await buildView(ctx, await look(aliAnchor()), true);
    expect(view.envelope?.documents.map((d) => d.state)).toEqual(["signed", "active"]);
    expect(view.envelope?.state).toBe("active");
    // the person answers the second document and presses Finish again: only the second is completed
    await saveAnswers(ctx, pickDocument(await look(aliAnchor()), ids[1])!, { biz: { text: "Kedai Runcit Ali" }, msig: { typed: "Ali" } });
    const done = await finishEnvelope(ctx, await look(aliAnchor()), {}, meta);
    expect(done).toEqual({ completed: [ids[1]], remaining: [], sealing: false });
    expect(rpcs("sign_complete_signer")).toHaveLength(2);
  });

  it("tags a database refusal with its document too (a document that was closed meanwhile)", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    await recordConsent(ctx, await look(aliAnchor()), "en", null, null);
    for (const id of ids) await saveAnswers(ctx, pickDocument(await look(aliAnchor()), id)!, { biz: { text: "K" }, msig: { typed: "Ali" } });
    const fresh = await look(aliAnchor());
    // the second document was cancelled by someone after the page loaded
    docRow(ids[1]).status = "voided";
    const err = (await finishEnvelope(ctx, fresh, {}, meta).catch((e) => e)) as { code: string; issues: { document?: string }[] };
    expect(err.code).toBe("document_not_open");
    expect(err.issues[0].document).toBe(ids[1]);
    // the first document was completed, the second was tried and refused: nothing else
    expect(rpcs("sign_complete_signer")).toHaveLength(2);
    expect(signerRows().find((x) => x.document_id === ids[0] && x.email === "ali@kedai.example")!.status).toBe("signed");
  });

  it("with signing order, invites the next step only when the step is finished on EVERY document, and with ONE message naming that person's documents", async () => {
    const { ids } = await draftEnvelope({ ordered: true });
    await sendEnvelope(ctx, await loadEnvelopeId());
    // only Ali (step 1) was invited
    expect(mail.map((m) => m.to)).toEqual(["ali@kedai.example"]);
    mail.length = 0;
    await recordConsent(ctx, await look(aliAnchor()), "en", null, null);
    await saveAnswers(ctx, pickDocument(await look(aliAnchor()), ids[0])!, { biz: { text: "K" }, msig: { typed: "Ali" } });
    await saveAnswers(ctx, pickDocument(await look(aliAnchor()), ids[1])!, { biz: { text: "K" }, msig: { typed: "Ali" } });
    // finishing the first document alone (through the same function a document alone uses) invites nobody
    await completeSigning(ctx, pickDocument(await look(aliAnchor()), ids[0])!, {}, meta);
    expect(mail).toHaveLength(0);
    expect(tokens.get(balaAnchor().id)).toBeUndefined();
    // finishing the second finishes the step on every document: Bala is invited ONCE
    await completeSigning(ctx, pickDocument(await look(aliAnchor()), ids[1])!, {}, meta);
    expect(mail.map((m) => m.to)).toEqual(["bala@kedai.example"]);
    expect(mail[0].subject).toContain("2 documents");
    expect(mail[0].text).toContain("1. Merchant Agreement");
    expect(mail[0].text).toContain("2. Fee Schedule");
    expect(mail[0].text).toContain(`https://halo.test/s/${tokens.get(balaAnchor().id)}`);
    // only the anchor row has a link
    expect(db.rows("sign_signer_secrets").filter((s) => signerRows().find((x) => x.id === s.signer_id)!.email === "bala@kedai.example")).toHaveLength(1);
  });
});

describe("sealing and the one message at the end", () => {
  async function sealWithCertificate() {
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
    return runSealing({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now }, 4);
  }
  const textOf = async (bytes: Uint8Array) => {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const out: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) for (const it of (await (await pdf.getPage(i)).getTextContent()).items) if ("str" in it) out.push(it.str);
    return out.join(" ");
  };

  it("seals each document on its own with its own certificate, listing the documents signed with it, then sends ONE message to each person with every signed copy", async () => {
    const { ids } = await draftEnvelope({ ordered: true });
    await sendEnvelope(ctx, await loadEnvelopeId());
    await everyoneSigns(ids);
    expect(ids.map((id) => docRow(id).status)).toEqual(["sealing", "sealing"]);
    mail.length = 0;
    const out = await sealWithCertificate();
    expect(out).toEqual({ claimed: 2, completed: 2, retry: 0 });
    expect(ids.map((id) => docRow(id).status)).toEqual(["completed", "completed"]);
    expect((await loadEnvelope(ctx, await loadEnvelopeId())).status).toBe("completed");

    // each file is its own sealed document, and its certificate (a file of its own, sealed too: migration 178) says what it was signed with
    const finals = ids.map((id) => db.files.get(docRow(id).final_path!)!);
    for (const bytes of finals) expect(verifySealed(bytes).ok).toBe(true);
    const certificates = ids.map((id) => db.files.get(String(docRow(id).certificate_path))!);
    for (const bytes of certificates) expect(verifySealed(bytes).ok).toBe(true);
    // the signed file carries no certificate pages; the certificate names the signed file by its fingerprint
    expect((await textOf(finals[0])).toUpperCase()).not.toContain("PART OF DOCUMENT COLLECTION");
    const first = (await textOf(certificates[0])).replace(/\s+/g, " ").toUpperCase();
    expect(first).toContain("PART OF DOCUMENT COLLECTION ENV-2026-000001 (DOCUMENT 1 OF 2)");
    expect(first).toContain("1. MERCHANT AGREEMENT (THIS DOCUMENT)".toUpperCase());
    expect(first).toContain("2. FEE SCHEDULE");
    for (const id of ids) expect(first).toContain(docRow(id).base_sha256!.toUpperCase());
    expect(first.replace(/\s/g, "")).toContain(String(docRow(ids[0]).final_sha256).toUpperCase());
    expect((await textOf(certificates[1])).replace(/\s+/g, " ").toUpperCase()).toContain("(DOCUMENT 2 OF 2)");

    // ONE message each (Ali, Bala and the sender), carrying both signed copies; no message of a single document's own
    expect(mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example", "gokula@vircle.example"]);
    expect(mail.every((m) => m.subject === "Signed: Onboarding pack (2 documents)")).toBe(true);
    // (each document's signed file and its certificate: four attachments)
    expect(mail.every((m) => Array.isArray(m.attachments) && m.attachments.length === 4)).toBe(true);
    // both chains say the envelope completed, once
    expect(rpcs("sign_envelope_settle")).toHaveLength(2);
    expect(db.rpcCalls.filter((c) => c.name === "sign_log" && c.args.p_type === "envelope_completed")).toHaveLength(2);
    // the webhook and the automation hear about each document, with the envelope in the payload
    const completed = rec.webhooks.mock.calls.filter((c) => c[2] === "sign.completed");
    expect(completed.map((c) => c[3].document_id).sort()).toEqual([...ids].sort());
    expect(completed.every((c) => c[3].envelope_id === docRow(ids[0]).envelope_id)).toBe(true);
  });

  it("sends the message once even if the last document is settled twice", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    await everyoneSigns(ids);
    await sealWithCertificate();
    const sent = mail.length;
    await settleEnvelope(ctx, await loadEnvelopeId());
    await settleEnvelope(ctx, await loadEnvelopeId());
    expect(mail).toHaveLength(sent);
  });

  it("says nothing of an envelope until its last document is complete", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    await everyoneSigns(ids);
    mail.length = 0;
    // only the first document is sealed
    db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: ids[0], account_id: ACCT }], error: null });
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true }]);
    await runSealing({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now }, 1);
    expect(docRow(ids[0]).status).toBe("completed");
    expect(mail).toHaveLength(0);
    expect((await loadEnvelope(ctx, await loadEnvelopeId())).status).toBe("sealing");
  });
});

describe("cancelling, declining and running out of time", () => {
  it("cancels every open document together, tells each waiting person once, and keeps the reason", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    mail.length = 0;
    await voidEnvelope(ctx, await loadEnvelopeId(), "Wrong merchant");
    expect(ids.map((id) => docRow(id).status)).toEqual(["voided", "voided"]);
    expect((await loadEnvelope(ctx, await loadEnvelopeId())).status).toBe("voided");
    expect(rpcs("sign_void_envelope")).toHaveLength(1);
    // one message each, naming the envelope, not one per document
    expect(mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example"]);
    expect(mail.every((m) => m.subject === "Cancelled: Onboarding pack")).toBe(true);
    const webhooks = rec.webhooks.mock.calls.filter((c) => c[2] === "sign.voided");
    expect(webhooks.map((c) => c[3].document_id).sort()).toEqual([...ids].sort());
    // a link then shows how it ended, and nothing can be done on it
    expect((await buildView(ctx, await look(aliAnchor()), true)).envelope?.state).toBe("voided");
  });

  it("refuses to cancel once a document is fully signed, and says why; before any signing it is allowed", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    docRow(ids[0]).status = "sealing";
    await expect(voidEnvelope(ctx, await loadEnvelopeId(), "x")).rejects.toMatchObject({ code: "envelope_partly_completed", status: 409 });
    docRow(ids[0]).status = "completed";
    await expect(voidEnvelope(ctx, await loadEnvelopeId(), "x")).rejects.toMatchObject({ code: "envelope_partly_completed" });
    expect(rpcs("sign_void_envelope")).toHaveLength(0);
    docRow(ids[0]).status = "sent";
    await expect(voidEnvelope(ctx, await loadEnvelopeId(), "x")).resolves.toBeUndefined();
    // already ended: nothing to cancel; a draft was never sent
    await expect(voidEnvelope(ctx, await loadEnvelopeId(), "x")).rejects.toMatchObject({ code: "document_already_final" });
  });

  it("will not cancel an envelope that was never sent", async () => {
    await draftEnvelope();
    await expect(voidEnvelope(ctx, await loadEnvelopeId(), "x")).rejects.toMatchObject({ code: "envelope_not_sent" });
  });

  it("refuses to send, cancel, remind, resend, change or move on ONE document of an envelope, with a clear reason", async () => {
    const { ids } = await draftEnvelope();
    await expect(sendDocument(ctx, ids[0])).rejects.toMatchObject({ code: "document_in_envelope", status: 409 });
    await expect(deleteDraft(ctx, ids[0])).rejects.toMatchObject({ code: "document_in_envelope" });
    await sendEnvelope(ctx, await loadEnvelopeId());
    const ali = signerRows().find((s) => s.document_id === ids[0] && s.email === "ali@kedai.example")!;
    await expect(voidDocument(ctx, ids[0], "x")).rejects.toMatchObject({ code: "document_in_envelope" });
    await expect(remindSigner(ctx, ids[0], ali.id)).rejects.toMatchObject({ code: "document_in_envelope" });
    await expect(resendSigner(ctx, ids[0], ali.id)).rejects.toMatchObject({ code: "document_in_envelope" });
    await expect(changeRecipient(ctx, ids[0], ali.id, { fullName: "Z", email: "z@kedai.example" })).rejects.toMatchObject({ code: "document_in_envelope" });
    // nothing was sent or changed by any of them
    expect(rpcs("sign_void_document")).toHaveLength(0);
    expect(rpcs("sign_rotate_token")).toHaveLength(0);
    expect(rpcs("sign_change_recipient")).toHaveLength(0);
    expect(rpcs("sign_send_document")).toHaveLength(0);
  });

  it("declines every open document when one person declines, announces each, and tells the others and the sender once", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    mail.length = 0;
    await declineSigning(ctx, await look(aliAnchor()), "Clause 4", { ip: null, device: null });
    expect(rpcs("sign_envelope_decline")).toHaveLength(1);
    expect(rpcs("sign_decline_signer")).toHaveLength(0);
    expect(ids.map((id) => docRow(id).status)).toEqual(["declined", "declined"]);
    expect((await loadEnvelope(ctx, await loadEnvelopeId())).status).toBe("declined");
    // the sender and Bala (invited, not finished), each once; not Ali, who declined
    expect(mail.map((m) => m.to).sort()).toEqual(["bala@kedai.example", "gokula@vircle.example"]);
    expect(mail.every((m) => m.subject === "Declined: Onboarding pack")).toBe(true);
    expect(mail[0].text).toContain("Ali bin Ahmad declined");
    expect(mail[0].text).toContain("Clause 4");
    expect(rec.webhooks.mock.calls.filter((c) => c[2] === "sign.declined")).toHaveLength(2);
  });

  it("tells an envelope's people once that it expired, not once for each document", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    for (const id of ids) docRow(id).expires_at = "2026-10-05T08:00:00.000Z";
    mail.length = 0;
    const out = await runExpiry({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now });
    expect(out).toEqual({ expired: 2 });
    expect(ids.map((id) => docRow(id).status)).toEqual(["expired", "expired"]);
    expect((await loadEnvelope(ctx, await loadEnvelopeId())).status).toBe("expired");
    expect(mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example", "gokula@vircle.example"]);
    expect(rpcs("sign_envelope_claim_end")).toHaveLength(2);
    // each document is still announced to the webhook
    expect(rec.webhooks.mock.calls.filter((c) => c[2] === "sign.expired")).toHaveLength(2);
  });

  it("gives everyone more time: the same new date on each open document and on the envelope", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    const { extendEnvelopeExpiry } = await import("./envelopes");
    await expect(extendEnvelopeExpiry(ctx, await loadEnvelopeId(), "2026-10-06T07:00:00Z")).rejects.toMatchObject({ code: "expiry_in_the_past" });
    const out = await extendEnvelopeExpiry(ctx, await loadEnvelopeId(), "2026-11-01T08:00:00.000Z");
    expect(out.expiresAt).toBe("2026-11-01T08:00:00.000Z");
    expect(ids.map((id) => docRow(id).expires_at)).toEqual(["2026-11-01T08:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
    expect((await loadEnvelope(ctx, await loadEnvelopeId())).expires_at).toBe("2026-11-01T08:00:00.000Z");
    // one document alone cannot be given a different date
    const { extendExpiry } = await import("./progress");
    await expect(extendExpiry(ctx, ids[0], "2026-12-01T08:00:00.000Z")).rejects.toMatchObject({ code: "document_in_envelope" });
  });
});

describe("remind, resend and change recipient act on the person", () => {
  it("reminds with one message naming only the documents left, a fresh link, and the old one dead", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    const before = tokens.get(aliAnchor().id);
    // Ali finished the first document only
    await recordConsent(ctx, await look(aliAnchor()), "en", null, null);
    await saveAnswers(ctx, pickDocument(await look(aliAnchor()), ids[0])!, { biz: { text: "K" }, msig: { typed: "Ali" } });
    await completeSigning(ctx, pickDocument(await look(aliAnchor()), ids[0])!, {}, meta);
    mail.length = 0;
    const r = await remindEnvelopePerson(ctx, await loadEnvelopeId(), aliAnchor().id);
    expect(r.delivery.status).toBe("sent");
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe("ali@kedai.example");
    expect(mail[0].subject).toBe("Reminder: please sign Onboarding pack");
    expect(mail[0].text).toContain("1. Fee Schedule");
    expect(mail[0].text).not.toContain("Merchant Agreement");
    expect(tokens.get(aliAnchor().id)).not.toBe(before);
    expect(await lookupByToken(ctx.admin, before)).toBeNull();
    expect(await lookupByToken(ctx.admin, tokens.get(aliAnchor().id))).not.toBeNull();
    // the reminder is recorded on the rows that are still open
    const open = signerRows().filter((s) => s.email === "ali@kedai.example" && s.status !== "signed");
    expect(open.every((s) => s.reminder_count === 1 && s.last_reminded_at === "2026-10-06T08:00:00.000Z")).toBe(true);
  });

  it("resends the invitation with a new link, and refuses a row that is not a person's anchor", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    mail.length = 0;
    const r = await resendEnvelopePerson(ctx, await loadEnvelopeId(), balaAnchor().id);
    expect(r.delivery.status).toBe("sent");
    expect(mail.map((m) => m.to)).toEqual(["bala@kedai.example"]);
    expect(mail[0].subject).toContain("2 documents");
    const second = signerRows().find((s) => s.document_id === ids[1] && s.email === "bala@kedai.example")!;
    await expect(resendEnvelopePerson(ctx, await loadEnvelopeId(), second.id)).rejects.toMatchObject({ code: "signer_not_found" });
    await expect(resendEnvelopePerson(ctx, await loadEnvelopeId(), "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "signer_not_found" });
  });

  it("puts a different person on all the documents at once, with one message and one new link", async () => {
    await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    mail.length = 0;
    const anchor = aliAnchor();
    const r = await changeEnvelopeRecipient(ctx, await loadEnvelopeId(), anchor.id, { fullName: "Ali's Finance", email: "finance@kedai.example" });
    expect(r.delivery.status).toBe("sent");
    expect(mail.map((m) => m.to)).toEqual(["finance@kedai.example"]);
    const rows = signerRows().filter((s) => s.party_id === anchor.party_id);
    expect(rows.map((s) => [s.full_name, s.email])).toEqual([["Ali's Finance", "finance@kedai.example"], ["Ali's Finance", "finance@kedai.example"]]);
    // the person already on the envelope cannot be put in twice
    await expect(changeEnvelopeRecipient(ctx, await loadEnvelopeId(), anchor.id, { fullName: "Bala again", email: "BALA@kedai.example" })).rejects.toMatchObject({ code: "already_on_document" });
    await expect(changeEnvelopeRecipient(ctx, await loadEnvelopeId(), anchor.id, { fullName: "", email: "x" })).rejects.toMatchObject({ code: "signer_details" });
  });

  it("will not replace a person who has already signed one of the documents", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    await recordConsent(ctx, await look(aliAnchor()), "en", null, null);
    await saveAnswers(ctx, pickDocument(await look(aliAnchor()), ids[0])!, { biz: { text: "K" }, msig: { typed: "Ali" } });
    await completeSigning(ctx, pickDocument(await look(aliAnchor()), ids[0])!, {}, meta);
    await expect(changeEnvelopeRecipient(ctx, await loadEnvelopeId(), aliAnchor().id, { fullName: "Other", email: "other@kedai.example" })).rejects.toMatchObject({ code: "envelope_person_has_signed", status: 409 });
  });
});

describe("what other systems see, and where a document stands", () => {
  it("announces each document's own events with the envelope in the payload (and a single document with none)", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    const sent = rec.webhooks.mock.calls.filter((c) => c[2] === "sign.sent");
    expect(sent.map((c) => c[3].document_id)).toEqual(ids);
    expect(sent.every((c) => c[3].envelope_id === docRow(ids[0]).envelope_id && c[3].title !== "Onboarding pack")).toBe(true);
  });

  it("derives the envelope's status from its documents the way the database does", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    expect((await envelopeData(ctx, await loadEnvelopeId())).envelope.status).toBe("sent");
    docRow(ids[0]).status = "completed";
    expect((await import("./envelopes")).statusOf(docRows())).toBe("in_progress");
  });

  it("says on a document's own page which envelope it is in, with its siblings' titles and states", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    const { envelopeBrief } = await import("./envelopes");
    const brief = await envelopeBrief(ctx, docRow(ids[0]).envelope_id);
    expect(brief).toMatchObject({ reference: "ENV-2026-000001", title: "Onboarding pack", status: "sent" });
    expect(brief?.documents.map((d) => [d.position, d.title, d.status])).toEqual([[1, "Merchant Agreement", "sent"], [2, "Fee Schedule", "sent"]]);
    expect(await envelopeBrief(ctx, null)).toBeNull();
  });

  it("adds only a count to the public verify page of a document of an envelope", async () => {
    const { ids } = await draftEnvelope();
    await sendEnvelope(ctx, await loadEnvelopeId());
    Object.assign(docRow(ids[0]), { status: "completed", completed_at: "2026-10-06T09:00:00Z", final_sha256: "c".repeat(64), page_count: 1 });
    db.rpcHandlers.sign_verify_chain = async () => ({ data: { ok: true, events: 7, head: "x" }, error: null });
    const view = await loadVerification(ctx.admin, ids[0], ctx.now);
    expect(view?.envelope).toEqual({ documents: 2 });
    expect(JSON.stringify(view)).not.toContain("Fee Schedule");
    expect(JSON.stringify(view)).not.toContain("Onboarding pack");
  });
});

describe("deleting, and another workspace", () => {
  it("deletes a draft envelope with its drafts and their files, and refuses one that was sent", async () => {
    const { envelope, ids } = await draftEnvelope();
    const files = [...db.files.keys()].filter((p) => p.includes(`/${ids[0]}/`) || p.includes(`/${ids[1]}/`));
    expect(files.length).toBeGreaterThan(0);
    await deleteEnvelope(ctx, envelope.id);
    expect(db.rows("sign_envelopes")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    for (const f of files) expect(db.files.has(f)).toBe(false);
    // the template's own file is untouched
    expect(db.files.has(`account-${ACCT}/templates/${TPL_A}/v1.pdf`)).toBe(true);
    const again = await draftEnvelope();
    await sendEnvelope(ctx, again.envelope.id);
    await expect(deleteEnvelope(ctx, again.envelope.id)).rejects.toMatchObject({ code: "envelope_not_deletable" });
  });

  it("keeps a completed envelope until every document's retention date has passed", async () => {
    const { envelope, ids } = await draftEnvelope();
    await sendEnvelope(ctx, envelope.id);
    for (const id of ids) Object.assign(docRow(id), { status: "completed", retain_until: "2033-10-06T08:00:00Z" });
    db.rows("sign_envelopes")[0].status = "completed";
    await expect(deleteEnvelope(ctx, envelope.id)).rejects.toMatchObject({ code: "document_retained" });
    expect(db.rows("sign_documents")).toHaveLength(2);
  });

  it("does not let another workspace read, send, void or change an envelope by its id", async () => {
    const { envelope } = await draftEnvelope();
    const other: SignCtx = { ...ctx, accountId: OTHER };
    db.seed("accounts", [{ id: OTHER, name: "Other Sdn Bhd", brand_name: null, timezone: "UTC" }]);
    await expect(envelopeData(other, envelope.id)).rejects.toMatchObject({ code: "envelope_not_found", status: 404 });
    await expect(sendEnvelope(other, envelope.id)).rejects.toMatchObject({ code: "envelope_not_found" });
    await expect(voidEnvelope(other, envelope.id, "x")).rejects.toMatchObject({ code: "envelope_not_found" });
    await expect(updateEnvelope(other, envelope.id, { title: "Mine now" })).rejects.toMatchObject({ code: "envelope_not_found" });
    await expect(setEnvelopeSigners(other, envelope.id, [])).rejects.toMatchObject({ code: "envelope_not_found" });
    await expect(deleteEnvelope(other, envelope.id)).rejects.toMatchObject({ code: "envelope_not_found" });
    await expect(remindEnvelopePerson(other, envelope.id, aliAnchor().id)).rejects.toMatchObject({ code: "envelope_not_found" });
    expect((await loadEnvelope(ctx, envelope.id)).title).toBe("Onboarding pack");
  });

  it("lists nothing of a draft's problems once it was sent, and says whether the limit has room for a draft", async () => {
    const { envelope } = await draftEnvelope();
    db.rpcHandlers.account_usage = async () => ({ data: { limits: { sign_documents_per_month: 3 }, sign_documents_month: 2 }, error: null });
    const draft = await envelopeData(ctx, envelope.id);
    expect(draft.headroom).toEqual({ limit: 3, used: 2, remaining: 1, needed: 2, fits: false });
    expect(draft.documents.map((d) => d.title)).toEqual(["Merchant Agreement", "Fee Schedule"]);
    db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 2 }, error: null });
    await sendEnvelope(ctx, envelope.id);
    const sent = await envelopeData(ctx, envelope.id);
    expect(sent.problems).toEqual([]);
    expect(sent.headroom).toBeNull();
    expect(sent.signers).toHaveLength(4);
  });
});
