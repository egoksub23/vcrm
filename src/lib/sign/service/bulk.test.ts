import { createHash, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { __resetUsageCacheForTests } from "@/lib/platform/usage";

import type { BulkOptions } from "../bulk/types";
import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import { bulkResultRows, cancelBulk, createBulk, getBulkJob, listBulkJobs, previewBulk, runBulk } from "./bulk";
import type { SignCtx } from "./context";
import { FakeDb } from "./fake-db";

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const TPL = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const CONTACT = "55555555-5555-4555-8555-555555555555";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "biz", type: "static_text", role: "sender", merge: "business_name", page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.04, required: false },
  { key: "fee", type: "static_text", role: "sender", merge: "fee", page: 0, x: 0.1, y: 0.15, w: 0.5, h: 0.04, required: false },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

const options = (over: Partial<BulkOptions> = {}): BulkOptions => ({
  templateId: TPL,
  personRole: "merchant",
  fixedSigners: [{ roleKey: "director", fullName: "Gokula", email: "gokula@vircle.example", channel: "email" }],
  channel: "email",
  title: null,
  categoryId: null,
  message: null,
  locale: null,
  expiryDays: null,
  codeRequired: null,
  signInOrder: null,
  reminderDays: null,
  ...over,
});

const csv = (...lines: string[]) => lines.join("\r\n") + "\r\n";
const FILE = csv("full_name,email,business_name,fee", "Ali bin Ahmad,ali@kedai.example,Kedai Ali,RM 1.00", "Siti Aminah,siti@kedai.example,Kedai Siti,RM 1.20", "Lim Ah Seng,lim@kedai.example,Kedai Lim,RM 1.10");

interface Mail {
  to: string;
  subject: string;
}

let db: FakeDb;
let ctx: SignCtx;
let mail: Mail[];
let limit: number | null;
let sentCounter: number;

function setup() {
  db = new FakeDb();
  mail = [];
  limit = null;
  sentCounter = 0;
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, subject: a.subject }),
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
  db.rpcHandlers.account_usage = async () => ({
    data: { limits: limit === null ? {} : { sign_documents_per_month: limit }, sign_documents_month: db.rows("sign_documents").filter((d) => d.status !== "draft").length },
    error: null,
  });
  db.rpcHandlers.sign_send_document = async (args) => {
    const doc = db.rows("sign_documents").find((d) => d.id === args.p_document)!;
    sentCounter++;
    Object.assign(doc, { status: "sent", reference: `SGN-2026-${String(sentCounter).padStart(6, "0")}`, base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at, sent_at: "2026-10-06T08:00:00Z" });
    const people = db.rows("sign_signers").filter((s) => s.document_id === args.p_document);
    return {
      data: {
        reference: doc.reference,
        invited: people.map((s) => ({ signer_id: s.id, token: String(s.id).replace(/-/g, "").padEnd(64, "a"), name: s.full_name, email: s.email, phone: s.phone ?? null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no })),
      },
      error: null,
    };
  };
  // the fake hands out a detached empty list for a table nobody has written to yet, and the functions below push into these
  db.tables.sign_bulk_jobs = [];
  db.tables.sign_bulk_rows = [];
  installBulkRpcs();
}

