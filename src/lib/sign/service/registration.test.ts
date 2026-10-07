import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { assertCanAddContact, UsageLimitError } from "@/lib/platform/usage";
import { RATE_LIMITS } from "@/lib/rate-limit";

import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import type { PlacedField } from "../pdf/types";
import { issueFormToken } from "../registration/token";
import type { RegistrationFormRow } from "../registration/types";
import type { SignRole } from "../types";
import { FakeDb } from "./fake-db";
import { buildRegisterView, loadPublicForm, submitRegistration, type SubmitEnv, type SubmitOutcome } from "./registration";

// The tag writer is proved in lib/contacts (tag-events.test.ts); here it is a spy, so "once per registration" can be asserted.
vi.mock("@/lib/contacts/tag-events", () => ({ addContactTagAndDispatch: vi.fn(async () => ({ added: true, dispatched: true })) }));
// The contact limit is a count query FakeDb cannot answer; its own tests are in lib/platform. Here it is a switch.
vi.mock("@/lib/platform/usage", async (original) => ({ ...(await original<typeof import("@/lib/platform/usage")>()), assertCanAddContact: vi.fn(async () => {}) }));

const ACCT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const FORM = "44444444-4444-4444-8444-444444444444";
const TPL = "55555555-5555-4555-8555-555555555555";
const TAG = "66666666-6666-4666-8666-666666666666";
const SLUG = "merchant-sign-up-7k2m9x4q";
const IP = "203.0.113.9";
const HOUR = 3600_000;

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "bizname", type: "static_text", role: "sender", merge: "business_name", page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.04, required: false },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

interface Mail {
  to: string;
  subject: string;
  text: string;
}

let db: FakeDb;
let mail: Mail[];
let calls: { key: string; limit: number }[];
let denyKey: (key: string) => boolean;
let captcha: { enabled: boolean; verify: ReturnType<typeof vi.fn<(token: string | null, ip: string | null) => Promise<boolean>>> };
let usage: { limits: Record<string, number>; sign_documents_month: number };

const form = (over: Partial<RegistrationFormRow> = {}): RegistrationFormRow => ({
  id: FORM,
  account_id: ACCT,
  slug: SLUG,
  name: "Merchant sign-up",
  active: true,
  mode: "sign",
  send_document: true,
  template_id: TPL,
  applicant_role_key: "merchant",
  signers_other: [{ role_key: "director", name: "Siti Director", email: "siti@vircle.example", channel: "email", phone: null }],
  copy_recipients: [],
  contact_tag_id: TAG,
  fields: { full_name: "required", email: "required", phone: "optional", company: "required" },
  consent_text: {},
  success_message: {},
  default_locale: "en",
  daily_cap: 100,
  created_by: ADMIN,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

async function setup(over: Partial<RegistrationFormRow> = {}) {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  db = new FakeDb();
  mail = [];
  calls = [];
  denyKey = () => false;
  captcha = { enabled: false, verify: vi.fn<(token: string | null, ip: string | null) => Promise<boolean>>(async () => true) };
  usage = { limits: {}, sign_documents_month: 0 };
  vi.mocked(addContactTagAndDispatch).mockClear();
  vi.mocked(addContactTagAndDispatch).mockResolvedValue({ added: true, dispatched: true });
  vi.mocked(assertCanAddContact).mockReset();
  vi.mocked(assertCanAddContact).mockResolvedValue(undefined);

  const src = await makePdf([{ ...A4 }]);
  const sha = createHash("sha256").update(src).digest("hex");
  db.files.set(`account-${ACCT}/templates/${TPL}/v1.pdf`, src);
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur", owner_user_id: OWNER, brand_logo_url: "https://cdn.example/logo.png" }]);
  db.seed("profiles", [{ user_id: ADMIN, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.example" }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.seed("sign_templates", [{ id: TPL, account_id: ACCT, name: "Merchant Application", status: "active", category_id: null, current_version_id: "ver1" }]);
  db.seed("sign_template_versions", [{ id: "ver1", account_id: ACCT, template_id: TPL, version_no: 1, source_path: `account-${ACCT}/templates/${TPL}/v1.pdf`, source_sha256: sha, original_path: null, page_count: 1, fields, roles, form: null, defaults: { locale: "en" } }]);
  db.seed("sign_registration_forms", [form(over) as unknown as Record<string, unknown>]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: usage, error: null });
  db.rpcHandlers.sign_send_document = async (args) => {
    const doc = db.rows("sign_documents").find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at });
    const people = db.rows("sign_signers").filter((s) => s.document_id === args.p_document);
    return {
      data: {
        reference: "SGN-2026-000001",
        invited: people.map((s, i) => ({ signer_id: s.id, token: `${String(i).repeat(64)}`, name: s.full_name, email: s.email, phone: s.phone ?? null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no })),
      },
      error: null,
    };
  };
}

const deps = (): NotifyDeps => ({
  emailConfigured: () => true,
  sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject, text: a.text }),
  loadIdentity: async () => ({ fromName: "Vircle" }),
  sendWhatsApp: async () => {},
});

const env = (): SubmitEnv => ({
  admin: db.client(),
  origin: "https://halo.test",
  deps: deps(),
  now: () => new Date(),
  limit: async (key, limit) => {
    calls.push({ key, limit });
    return !denyKey(key);
  },
  captcha,
});

/** A page that was drawn `ageMs` ago. */
const token = (ageMs = 10_000, formId = FORM) => issueFormToken(formId, new Date(Date.now() - ageMs))!;

const body = (over: Record<string, unknown> = {}) => ({
  fullName: "Ali bin Ahmad",
  company: "Kedai Runcit Ali",
  email: "Ali@Kedai.example",
  phone: "+60 12-345 6789",
  consent: true,
  locale: "ms",
  token: token(),
  website_url: "",
  ...over,
});

const submit = (over: Record<string, unknown> = {}, slug = SLUG, ip = IP): Promise<SubmitOutcome> =>
  submitRegistration(env(), { slug, body: body(over), ip, userAgent: "Mozilla/5.0 (iPhone)" });

const entries = () => db.rows("sign_registrations");
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENCRYPTION_KEY;
});

describe("a registration page that is not there", () => {
  it("answers the same for an unknown address, a switched-off form, Doc Sign off, a suspended workspace and a malformed address", async () => {
    await setup({ active: false });
    const cases: [string, () => void][] = [
      ["unknown", () => {}],
      ["switched off", () => {}],
      ["Doc Sign off", () => { db.rows("sign_registration_forms")[0].active = true; db.rows("account_platform")[0].features = { sign: false }; }],
      ["suspended", () => { db.rows("account_platform")[0].features = { sign: true }; db.rows("account_platform")[0].status = "suspended"; }],
    ];
    const slugs = ["merchant-sign-up-aaaaaaaa", SLUG, SLUG, SLUG];
    const seen: SubmitOutcome[] = [];
    for (const [i, [, change]] of cases.entries()) {
      change();
      seen.push(await submit({}, slugs[i]));
    }
    for (const bad of ["", "x", "../../etc", "A B", "x".repeat(60)]) seen.push(await submit({}, bad));
    expect(seen.every((o) => o.kind === "not_found")).toBe(true);
    expect(new Set(seen.map((o) => JSON.stringify(o))).size).toBe(1);
    // nothing was written, no contact, no document, no row
    expect(entries()).toHaveLength(0);
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(await loadPublicForm(db.client(), SLUG)).toBeNull();
  });

  it("is found again once it is on", async () => {
    await setup();
    const found = await loadPublicForm(db.client(), SLUG.toUpperCase());
    expect(found?.form.id).toBe(FORM);
    expect(found?.workspace).toEqual({ name: "Vircle Sdn Bhd", logoUrl: "https://cdn.example/logo.png" });
  });

  it("cannot take submissions on a server with no key to sign with", async () => {
    await setup();
    const b = body();
    delete process.env.ENCRYPTION_KEY;
    expect(await submitRegistration(env(), { slug: SLUG, body: b, ip: IP, userAgent: null })).toEqual({ kind: "not_configured" });
    expect(entries()).toHaveLength(0);
  });

  // WP25 review: the emailed link is built on the deployment's own address; a caller cannot choose it through the Host header
  it("cannot take submissions when the deployment has no public address of its own to put on the emailed link", async () => {
    await setup();
    const noOrigin = { ...env(), origin: "" };
    expect(await submitRegistration(noOrigin, { slug: SLUG, body: body(), ip: IP, userAgent: null })).toEqual({ kind: "not_configured" });
    expect(entries()).toHaveLength(0);
    expect(db.rows("contacts")).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("puts only the deployment's address on what it emails, whatever address the request came in on", async () => {
    await setup();
    expect(await submit()).toEqual({ kind: "ok" });
    expect(mail.length).toBeGreaterThan(0);
    for (const m of mail) {
      expect(m.text).toContain("https://halo.test/s/");
      expect(m.text).not.toMatch(/https?:\/\/(?!halo\.test)/);
    }
  });
});

describe("what the page is drawn with", () => {
  it("has the workspace, what is asked, the agreement in every language with the workspace's name, and a token: and nothing else of the form", async () => {
    await setup({ consent_text: { ms: "Kami simpan untuk {workspace}." }, success_message: { en: "See you soon." } });
    const found = (await loadPublicForm(db.client(), SLUG))!;
    const view = buildRegisterView(found, "tok", "0x4AAA");
    expect(view).toMatchObject({ slug: SLUG, workspace: { name: "Vircle Sdn Bhd" }, defaultLocale: "en", sendsDocument: true, token: "tok", captchaKey: "0x4AAA", success: { en: "See you soon." } });
    expect(view.asked).toEqual({ full_name: "required", email: "required", phone: "optional", company: "required" });
    expect(view.consent.ms).toBe("Kami simpan untuk Vircle Sdn Bhd.");
    for (const l of ["en", "zh", "ko"] as const) expect(view.consent[l]).toContain("Vircle Sdn Bhd");
    const text = JSON.stringify(view);
    for (const secret of [ACCT, TPL, TAG, ADMIN, "siti@vircle.example", "director"]) expect(text, secret).not.toContain(secret);
  });
});

describe("a registration that goes through", () => {
  it("makes the contact, tags it once, makes the document from the template and emails it", async () => {
    await setup();
    expect(await submit()).toEqual({ kind: "ok" });

    // the contact: a lead with what was typed, the phone as digits
    const contacts = db.rows("contacts");
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ account_id: ACCT, user_id: OWNER, name: "Ali bin Ahmad", email: "ali@kedai.example", phone: "60123456789", company: "Kedai Runcit Ali", lifecycle_stage: "lead" });

    // the tag, once, for this contact in this workspace
    expect(addContactTagAndDispatch).toHaveBeenCalledTimes(1);
    expect(addContactTagAndDispatch).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCT, contactId: contacts[0].id, tagId: TAG }));

    // the document: from the template, in the person's language, linked to the contact, owned by whoever set the form up
    const docs = db.rows("sign_documents");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ account_id: ACCT, status: "sent", title: "Merchant Application: Kedai Runcit Ali", locale: "ms", contact_id: contacts[0].id, created_by: ADMIN, template_version_id: "ver1" });
    expect(docs[0].merge_values).toEqual({ business_name: "Kedai Runcit Ali" });

    // the people: the applicant in the form's role, by email; the director the form names
    const people = db.rows("sign_signers");
    expect(people.map((p) => [p.role_key, p.full_name, p.email, p.channel, p.order_no])).toEqual([
      ["merchant", "Ali bin Ahmad", "ali@kedai.example", "email", 1],
      ["director", "Siti Director", "siti@vircle.example", "email", 2],
    ]);
    expect(people[0].phone).toBe("+60123456789");

    // sent through the one place that sends, as the system (no person acted)
    const send = db.rpcCalls.find((c) => c.name === "sign_send_document")!;
    expect(send.args.p_actor).toBeNull();
    expect(mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "siti@vircle.example"]);

    // the record: accepted, linked, and nothing in it that could be read back
    expect(entries()).toHaveLength(1);
    const row = entries()[0];
    expect(row).toMatchObject({ account_id: ACCT, form_id: FORM, status: "accepted", reason: null, contact_id: contacts[0].id, document_id: docs[0].id, locale: "ms", consent_version: "default-v1-ms", user_agent: "Mozilla/5.0 (iPhone)" });
    expect(row.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(IP);
    expect(stored).not.toContain("kedai.example");
  });

  it("never hands a link back, in the answer or anywhere it can be read", async () => {
    await setup();
    const out = await submit();
    expect(JSON.stringify(out)).not.toMatch(/https?:|\/s\//);
    expect(JSON.stringify(entries())).not.toMatch(/\/s\/|[0-9a-f]{64}\b.*https/);
  });

  it("uses the form's language when the person did not choose one", async () => {
    await setup({ default_locale: "zh" });
    await submit({ locale: undefined });
    expect(db.rows("sign_documents")[0].locale).toBe("zh");
    expect(entries()[0]).toMatchObject({ locale: "zh", consent_version: "default-v1-zh" });
  });

  it("records the wording the person agreed to, custom or the product's", async () => {
    await setup({ consent_text: { ms: "Kata-kata sendiri." } });
    await submit();
    expect(entries()[0].consent_version).toMatch(/^custom-ms-[0-9a-f]{10}$/);
  });

  it("asks only what the form asks and fills the document with only what was typed", async () => {
    await setup({ fields: { full_name: "off", email: "required", phone: "off", company: "optional" } });
    await submit({ fullName: "Ignored", phone: "+60 12-345 6789", company: "" });
    expect(db.rows("contacts")[0]).toMatchObject({ name: "ali@kedai.example", phone: "", company: null });
    expect(db.rows("sign_signers")[0]).toMatchObject({ full_name: "ali@kedai.example", phone: null });
    expect(db.rows("sign_documents")[0].merge_values).toEqual({});
  });
});