/** The database functions of migration 162, as plain code over the fake tables (the SQL itself is proved by verify-162). */
function installBulkRpcs() {
  const jobs = () => db.rows("sign_bulk_jobs");
  const rows = () => db.rows("sign_bulk_rows");
  const settle = (ids: string[]) => {
    for (const j of jobs().filter((x) => ids.includes(x.id as string))) {
      const mine = rows().filter((r) => r.job_id === j.id);
      j.sent_count = mine.filter((r) => r.state === "sent").length;
      j.failed_count = mine.filter((r) => r.state === "failed").length;
      j.skipped_count = mine.filter((r) => r.state === "skipped").length;
      if ((j.status === "queued" || j.status === "running") && !mine.some((r) => r.state === "pending")) {
        j.status = "done";
        j.finished_at = new Date().toISOString();
      }
    }
  };
  const free = (r: Record<string, unknown>) => !r.claimed_until || Date.parse(r.claimed_until as string) < Date.now();
  db.rpcHandlers.sign_bulk_create = async (a) => {
    const id = randomUUID();
    const list = a.p_rows as { row_no: number; input: unknown; state?: string; error_code?: string; error_message?: string }[];
    if (jobs().filter((j) => j.account_id === a.p_account && (j.status === "queued" || j.status === "running")).length >= 3) return { data: null, error: { message: "too_many_bulk_jobs" } };
    jobs().push({ id, account_id: a.p_account, template_id: a.p_template, template_name: a.p_template_name, created_by: a.p_user, status: "queued", source: a.p_source, file_name: a.p_file_name, total_rows: list.length, sent_count: 0, failed_count: 0, skipped_count: 0, options: a.p_options, error_code: null, created_at: new Date().toISOString(), started_at: null, finished_at: null });
    for (const r of list) rows().push({ id: `${id}-row-${r.row_no}`, account_id: a.p_account, job_id: id, row_no: r.row_no, input: r.input, state: r.state === "skipped" ? "skipped" : "pending", document_id: null, error_code: r.error_code ?? null, error_message: r.error_message ?? null, claimed_until: null, attempts: 0, processed_at: null });
    settle([id]);
    return { data: id, error: null };
  };
  db.rpcHandlers.sign_bulk_claim = async (a) => {
    const active = new Set(jobs().filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id));
    const due = rows()
      .filter((r) => r.state === "pending" && free(r) && active.has(r.job_id))
      .sort((x, y) => (x.row_no as number) - (y.row_no as number));
    const taken: Record<string, number> = {};
    const claimed: Record<string, unknown>[] = [];
    for (const r of due) {
      const acct = r.account_id as string;
      if ((taken[acct] ?? 0) >= (a.p_per_account as number) || claimed.length >= (a.p_limit as number)) continue;
      taken[acct] = (taken[acct] ?? 0) + 1;
      r.claimed_until = new Date(Date.now() + (a.p_lease_seconds as number) * 1000).toISOString();
      r.attempts = (r.attempts as number) + 1;
      claimed.push(r);
    }
    for (const j of jobs()) if (j.status === "queued" && claimed.some((r) => r.job_id === j.id)) j.status = "running";
    return { data: claimed.map((r) => ({ ...r })), error: null };
  };
  db.rpcHandlers.sign_bulk_release = async (a) => {
    for (const r of rows().filter((x) => (a.p_ids as string[]).includes(x.id as string) && x.state === "pending")) {
      r.claimed_until = null;
      r.attempts = Math.max(0, (r.attempts as number) - 1);
    }
    return { data: 0, error: null };
  };
  db.rpcHandlers.sign_bulk_stop = async (a) => {
    const job = jobs().find((j) => j.id === a.p_job && j.account_id === a.p_account);
    if (!job) return { data: null, error: { message: "sign_bulk_job_not_found" } };
    let n = 0;
    for (const r of rows().filter((x) => x.job_id === job.id && x.state === "pending" && free(x))) {
      Object.assign(r, { state: a.p_row_state, error_code: a.p_code, error_message: a.p_message, claimed_until: null });
      n++;
    }
    if (a.p_job_status && (job.status === "queued" || job.status === "running")) Object.assign(job, { status: a.p_job_status, error_code: a.p_code, finished_at: new Date().toISOString() });
    settle([job.id as string]);
    return { data: n, error: null };
  };
  db.rpcHandlers.sign_bulk_settle = async (a) => {
    settle(a.p_jobs as string[]);
    return { data: 0, error: null };
  };
}

async function seedTemplate(over: Record<string, unknown> = {}) {
  const src = await makePdf([{ ...A4 }]);
  const sha = createHash("sha256").update(src).digest("hex");
  db.files.set(`account-${ACCT}/templates/${TPL}/v1.pdf`, src);
  db.seed("sign_templates", [{ id: TPL, account_id: ACCT, name: "Merchant Agreement", status: "active", category_id: null, current_version_id: "ver1", ...over }]);
  db.seed("sign_template_versions", [{ id: "ver1", account_id: ACCT, template_id: TPL, version_no: 1, source_path: `account-${ACCT}/templates/${TPL}/v1.pdf`, source_sha256: sha, original_path: null, page_count: 1, fields, roles, defaults: {} }]);
}

/** A batch recorded the way createBulk records it, for the runner tests that need rows in a particular state. */
function seedJob(people: { name: string; email: string; merge?: Record<string, string>; contactId?: string | null }[], rowOver: Record<string, unknown> = {}, jobOver: Record<string, unknown> = {}) {
  db.seed("sign_bulk_jobs", [{ id: JOB, account_id: ACCT, template_id: TPL, template_name: "Merchant Agreement", created_by: USER, status: "queued", source: "csv", file_name: "list.csv", total_rows: people.length, sent_count: 0, failed_count: 0, skipped_count: 0, options: options(), error_code: null, created_at: "2026-10-06T07:00:00Z", started_at: null, finished_at: null, ...jobOver }]);
  db.seed(
    "sign_bulk_rows",
    people.map((p, i) => ({ id: `row-${i + 1}`, account_id: ACCT, job_id: JOB, row_no: i + 1, input: { name: p.name, email: p.email, phone: null, contactId: p.contactId ?? null, merge: p.merge ?? { business_name: `Kedai ${i + 1}`, fee: "RM 1.00" } }, state: "pending", document_id: null, error_code: null, error_message: null, claimed_until: null, attempts: 0, processed_at: null, ...rowOver })),
  );
}