describe("the contact: created or updated, never overwritten", () => {
  it("matches an existing contact by email whatever the case, fills only what is empty, and links the document to it", async () => {
    await setup();
    db.seed("contacts", [{ id: "c1", account_id: ACCT, user_id: OWNER, name: "Website visitor", phone: "", email: "ALI@kedai.EXAMPLE", company: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z" }]);
    expect(await submit()).toEqual({ kind: "ok" });
    expect(db.rows("contacts")).toHaveLength(1);
    expect(db.rows("contacts")[0]).toMatchObject({ id: "c1", name: "Ali bin Ahmad", company: "Kedai Runcit Ali", phone: "60123456789", email: "ALI@kedai.EXAMPLE" });
    expect(db.rows("sign_documents")[0].contact_id).toBe("c1");
    expect(addContactTagAndDispatch).toHaveBeenCalledTimes(1);
    expect(addContactTagAndDispatch).toHaveBeenCalledWith(expect.objectContaining({ contactId: "c1" }));
    expect(entries()[0].contact_id).toBe("c1");
  });

  it("never rewrites what an existing contact already holds: typing someone's email changes nothing about them", async () => {
    await setup();
    db.seed("contacts", [{ id: "c1", account_id: ACCT, user_id: OWNER, name: "Real Name", phone: "60199999999", email: "ali@kedai.example", company: "Real Company", deleted_at: null, created_at: "2026-01-01T00:00:00Z" }]);
    await submit({ fullName: "Impostor", company: "Fake Co", phone: "+60 12-345 6789" });
    expect(db.rows("contacts")).toHaveLength(1);
    expect(db.rows("contacts")[0]).toMatchObject({ name: "Real Name", phone: "60199999999", company: "Real Company" });
  });

  it("does not take a phone number that belongs to another contact: a new contact without it, and the pair put to the agents", async () => {
    await setup();
    db.seed("contacts", [{ id: "owner", account_id: ACCT, user_id: OWNER, name: "Siti the Neighbour", phone: "60123456789", email: "siti@elsewhere.example", company: "Siti Co", deleted_at: null, created_at: "2026-01-01T00:00:00Z" }]);
    expect(await submit()).toEqual({ kind: "ok" });
    const contacts = db.rows("contacts");
    expect(contacts).toHaveLength(2);
    const made = contacts.find((c) => c.id !== "owner")!;
    expect(made).toMatchObject({ email: "ali@kedai.example", phone: "", name: "Ali bin Ahmad" });
    // the owner of the number is untouched and is not the one the document is linked to
    expect(contacts.find((c) => c.id === "owner")).toMatchObject({ name: "Siti the Neighbour", email: "siti@elsewhere.example", company: "Siti Co" });
    expect(db.rows("sign_documents")[0].contact_id).toBe(made.id);
    expect(db.rows("contact_merge_suggestions")).toEqual([expect.objectContaining({ account_id: ACCT, contact_a_id: "owner", contact_b_id: made.id, source: "sign_registration" })]);
  });

  it("never matches or touches a contact of another workspace or a deleted one", async () => {
    await setup();
    db.seed("contacts", [
      { id: "other", account_id: "someone-else", user_id: OWNER, name: "Other", phone: "", email: "ali@kedai.example", company: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "gone", account_id: ACCT, user_id: OWNER, name: "Gone", phone: "", email: "ali@kedai.example", company: null, deleted_at: "2026-02-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    ]);
    await submit();
    const mine = db.rows("contacts").filter((c) => c.account_id === ACCT && c.id !== "gone");
    expect(mine).toHaveLength(1);
    expect(mine[0].id).not.toBe("other");
    expect(db.rows("contacts").find((c) => c.id === "other")).toMatchObject({ name: "Other", company: null });
    expect(db.rows("contacts").find((c) => c.id === "gone")).toMatchObject({ name: "Gone", company: null });
  });

  it("still goes through when the tag cannot be applied", async () => {
    await setup();
    vi.mocked(addContactTagAndDispatch).mockRejectedValueOnce(new Error("Tag not found"));
    expect(await submit()).toEqual({ kind: "ok" });
    expect(entries()[0]).toMatchObject({ status: "accepted" });
    expect(db.rows("sign_documents")).toHaveLength(1);
  });

  it("applies no tag when the form names none", async () => {
    await setup({ contact_tag_id: null });
    await submit();
    expect(addContactTagAndDispatch).not.toHaveBeenCalled();
  });
});

describe("a form that sends no document", () => {
  it("keeps the details and tags the contact, and starts nothing else", async () => {
    await setup({ send_document: false, template_id: null, applicant_role_key: null, signers_other: [] });
    expect(await submit()).toEqual({ kind: "ok" });
    expect(db.rows("contacts")).toHaveLength(1);
    expect(addContactTagAndDispatch).toHaveBeenCalledTimes(1);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(mail).toHaveLength(0);
    expect(entries()[0]).toMatchObject({ status: "accepted", reason: null, contact_id: db.rows("contacts")[0].id });
    expect(entries()[0].document_id ?? null).toBeNull();
    // the same email again today is a repeat, not another tag or contact
    expect(await submit({ token: token() })).toEqual({ kind: "ok" });
    expect(addContactTagAndDispatch).toHaveBeenCalledTimes(1);
    expect(entries().map((e) => e.reason)).toEqual([null, "duplicate"]);
  });
});

describe("the same email again", () => {
  it("is answered like the first time and starts nothing new, whatever the case or spacing", async () => {
    await setup();
    const first = await submit();
    const mails = mail.length;
    const second = await submit({ email: "  ALI@kedai.example ", fullName: "Someone Else", token: token() });
    expect(second).toEqual(first);
    expect(db.rows("contacts")).toHaveLength(1);
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(db.rows("sign_signers")).toHaveLength(2);
    expect(mail).toHaveLength(mails);
    expect(addContactTagAndDispatch).toHaveBeenCalledTimes(1);
    expect(entries()).toHaveLength(2);
    expect(entries()[1]).toMatchObject({ status: "accepted", reason: "duplicate", document_id: db.rows("sign_documents")[0].id, contact_id: db.rows("contacts")[0].id });
  });

  it("tells a known address and a new one apart to nobody: same answer, same shape", async () => {
    await setup();
    db.seed("contacts", [{ id: "c1", account_id: ACCT, user_id: OWNER, name: "Known", phone: "", email: "known@kedai.example", company: null, deleted_at: null, created_at: "2026-01-01T00:00:00Z" }]);
    const known = await submit({ email: "known@kedai.example" });
    const fresh = await submit({ email: "fresh@kedai.example", token: token() });
    expect(known).toEqual(fresh);
  });

  it("is let through again once the earlier document is finished, and after a day", async () => {
    await setup();
    await submit();
    db.rows("sign_documents")[0].status = "completed";
    await submit({ token: token() });
    expect(db.rows("sign_documents")).toHaveLength(2);

    await setup();
    db.seed("sign_registrations", [{ id: "old", account_id: ACCT, form_id: FORM, status: "accepted", reason: null, email_hash: null, document_id: null, created_at: hoursAgo(26) }]);
    await submit();
    // the old row has no hash to match: seed one with the real hash by submitting, then age it
    db.rows("sign_registrations")[1].created_at = hoursAgo(25);
    await submit({ token: token() });
    expect(db.rows("sign_documents")).toHaveLength(2);
  });

  it("does not stop a different email, or the same email on another form", async () => {
    await setup();
    await submit();
    await submit({ email: "other@kedai.example", token: token() });
    expect(db.rows("sign_documents")).toHaveLength(2);
    expect(db.rows("contacts")).toHaveLength(2);
  });

  it("holds back a second post that arrives while the first is still being handled, and lets the earlier one win", async () => {
    await setup();
    // the first post is mid-way: a claim older than this one, on the same email
    await submit();
    const mine = db.rows("sign_registrations")[0];
    const hash = mine.email_hash;
    db.tables.sign_registrations = [];
    db.seed("sign_registrations", [{ id: "earlier", account_id: ACCT, form_id: FORM, status: "failed", reason: "in_progress", email_hash: hash, created_at: hoursAgo(0.0005) }]);
    expect(await submit({ token: token() })).toEqual({ kind: "ok" });
    expect(db.rows("sign_registrations").find((e) => e.id !== "earlier")).toMatchObject({ status: "accepted", reason: "duplicate" });
    expect(db.rows("sign_documents")).toHaveLength(1); // still only the first one's document

    // a claim that began LATER does not block this one: whoever began first goes first
    db.tables.sign_registrations = [];
    db.tables.sign_documents = [];
    db.tables.sign_signers = [];
    db.seed("sign_registrations", [{ id: "later", account_id: ACCT, form_id: FORM, status: "failed", reason: "in_progress", email_hash: hash, created_at: new Date(Date.now() + 60_000).toISOString() }]);
    await submit({ token: token() });
    expect(db.rows("sign_documents")).toHaveLength(1);

    // a claim left by a request that died long ago holds nothing up
    db.tables.sign_registrations = [];
    db.tables.sign_documents = [];
    db.tables.sign_signers = [];
    db.seed("sign_registrations", [{ id: "dead", account_id: ACCT, form_id: FORM, status: "failed", reason: "in_progress", email_hash: hash, created_at: new Date(Date.now() - 10 * 60_000).toISOString() }]);
    await submit({ token: token() });
    expect(db.rows("sign_documents")).toHaveLength(1);
  });
});

describe("a script", () => {
  it("is answered like a person when it fills the hidden field, and leaves nothing behind but a record", async () => {
    await setup();
    expect(await submit({ website_url: "http://spam.example" })).toEqual({ kind: "ok" });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(addContactTagAndDispatch).not.toHaveBeenCalled();
    expect(mail).toHaveLength(0);
    expect(entries()).toEqual([expect.objectContaining({ status: "rejected_spam", reason: "honeypot", account_id: ACCT, form_id: FORM })]);
  });

  it("is sent back with a fresh token when the page's token was changed, expired, or made for another form", async () => {
    await setup();
    const fresh = (o: SubmitOutcome) => {
      expect(o.kind).toBe("retry");
      const t = (o as { token: string }).token;
      expect(t).toMatch(new RegExp(`^${FORM}\\.`));
      return t;
    };
    const parts = token().split(".");
    const tampered = `${parts[0]}.${Number(parts[1]) - 7200}.${parts[2]}.${parts[3]}`;
    const a = await submit({ token: tampered });
    expect(a).toMatchObject({ kind: "retry", code: "token_invalid" });
    fresh(a);
    expect(await submit({ token: token(3 * HOUR) })).toMatchObject({ kind: "retry", code: "token_expired" });
    expect(await submit({ token: token(10_000, "99999999-9999-4999-8999-999999999999") })).toMatchObject({ kind: "retry", code: "token_invalid" });
    expect(await submit({ token: undefined })).toMatchObject({ kind: "retry", code: "token_invalid" });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(entries().map((e) => [e.status, e.reason])).toEqual([["rejected_spam", "token_invalid"], ["rejected_spam", "token_expired"], ["rejected_spam", "token_invalid"], ["rejected_spam", "token_invalid"]]);
    // the fresh token works once the minimum time has passed, and not a moment sooner
    expect(await submit({ token: token(500) })).toMatchObject({ kind: "retry", code: "token_too_fast" });
    expect(await submit({ token: token(3500) })).toEqual({ kind: "ok" });
  });

  it("is told to wait when it posts valid details too quickly, but a person with a typo is not flagged for speed", async () => {
    await setup();
    expect(await submit({ token: token(800) })).toMatchObject({ kind: "retry", code: "token_too_fast" });
    expect(entries()).toEqual([expect.objectContaining({ status: "rejected_spam", reason: "token_too_fast" })]);
    expect(db.rows("contacts")).toHaveLength(0);
    // wrong details a second after the page opened: the details are what is wrong
    expect(await submit({ token: token(1000), email: "nope" })).toMatchObject({ kind: "invalid", problems: { email: "invalid" } });
    expect(entries()).toHaveLength(1);
  });

  it("is refused when Turnstile is on and its token is not confirmed, and passed on when it is", async () => {
    await setup();
    captcha.enabled = true;
    captcha.verify.mockResolvedValueOnce(false);
    expect(await submit({ captcha: "bad" })).toMatchObject({ kind: "retry", code: "captcha_failed" });
    expect(captcha.verify).toHaveBeenCalledWith("bad", IP);
    expect(entries()).toEqual([expect.objectContaining({ status: "rejected_spam", reason: "captcha_failed" })]);
    expect(db.rows("contacts")).toHaveLength(0);
    captcha.verify.mockResolvedValueOnce(true);
    expect(await submit({ captcha: "good", token: token() })).toEqual({ kind: "ok" });
    expect(captcha.verify).toHaveBeenLastCalledWith("good", IP);
  });

  it("is not asked for Turnstile when it is off", async () => {
    await setup();
    await submit();
    expect(captcha.verify).not.toHaveBeenCalled();
  });
});

describe("the details", () => {
  it("are refused with what is wrong, and nothing is made or recorded", async () => {
    await setup();
    expect(await submit({ email: "nope", fullName: "", consent: false })).toEqual({ kind: "invalid", problems: { full_name: "required", email: "invalid", consent: "required" } });
    expect(await submit({ fullName: "<b>x</b>" })).toEqual({ kind: "invalid", problems: { full_name: "invalid" } });
    expect(entries()).toHaveLength(0);
    expect(db.rows("contacts")).toHaveLength(0);
  });
});

describe("how often", () => {
  it("counts every post per address and per form, and the valid ones again, under keys that never hold the address", async () => {
    await setup();
    await submit();
    const keys = calls.map((c) => c.key);
    expect(keys.filter((k) => k.startsWith("sign-reg:att:ip:"))).toHaveLength(1);
    expect(keys).toContain(`sign-reg:att:form:${FORM}`);
    expect(keys.filter((k) => k.startsWith("sign-reg:sub:ip:"))).toHaveLength(1);
    expect(keys).toContain(`sign-reg:sub:form:${FORM}`);
    expect(keys.join(" ")).not.toContain(IP);
    expect(keys.find((k) => k.startsWith("sign-reg:att:ip:"))).toMatch(/^sign-reg:att:ip:[0-9a-f]{24}$/);
    const limit = (prefix: string) => calls.find((c) => c.key.startsWith(prefix))!.limit;
    expect(limit("sign-reg:att:ip:")).toBe(RATE_LIMITS.signRegisterIpAttempts.limit);
    expect(limit("sign-reg:sub:ip:")).toBe(5);
    expect(limit("sign-reg:sub:form:")).toBe(60);
  });

  it("does not spend the submission budget on a post with wrong details", async () => {
    await setup();
    await submit({ email: "nope" });
    expect(calls.filter((c) => c.key.startsWith("sign-reg:sub:"))).toHaveLength(0);
  });

  it("refuses an address that is over its budget, before anything else, and records nothing", async () => {
    await setup();
    denyKey = (k) => k.startsWith("sign-reg:att:ip:");
    expect(await submit()).toEqual({ kind: "rate_limited" });
    denyKey = (k) => k.startsWith("sign-reg:sub:ip:");
    expect(await submit({ token: token() })).toEqual({ kind: "rate_limited" });
    denyKey = (k) => k === `sign-reg:sub:form:${FORM}`;
    expect(await submit({ token: token() })).toEqual({ kind: "rate_limited" });
    denyKey = (k) => k === `sign-reg:att:form:${FORM}`;
    expect(await submit({ token: token() })).toEqual({ kind: "rate_limited" });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(entries()).toHaveLength(0);
  });

  it("does not put every visitor with an unknown address in one bucket", async () => {
    await setup();
    await submit({}, SLUG, "unknown");
    expect(calls.some((c) => c.key.includes(":ip:"))).toBe(false);
    expect(entries()[0].ip_hash).toBeNull();
  });
});

describe("the daily cap", () => {
  it("stops at the cap, counts only real acceptances of the last day, and records the refusal", async () => {
    await setup({ daily_cap: 2 });
    db.seed("sign_registrations", [
      { id: "a", account_id: ACCT, form_id: FORM, status: "accepted", reason: null, created_at: hoursAgo(1) },
      { id: "b", account_id: ACCT, form_id: FORM, status: "accepted", reason: null, created_at: hoursAgo(2) },
      // not counted: a repeat, an old one, a failure, another form's
      { id: "c", account_id: ACCT, form_id: FORM, status: "accepted", reason: "duplicate", created_at: hoursAgo(1) },
      { id: "d", account_id: ACCT, form_id: FORM, status: "accepted", reason: null, created_at: hoursAgo(30) },
      { id: "e", account_id: ACCT, form_id: FORM, status: "failed", reason: "send_failed", created_at: hoursAgo(1) },
      { id: "f", account_id: ACCT, form_id: "other-form", status: "accepted", reason: null, created_at: hoursAgo(1) },
    ]);
    expect(await submit()).toEqual({ kind: "cap" });
    expect(db.rows("sign_registrations").find((r) => r.reason === "daily_cap")).toMatchObject({ status: "rejected_cap" });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);

    // one fewer in the day: the same post is taken
    db.tables.sign_registrations = db.rows("sign_registrations").filter((r) => r.id !== "b" && r.reason !== "daily_cap");
    expect(await submit({ token: token() })).toEqual({ kind: "ok" });
    expect(db.rows("sign_documents")).toHaveLength(1);
  });

  it("takes a repeat even when the day is full, since it starts nothing", async () => {
    await setup({ daily_cap: 1 });
    await submit();
    expect(await submit({ token: token() })).toEqual({ kind: "ok" });
    expect(await submit({ email: "second@kedai.example", token: token() })).toEqual({ kind: "cap" });
  });

  // WP25 review: posts that arrive together all read "one place left", because nobody has settled yet
  it("counts the claims that are still being handled, so a burst cannot go past the cap", async () => {
    await setup({ daily_cap: 1 });
    db.seed("sign_registrations", [
      // another person's request that began a moment ago and has not been settled: it holds the last place
      { id: "00000000-0000-4000-8000-000000000001", account_id: ACCT, form_id: FORM, status: "failed", reason: "in_progress", email_hash: "e".repeat(64), created_at: new Date(Date.now() - 5000).toISOString() },
    ]);
    expect(await submit({ email: "burst@kedai.example" })).toEqual({ kind: "cap" });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("does not let a claim that began later, or one that died long ago, hold a place", async () => {
    await setup({ daily_cap: 1 });
    db.seed("sign_registrations", [
      { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", account_id: ACCT, form_id: FORM, status: "failed", reason: "in_progress", email_hash: "d".repeat(64), created_at: new Date(Date.now() + 60_000).toISOString() },
      { id: "00000000-0000-4000-8000-000000000002", account_id: ACCT, form_id: FORM, status: "failed", reason: "in_progress", email_hash: "c".repeat(64), created_at: new Date(Date.now() - 10 * 60_000).toISOString() },
      // another form's claim is not this form's business
      { id: "00000000-0000-4000-8000-000000000003", account_id: ACCT, form_id: "other-form", status: "failed", reason: "in_progress", email_hash: "b".repeat(64), created_at: new Date(Date.now() - 1000).toISOString() },
    ]);
    expect(await submit({ email: "later@kedai.example" })).toEqual({ kind: "ok" });
    expect(db.rows("sign_documents")).toHaveLength(1);
  });
});

describe("one person's address cannot be mailed from many pages (WP25)", () => {
  it("is limited by the hashed email alone, not by the form or the workspace, and refuses before anything is made", async () => {
    await setup();
    denyKey = (k) => k.startsWith("sign-reg:sub:email:");
    expect(await submit({ email: "Victim@Kedai.example" })).toEqual({ kind: "rate_limited" });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(mail).toHaveLength(0);
    const call = calls.find((c) => c.key.startsWith("sign-reg:sub:email:"))!;
    expect(call.limit).toBe(RATE_LIMITS.signRegisterEmail.limit);
    // the key follows the address in any case, and carries neither the form, the workspace nor the address itself
    expect(call.key).not.toContain(FORM);
    expect(call.key).not.toContain(ACCT);
    expect(call.key.toLowerCase()).not.toContain("victim");
    calls.length = 0;
    denyKey = () => false;
    await submit({ email: "VICTIM@kedai.example", token: token() });
    expect(calls.find((c) => c.key.startsWith("sign-reg:sub:email:"))?.key).toBe(call.key);
  });
});

describe("when the document cannot be sent", () => {
  it("keeps the contact, removes the unsent draft, records why, and says so neutrally (the monthly limit)", async () => {
    await setup();
    usage = { limits: { sign_documents_per_month: 5 }, sign_documents_month: 5 };
    expect(await submit()).toEqual({ kind: "failed", saved: true });
    expect(db.rows("contacts")).toHaveLength(1);
    expect(addContactTagAndDispatch).toHaveBeenCalledTimes(1);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(db.rpcCalls.some((c) => c.name === "sign_send_document")).toBe(false);
    expect(mail).toHaveLength(0);
    expect(entries()).toEqual([expect.objectContaining({ status: "failed", reason: "sign_limit_reached", contact_id: db.rows("contacts")[0].id, document_id: null })]);
    // the person may try again once there is room: a failure that made no document does not hold the address
    usage = { limits: {}, sign_documents_month: 0 };
    expect(await submit({ token: token() })).toEqual({ kind: "ok" });
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(db.rows("contacts")).toHaveLength(1);
  });

  it("keeps the document when it was made but the email could not be delivered, never reveals its link, and does not make another", async () => {
    await setup();
    const failing = env();
    failing.deps = { ...failing.deps, sendEmail: async () => { throw new Error("Resend: domain not verified"); } };
    const out = await submitRegistration(failing, { slug: SLUG, body: body(), ip: IP, userAgent: null });
    expect(out).toEqual({ kind: "failed", saved: true });
    expect(JSON.stringify(out)).not.toMatch(/https?:|\/s\//);
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(entries()).toEqual([expect.objectContaining({ status: "failed", reason: "delivery_failed", document_id: db.rows("sign_documents")[0].id })]);
    // a retry within the day is a repeat: the document exists and the workspace can resend it from its page
    expect(await submit({ token: token() })).toEqual({ kind: "ok" });
    expect(db.rows("sign_documents")).toHaveLength(1);
  });

  it("says the form cannot send when its template is no longer active, and still keeps the contact", async () => {
    await setup();
    db.rows("sign_templates")[0].status = "archived";
    expect(await submit()).toEqual({ kind: "failed", saved: true });
    expect(entries()[0]).toMatchObject({ status: "failed", reason: "form_not_ready" });
    expect(db.rows("contacts")).toHaveLength(1);
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("says the form cannot send when its template was deleted", async () => {
    await setup({ template_id: null });
    expect(await submit()).toEqual({ kind: "failed", saved: true });
    expect(entries()[0]).toMatchObject({ status: "failed", reason: "form_not_ready" });
  });

  it("does not send a document for a role the template does not have", async () => {
    await setup({ applicant_role_key: "ghost" });
    expect(await submit()).toEqual({ kind: "failed", saved: true });
    expect(entries()[0]).toMatchObject({ reason: "form_not_ready" });
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("is not saved when the workspace is at its contact limit", async () => {
    await setup();
    vi.mocked(assertCanAddContact).mockRejectedValue(new UsageLimitError("contact_limit_reached", "This workspace has reached its contact limit."));
    expect(await submit()).toEqual({ kind: "failed", saved: false });
    expect(entries()[0]).toMatchObject({ status: "failed", reason: "contact_limit_reached" });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(assertCanAddContact).toHaveBeenCalledWith(expect.anything(), ACCT);
  });

  it("still answers when the record itself cannot be written, and makes nothing", async () => {
    await setup();
    db.failNext.sign_registrations = "insert failed";
    expect(await submit()).toEqual({ kind: "failed", saved: false });
    expect(db.rows("contacts")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("settles the record as failed when something unexpected breaks half way", async () => {
    await setup();
    db.rpcHandlers.sign_send_document = async () => { throw new Error("boom"); };
    expect(await submit()).toEqual({ kind: "failed", saved: true });
    expect(entries()[0]).toMatchObject({ status: "failed", reason: "send_failed" });
    // the draft that could not be sent is gone
    expect(db.rows("sign_documents")).toHaveLength(0);
  });
});

// migration 176: a form carries a list of people who receive the signed copy of every document it makes
describe("people who receive a copy of what the form sends", () => {
  const COPIES = [
    { fullName: "Rahman Accounts", email: "rahman@vircle.example" },
    { fullName: "Mei Ling", email: "meiling@vircle.example" },
  ];
  const copyRows = () => db.rows("sign_copy_recipients");

  it("puts the form's list on the document each submission makes, as the same rows a person adding them would make", async () => {
    await setup({ copy_recipients: COPIES });
    expect(await submit()).toEqual({ kind: "ok" });
    const docs = db.rows("sign_documents");
    expect(docs).toHaveLength(1);
    expect(copyRows().map((c) => ({ document_id: c.document_id, envelope_id: c.envelope_id ?? null, full_name: c.full_name, email: c.email, account_id: c.account_id }))).toEqual(
      COPIES.map((c) => ({ document_id: docs[0].id, envelope_id: null, full_name: c.fullName, email: c.email, account_id: ACCT })),
    );
    // not signers: nothing was added to the signing list for them, and no message went to them yet (the signed copy is sent on completion)
    expect(db.rows("sign_signers").map((x) => x.email)).toEqual(["ali@kedai.example", "siti@vircle.example"]);
    expect(copyRows().every((c) => !c.notified_at)).toBe(true);
    expect(mail.map((m) => m.to)).not.toContain("rahman@vircle.example");
    // each person's addition is on the document's history, by name and with the address masked
    const added = db.rpcCalls.filter((c) => c.name === "sign_log" && c.args.p_type === "copy_recipient_added");
    expect(added).toHaveLength(2);
    expect(JSON.stringify(added.map((a) => a.args.p_detail))).not.toContain("rahman@vircle.example");
  });

  it("never makes the document private (migration 176): what a public page starts is the workspace's own work", async () => {
    await setup({ copy_recipients: COPIES });
    expect(await submit()).toEqual({ kind: "ok" });
    expect(db.rows("sign_documents").every((d) => d.is_private !== true)).toBe(true);
  });

  it("gives every document its own rows, so each completes with its own copies", async () => {
    await setup({ copy_recipients: COPIES });
    expect(await submit()).toEqual({ kind: "ok" });
    expect(await submit({ email: "bala@kedai.example", fullName: "Bala", token: token() }, SLUG, "203.0.113.10")).toEqual({ kind: "ok" });
    const docs = db.rows("sign_documents").map((d) => d.id);
    expect(docs).toHaveLength(2);
    expect(copyRows()).toHaveLength(4);
    for (const id of docs) expect(copyRows().filter((c) => c.document_id === id).map((c) => c.email)).toEqual(COPIES.map((c) => c.email));
  });

  it("leaves out anyone who signs that document: the applicant themselves and the people fixed on the form", async () => {
    await setup({ copy_recipients: [{ fullName: "Ali again", email: "ALI@kedai.example" }, { fullName: "Siti Director", email: "siti@vircle.example" }, ...COPIES] });
    expect(await submit()).toEqual({ kind: "ok" });
    expect(copyRows().map((c) => c.email)).toEqual(COPIES.map((c) => c.email));
    expect(entries()[0]).toMatchObject({ status: "accepted", reason: null });
  });

  it("changes nothing for a form with no list", async () => {
    await setup();
    expect(await submit()).toEqual({ kind: "ok" });
    expect(copyRows()).toHaveLength(0);
    expect(db.rpcCalls.filter((c) => c.name === "sign_log" && String(c.args.p_type).startsWith("copy_recipient"))).toHaveLength(0);
  });

  it("makes no document and no copy rows for a form that sends none", async () => {
    await setup({ send_document: false, copy_recipients: COPIES });
    expect(await submit()).toEqual({ kind: "ok" });
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(copyRows()).toHaveLength(0);
  });

  it("does not leave a half-made document when the list cannot be written: the registration fails loudly and the draft is gone", async () => {
    await setup({ copy_recipients: COPIES });
    db.failNext.sign_copy_recipients = "insert failed";
    expect(await submit()).toEqual({ kind: "failed", saved: true });
    expect(entries()[0]).toMatchObject({ status: "failed", reason: "send_failed" });
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(copyRows()).toHaveLength(0);
  });

  it("never shows the list on the page the public sees", async () => {
    await setup({ copy_recipients: COPIES });
    const found = (await loadPublicForm(db.client(), SLUG))!;
    const text = JSON.stringify(buildRegisterView(found, "tok", null));
    for (const secret of ["rahman@vircle.example", "meiling@vircle.example", "Rahman Accounts", "copy_recipients", "copyRecipients"]) expect(text, secret).not.toContain(secret);
  });
});