const PEOPLE = [
  { name: "Ali bin Ahmad", email: "ali@kedai.example" },
  { name: "Siti Aminah", email: "siti@kedai.example" },
  { name: "Lim Ah Seng", email: "lim@kedai.example" },
];

const run = (over: Parameters<typeof runBulk>[1] = {}) => runBulk({ admin: ctx.admin, origin: ctx.origin, deps: ctx.deps, now: ctx.now }, over);
const row = (n: number) => db.rows("sign_bulk_rows").find((r) => r.row_no === n)!;
const job = () => db.rows("sign_bulk_jobs").find((j) => j.id === JOB)!;

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  __resetUsageCacheForTests();
  setup();
  await seedTemplate();
});

// ---- the preview and the creation ---------------------------------------------------------------------------

describe("previewBulk", () => {
  it("shows every person, the template's values and roles, and the month's room, changing nothing", async () => {
    const p = await previewBulk(ctx, { options: options(), csv: FILE });
    expect(p.template).toMatchObject({ id: TPL, name: "Merchant Agreement", mergeKeys: ["business_name", "fee"] });
    expect(p.template.roles.map((r) => [r.key, r.needsPerson])).toEqual([["merchant", true], ["director", true]]);
    expect(p.file).toEqual({ problems: [], ignoredColumns: [], rowCount: 3 });
    expect(p.plan.problems).toEqual([]);
    expect(p.counts).toEqual({ total: 3, ok: 3, withProblems: 0 });
    expect(p.rows[0]).toMatchObject({ rowNo: 1, name: "Ali bin Ahmad", email: "ali@kedai.example", merge: { business_name: "Kedai Ali", fee: "RM 1.00" }, problems: [] });
    expect(p.headroom).toEqual({ limit: null, used: 0, remaining: null, needed: 3, fits: true });
    expect(db.rows("sign_bulk_jobs")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("lists each person's problems: a bad address, a repeated one, a missing value", async () => {
    const file = csv("full_name,email,business_name,fee", "Ali,not-an-email,Kedai,RM 1", "Siti,siti@kedai.example,Kedai Siti,RM 2", "Siti Again,SITI@kedai.example,Kedai Siti 2,RM 3", "Lim,lim@kedai.example,,RM 4");
    const p = await previewBulk(ctx, { options: options(), csv: file });
    expect(p.rows.map((r) => r.problems)).toEqual([[{ code: "email_invalid" }], [], [{ code: "email_duplicate", detail: "2" }], [{ code: "merge_missing", detail: "business_name" }]]);
    expect(p.counts).toEqual({ total: 4, ok: 1, withProblems: 3 });
    expect(p.headroom.needed).toBe(1);
  });

  it("says the file cannot be used when it has no usable header", async () => {
    const p = await previewBulk(ctx, { options: options(), csv: csv("a,b", "1,2") });
    expect(p.file.problems).toEqual([{ code: "missing_column", detail: "full_name" }, { code: "missing_column", detail: "email" }]);
    expect(p.file.ignoredColumns).toEqual(["a", "b"]);
  });

  it("reports the setup's problems once: a role with nobody to complete it", async () => {
    const p = await previewBulk(ctx, { options: options({ fixedSigners: [] }), csv: FILE });
    expect(p.plan.problems).toEqual([{ code: "role_without_person", detail: "director" }]);
  });

  it("says whether the month's limit has room for the people without a problem", async () => {
    limit = 2;
    const p = await previewBulk(ctx, { options: options(), csv: FILE });
    expect(p.headroom).toEqual({ limit: 2, used: 0, remaining: 2, needed: 3, fits: false });
    db.seed("sign_documents", [{ id: "old", account_id: ACCT, status: "sent" }]);
    __resetUsageCacheForTests();
    expect((await previewBulk(ctx, { options: options(), csv: FILE })).headroom).toMatchObject({ used: 1, remaining: 1 });
  });

  it("flags a contact id that is not in the workspace", async () => {
    db.seed("contacts", [{ id: CONTACT, account_id: ACCT, name: "Ali", email: "ali@kedai.example", phone: null, deleted_at: null }, { id: "66666666-6666-4666-8666-666666666666", account_id: OTHER, name: "X", email: "x@x.example", phone: null, deleted_at: null }]);
    const file = csv("full_name,email,contact_id,business_name,fee", `Ali,ali@kedai.example,${CONTACT},K,1`, "Mallory,m@kedai.example,66666666-6666-4666-8666-666666666666,K,1");
    const p = await previewBulk(ctx, { options: options(), csv: file });
    expect(p.rows.map((r) => r.problems)).toEqual([[], [{ code: "contact_not_found" }]]);
  });

  it("takes people from contacts, and asks for a file when the template needs values a contact cannot give", async () => {
    db.seed("contacts", [{ id: CONTACT, account_id: ACCT, name: "Ali", email: "ali@kedai.example", phone: "+60123456789", deleted_at: null }]);
    const p = await previewBulk(ctx, { options: options(), contactIds: [CONTACT, CONTACT, "bad", "66666666-6666-4666-8666-666666666666"] });
    expect(p.counts.total).toBe(2);
    expect(p.rows[0]).toMatchObject({ name: "Ali", email: "ali@kedai.example", phone: "+60123456789", contactId: CONTACT, problems: [] });
    expect(p.rows[1].problems.map((x) => x.code)).toEqual(["name_missing", "email_missing", "contact_not_found"]);
    expect(p.plan.problems).toEqual([{ code: "merge_needs_file", detail: "business_name, fee" }]);
  });

  it("refuses what it cannot read: bad options, no list, another workspace's template, a template that is not active", async () => {
    await expect(previewBulk(ctx, { options: { templateId: "x" }, csv: FILE })).rejects.toMatchObject({ code: "bad_options", status: 400 });
    await expect(previewBulk(ctx, { options: options() })).rejects.toMatchObject({ code: "list_required" });
    await expect(previewBulk(ctx, { options: options(), csv: FILE, contactIds: [] })).rejects.toMatchObject({ code: "list_required" });
    await expect(previewBulk(ctx, { options: options({ templateId: "77777777-7777-4777-8777-777777777777" }), csv: FILE })).rejects.toMatchObject({ code: "template_not_found" });
    db.rows("sign_templates")[0].account_id = OTHER;
    await expect(previewBulk(ctx, { options: options(), csv: FILE })).rejects.toMatchObject({ code: "template_not_found" });
    db.rows("sign_templates")[0].account_id = ACCT;
    db.rows("sign_templates")[0].status = "archived";
    await expect(previewBulk(ctx, { options: options(), csv: FILE })).rejects.toMatchObject({ code: "template_not_active" });
  });
});

describe("createBulk", () => {
  it("records the batch and every person, sends nothing yet, and shows the job", async () => {
    const j = await createBulk(ctx, { options: options(), csv: FILE, fileName: "merchants.csv" });
    expect(j).toMatchObject({ templateName: "Merchant Agreement", status: "queued", source: "csv", fileName: "merchants.csv", total: 3, sent: 0, failed: 0, skipped: 0, pending: 3 });
    expect(db.rows("sign_bulk_rows").map((r) => [r.row_no, r.state])).toEqual([[1, "pending"], [2, "pending"], [3, "pending"]]);
    expect(db.rows("sign_bulk_rows")[0].input).toEqual({ name: "Ali bin Ahmad", email: "ali@kedai.example", phone: null, contactId: null, merge: { business_name: "Kedai Ali", fee: "RM 1.00" } });
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("refuses a list with problems unless the sender chooses to skip those people", async () => {
    const file = csv("full_name,email,business_name,fee", "Ali,bad,K,1", "Siti,siti@kedai.example,K,2");
    await expect(createBulk(ctx, { options: options(), csv: file })).rejects.toMatchObject({ code: "rows_have_problems", status: 409, issues: [{ code: "rows_have_problems", detail: "1" }] });
    expect(db.rows("sign_bulk_jobs")).toHaveLength(0);
    const j = await createBulk(ctx, { options: options(), csv: file, skipInvalid: true });
    expect(j).toMatchObject({ total: 2, skipped: 1, pending: 1, status: "queued" });
    expect(row(1)).toMatchObject({ state: "skipped", error_code: "email_invalid", error_message: "The email address is not valid." });
    expect(row(2).state).toBe("pending");
  });

  it("refuses a file or a setup that cannot work, before anything is stored", async () => {
    await expect(createBulk(ctx, { options: options(), csv: csv("a,b", "1,2") })).rejects.toMatchObject({ code: "bulk_file_problems", status: 400 });
    await expect(createBulk(ctx, { options: options({ fixedSigners: [] }), csv: FILE })).rejects.toMatchObject({ code: "bulk_not_ready", issues: [{ code: "role_without_person", detail: "director" }] });
    await expect(createBulk(ctx, { options: options(), csv: csv("full_name,email,business_name,fee", "Ali,bad,K,1"), skipInvalid: true })).rejects.toMatchObject({ code: "nothing_to_send" });
    expect(db.rows("sign_bulk_jobs")).toHaveLength(0);
  });

  it("refuses a batch the month's limit cannot take whole, before anything is sent", async () => {
    limit = 2;
    const err = await createBulk(ctx, { options: options(), csv: FILE }).catch((e) => e);
    expect(err).toMatchObject({ code: "sign_limit_reached", status: 429, issues: [{ code: "sign_limit_reached", detail: "2/3" }] });
    expect(db.rows("sign_bulk_jobs")).toHaveLength(0);
    limit = 3;
    await expect(createBulk(ctx, { options: options(), csv: FILE })).resolves.toMatchObject({ total: 3 });
  });

  it("allows three batches at a time", async () => {
    for (let i = 0; i < 3; i++) await createBulk(ctx, { options: options(), csv: FILE });
    await expect(createBulk(ctx, { options: options(), csv: FILE })).rejects.toMatchObject({ code: "too_many_bulk_jobs", status: 429 });
  });
});

// ---- the runner -------------------------------------------------------------------------------------------------

describe("runBulk", () => {
  it("sends one document to each person through the same services as a single send, and closes the batch", async () => {
    seedJob(PEOPLE);
    const result = await run();
    expect(result).toEqual({ claimed: 3, sent: 3, failed: 0, released: 0 });
    const docs = db.rows("sign_documents");
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.status === "sent")).toBe(true);
    expect(docs.map((d) => d.title)).toEqual(["Merchant Agreement - Ali bin Ahmad", "Merchant Agreement - Siti Aminah", "Merchant Agreement - Lim Ah Seng"]);
    expect(docs[0]).toMatchObject({ merge_values: { business_name: "Kedai 1", fee: "RM 1.00" }, created_by: USER, template_version_id: "ver1" });
    // the person of the list and the fixed person are both on every document
    expect(db.rows("sign_signers").filter((s) => s.document_id === docs[0].id).map((s) => [s.role_key, s.full_name, s.email])).toEqual([["merchant", "Ali bin Ahmad", "ali@kedai.example"], ["director", "Gokula", "gokula@vircle.example"]]);
    // everyone is invited, the sender's usual messages go out
    expect(mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "gokula@vircle.example", "gokula@vircle.example", "gokula@vircle.example", "lim@kedai.example", "siti@kedai.example"]);
    expect([1, 2, 3].map((n) => [row(n).state, row(n).document_id])).toEqual(docs.map((d) => ["sent", d.id]));
    expect(row(1).claimed_until).toBeNull();
    expect(job()).toMatchObject({ status: "done", sent_count: 3, failed_count: 0, skipped_count: 0 });
    // the audit trail says where each document came from
    const created = db.rpcCalls.filter((c) => c.name === "sign_log" && c.args.p_type === "created");
    expect(created).toHaveLength(3);
    expect(created.every((c) => (c.args.p_detail as { via?: string }).via === `bulk:${JOB}`)).toBe(true);
  });

  it("applies the batch's options to every document, and counts expiry from the moment of sending", async () => {
    seedJob(PEOPLE.slice(0, 1), {}, { options: options({ title: "Agreement for {name}", message: "Please sign today.", locale: "ms", expiryDays: 30, codeRequired: true, signInOrder: true, reminderDays: [2, 9] }) });
    await run();
    expect(db.rows("sign_documents")[0]).toMatchObject({ title: "Agreement for Ali bin Ahmad", message: "Please sign today.", locale: "ms", code_required: true, sign_in_order: true, reminder_days: [2, 9] });
    expect(db.rows("sign_documents")[0].expires_at).toBe("2026-11-05T08:00:00.000Z");
  });

  it("makes a person's failure that person's alone: the others are still sent and the batch still closes", async () => {
    seedJob([...PEOPLE.slice(0, 1), { name: "Ghost", email: "ghost@kedai.example", contactId: "88888888-8888-4888-8888-888888888888" }, ...PEOPLE.slice(1)]);
    const result = await run();
    expect(result).toMatchObject({ claimed: 4, sent: 3, failed: 1 });
    expect(row(2)).toMatchObject({ state: "failed", error_code: "contact_not_found", error_message: "That contact was not found.", document_id: null });
    expect([1, 3, 4].map((n) => row(n).state)).toEqual(["sent", "sent", "sent"]);
    expect(job()).toMatchObject({ status: "done", sent_count: 3, failed_count: 1 });
  });

  it("keeps a draft that could not be sent, linked to its row, so the sender can open it", async () => {
    seedJob([{ name: "Ali", email: "ali@kedai.example" }], {}, { options: options({ channel: "whatsapp", locale: null }) });
    // a number is needed for WhatsApp, and this person has none: the document cannot be sent
    const result = await run();
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(row(1)).toMatchObject({ state: "failed", error_code: "signer_phone" });
    expect(row(1).document_id).toBeTruthy();
    expect(db.rows("sign_documents")[0].status).toBe("draft");
    expect(mail).toHaveLength(0);
  });

  it("marks the rest failed with sign_limit_reached when the month's limit is reached mid-batch, without throwing and without making drafts for them", async () => {
    limit = 2;
    seedJob([...PEOPLE, { name: "Wong", email: "wong@kedai.example" }, { name: "Tan", email: "tan@kedai.example" }]);
    const result = await run({ perAccount: 3 });
    expect(result).toMatchObject({ claimed: 3, sent: 2, failed: 1 });
    expect(row(3)).toMatchObject({ state: "failed", error_code: "sign_limit_reached" });
    // the two rows nobody had claimed are failed at once by the stop, not left waiting
    expect([4, 5].map((n) => [row(n).state, row(n).error_code])).toEqual([["failed", "sign_limit_reached"], ["failed", "sign_limit_reached"]]);
    expect(db.rows("sign_documents")).toHaveLength(2);
    expect(job()).toMatchObject({ status: "done", sent_count: 2, failed_count: 3 });
  });

  it("fails every later row of the same run at once when the limit is hit, even those already claimed", async () => {
    limit = 1;
    seedJob(PEOPLE);
    const result = await run();
    expect(result).toMatchObject({ sent: 1, failed: 2 });
    expect([2, 3].map((n) => row(n).error_code)).toEqual(["sign_limit_reached", "sign_limit_reached"]);
    expect(db.rows("sign_documents")).toHaveLength(1);
  });

  it("does not make a second document for a row that has one: a crashed run's draft is carried on", async () => {
    seedJob(PEOPLE.slice(0, 1));
    // the first try made the draft and recorded it, then the process died: the lease passed
    const { createDraftFromTemplate } = await import("./drafts");
    const draft = await createDraftFromTemplate(ctx, { templateId: TPL });
    Object.assign(row(1), { document_id: draft.id, claimed_until: new Date(Date.now() - 60_000).toISOString(), attempts: 1 });
    await run();
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(db.rows("sign_documents")[0]).toMatchObject({ id: draft.id, status: "sent", title: "Merchant Agreement - Ali bin Ahmad" });
    expect(row(1)).toMatchObject({ state: "sent", document_id: draft.id });
  });

  it("never sends a document twice: a row whose document is already out is recorded as sent and nothing more", async () => {
    seedJob(PEOPLE.slice(0, 1));
    db.seed("sign_documents", [{ id: "already", account_id: ACCT, status: "sent", reference: "SGN-2026-000099", title: "Out already" }]);
    Object.assign(row(1), { document_id: "already", claimed_until: new Date(Date.now() - 60_000).toISOString(), attempts: 2 });
    const result = await run();
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(row(1)).toMatchObject({ state: "sent", document_id: "already" });
    expect(db.rpcCalls.filter((c) => c.name === "sign_send_document")).toHaveLength(0);
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(mail).toHaveLength(0);
  });

  it("starts again with a new draft when the earlier one was deleted", async () => {
    seedJob(PEOPLE.slice(0, 1));
    Object.assign(row(1), { document_id: "deleted-draft", claimed_until: new Date(Date.now() - 60_000).toISOString(), attempts: 1 });
    await run();
    expect(row(1).state).toBe("sent");
    expect(row(1).document_id).not.toBe("deleted-draft");
    expect(db.rows("sign_documents")).toHaveLength(1);
  });

  it("holds a lease: rows a run has claimed are not given to another, so two runs together send each person once", async () => {
    seedJob([...PEOPLE, { name: "Wong", email: "wong@kedai.example" }, { name: "Tan", email: "tan@kedai.example" }, { name: "Chin", email: "chin@kedai.example" }]);
    await Promise.all([run({ perAccount: 3 }), run({ perAccount: 3 })]);
    expect(db.rows("sign_documents")).toHaveLength(6);
    expect(new Set(db.rows("sign_bulk_rows").map((r) => r.document_id)).size).toBe(6);
    expect(db.rpcCalls.filter((c) => c.name === "sign_send_document")).toHaveLength(6);
    expect(job()).toMatchObject({ status: "done", sent_count: 6 });
    // a third run finds nothing to do
    expect(await run()).toEqual({ claimed: 0, sent: 0, failed: 0, released: 0 });
  });

  it("leaves a row that another run holds alone, until its lease passes", async () => {
    seedJob(PEOPLE.slice(0, 1));
    row(1).claimed_until = new Date(Date.now() + 120_000).toISOString();
    expect(await run()).toMatchObject({ claimed: 0 });
    expect(row(1).state).toBe("pending");
  });

  it("gives back the rows it ran out of time for, without counting a try", async () => {
    seedJob(PEOPLE);
    const result = await run({ budgetMs: 0 });
    expect(result).toEqual({ claimed: 3, sent: 0, failed: 0, released: 3 });
    expect([1, 2, 3].map((n) => [row(n).state, row(n).claimed_until, row(n).attempts])).toEqual([["pending", null, 0], ["pending", null, 0], ["pending", null, 0]]);
    expect(job().status).toBe("running");
    expect(db.rows("sign_documents")).toHaveLength(0);
  });

  it("gives every workspace its share of a run", async () => {
    seedJob(PEOPLE);
    db.seed("sign_bulk_jobs", [{ ...job(), id: "other-job", account_id: OTHER, created_by: null }]);
    db.seed("sign_bulk_rows", [{ ...row(1), id: "other-row", account_id: OTHER, job_id: "other-job", row_no: 1 }]);
    const claimed = ((await ctx.admin.rpc("sign_bulk_claim", { p_limit: 20, p_per_account: 2, p_lease_seconds: 300, p_max_attempts: 3 })).data as { account_id: string }[]).map((r) => r.account_id);
    expect(claimed.filter((a) => a === ACCT)).toHaveLength(2);
    expect(claimed.filter((a) => a === OTHER)).toHaveLength(1);
  });

  it("stops a batch that cannot succeed (its template was archived) instead of failing each person one by one", async () => {
    seedJob(PEOPLE);
    db.rows("sign_templates")[0].status = "archived";
    const result = await run({ perAccount: 1 });
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(row(1)).toMatchObject({ state: "failed", error_code: "template_not_active" });
    expect([2, 3].map((n) => [row(n).state, row(n).error_code])).toEqual([["skipped", "template_not_active"], ["skipped", "template_not_active"]]);
    expect(job()).toMatchObject({ status: "failed", error_code: "template_not_active" });
  });

  it("does not send for a workspace whose Doc Sign was switched off, and says so", async () => {
    seedJob(PEOPLE);
    db.rows("account_platform")[0].features = { sign: false };
    await run();
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect([1, 2, 3].map((n) => [row(n).state, row(n).error_code])).toEqual([["skipped", "sign_disabled"], ["skipped", "sign_disabled"], ["skipped", "sign_disabled"]]);
    expect(job()).toMatchObject({ status: "failed", error_code: "sign_disabled" });
  });

  it("does not send a row of a batch that was cancelled while the run held it", async () => {
    seedJob(PEOPLE);
    // the run claimed all three, then the sender cancelled
    const claim = db.rpcHandlers.sign_bulk_claim;
    db.rpcHandlers.sign_bulk_claim = async (a) => {
      const out = await claim(a);
      job().status = "cancelled";
      return out;
    };
    await run();
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect([1, 2, 3].map((n) => [row(n).state, row(n).error_code])).toEqual([["skipped", "cancelled"], ["skipped", "cancelled"], ["skipped", "cancelled"]]);
  });

  it("does nothing when the database cannot be asked for rows", async () => {
    delete db.rpcHandlers.sign_bulk_claim;
    expect(await run()).toEqual({ claimed: 0, sent: 0, failed: 0, released: 0 });
  });

  it("never overwrites a row's recorded answer", async () => {
    seedJob(PEOPLE.slice(0, 1));
    const claim = db.rpcHandlers.sign_bulk_claim;
    db.rpcHandlers.sign_bulk_claim = async (a) => {
      const out = await claim(a);
      // something else settled the row while this run held it
      Object.assign(row(1), { state: "skipped", error_code: "cancelled" });
      return out;
    };
    await run();
    expect(row(1)).toMatchObject({ state: "skipped", error_code: "cancelled" });
  });
});

// ---- what the screens read and do -------------------------------------------------------------------------

describe("cancelBulk", () => {
  it("stops a running batch: what is waiting is skipped, what was sent stays", async () => {
    seedJob(PEOPLE, {}, { status: "running" });
    Object.assign(row(1), { state: "sent", document_id: "d1" });
    const v = await cancelBulk(ctx, JOB);
    expect(v).toMatchObject({ status: "cancelled", sent: 1, skipped: 2, pending: 0 });
    expect([1, 2, 3].map((n) => [row(n).state, row(n).error_code])).toEqual([["sent", null], ["skipped", "cancelled"], ["skipped", "cancelled"]]);
  });

  it("leaves a document being sent right now to finish", async () => {
    seedJob(PEOPLE.slice(0, 2), {}, { status: "running" });
    row(1).claimed_until = new Date(Date.now() + 60_000).toISOString();
    const v = await cancelBulk(ctx, JOB);
    expect(v).toMatchObject({ status: "cancelled", skipped: 1, pending: 1 });
    expect(row(1).state).toBe("pending");
  });

  it("refuses a batch that has finished or belongs to another workspace", async () => {
    seedJob(PEOPLE, {}, { status: "done" });
    await expect(cancelBulk(ctx, JOB)).rejects.toMatchObject({ code: "job_finished", status: 409 });
    await expect(cancelBulk({ ...ctx, accountId: OTHER }, JOB)).rejects.toMatchObject({ code: "job_not_found", status: 404 });
    await expect(cancelBulk(ctx, "not-an-id")).rejects.toMatchObject({ code: "job_not_found" });
  });
});

describe("reading a batch", () => {
  beforeEach(async () => {
    seedJob(PEOPLE, {}, { status: "running", sent_count: 0 });
    db.seed("sign_documents", [{ id: "d1", account_id: ACCT, reference: "SGN-2026-000001" }]);
    Object.assign(row(1), { state: "sent", document_id: "d1" });
    Object.assign(row(2), { state: "failed", error_code: "signer_email", error_message: "Enter a valid email address for every person." });
    row(3).claimed_until = new Date(Date.now() + 60_000).toISOString();
  });

  it("shows live totals from the rows, and a page of people with their document and reason", async () => {
    const p = await getBulkJob(ctx, JOB, { offset: 0, limit: 10 });
    expect(p.job).toMatchObject({ total: 3, sent: 1, failed: 1, skipped: 0, pending: 1, status: "running", templateName: "Merchant Agreement" });
    expect(p.rows.map((r) => [r.rowNo, r.state, r.reference, r.errorCode, r.inFlight])).toEqual([[1, "sent", "SGN-2026-000001", null, false], [2, "failed", null, "signer_email", false], [3, "pending", null, null, true]]);
    expect(p.rows[0]).toMatchObject({ name: "Ali bin Ahmad", email: "ali@kedai.example", documentId: "d1" });
    expect(p.hasMore).toBe(false);
  });

  it("pages, and filters by what became of each person", async () => {
    const first = await getBulkJob(ctx, JOB, { offset: 0, limit: 2 });
    expect(first.rows.map((r) => r.rowNo)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const second = await getBulkJob(ctx, JOB, { offset: 2, limit: 2 });
    expect(second.rows.map((r) => r.rowNo)).toEqual([3]);
    expect(second.hasMore).toBe(false);
    expect((await getBulkJob(ctx, JOB, { offset: 0, limit: 10, state: "failed" })).rows.map((r) => r.rowNo)).toEqual([2]);
    expect((await getBulkJob(ctx, JOB, { offset: 0, limit: 0 })).rows).toEqual([]);
  });

  it("never shows another workspace's batch", async () => {
    await expect(getBulkJob({ ...ctx, accountId: OTHER }, JOB, { offset: 0, limit: 10 })).rejects.toMatchObject({ code: "job_not_found" });
  });

  it("lists the workspace's batches, newest first, with their counters", async () => {
    db.seed("sign_bulk_jobs", [{ ...job(), id: "older", created_at: "2026-10-05T07:00:00Z", sent_count: 4, total_rows: 4, status: "done" }, { ...job(), id: "foreign", account_id: OTHER }]);
    const list = await listBulkJobs(ctx);
    expect(list.map((j) => j.id)).toEqual([JOB, "older"]);
    expect(list[1]).toMatchObject({ sent: 4, pending: 0, status: "done" });
  });

  it("gives the result file's rows with the document references", async () => {
    const { rows, job: j } = await bulkResultRows(ctx, JOB, 0, 250);
    expect(j.template_name).toBe("Merchant Agreement");
    expect(rows.map((r) => [r.rowNo, r.state, r.reference, r.errorCode])).toEqual([[1, "sent", "SGN-2026-000001", null], [2, "failed", null, "signer_email"], [3, "pending", null, null]]);
    expect((await bulkResultRows(ctx, JOB, 2, 250)).rows.map((r) => r.rowNo)).toEqual([3]);
  });
});
