import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlacedField } from "../pdf/types";
import { SLUG_RE } from "../registration/slug";
import { DEFAULT_ASKED, type OtherSigner, type RegistrationFormRow } from "../registration/types";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { SignError } from "./errors";
import { FakeDb } from "./fake-db";
import { loadPublicForm } from "./registration";
import { createForm, formOptions, formReadiness, formView, listEntries, listForms, regenerateFormSlug, updateForm, withUserClient } from "./registration-forms";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TPL = "55555555-5555-4555-8555-555555555555";
const TPL_B = "77777777-7777-4777-8777-777777777777";
const TPL_DRAFT = "bbbbbbbb-0000-4000-8000-000000000001";
const TPL_OLD = "bbbbbbbb-0000-4000-8000-000000000002";
const TAG = "66666666-6666-4666-8666-666666666666";
const TAG_LABEL = "aaaaaaaa-0000-4000-8000-000000000001";
const TAG_GONE = "aaaaaaaa-0000-4000-8000-000000000002";
const TAG_WAITING = "aaaaaaaa-0000-4000-8000-000000000003";
const TAG_OTHER = "aaaaaaaa-0000-4000-8000-000000000004";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance contact", kind: "filler", color: 1 },
  { key: "director", label: "Director", kind: "signer", color: 2 },
];
const fields: PlacedField[] = [
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

let db: FakeDb;
let ctx: SignCtx;
const NOW = new Date("2026-10-06T08:00:00Z");

function setup() {
  db = new FakeDb();
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test/", deps: {} as SignCtx["deps"], now: () => NOW };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur", owner_user_id: USER, brand_logo_url: null }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  db.seed("sign_templates", [
    { id: TPL, account_id: ACCT, name: "Merchant Application", status: "active", current_version_id: "ver1" },
    { id: TPL_B, account_id: "someone-else", name: "Not ours", status: "active", current_version_id: "verB" },
    { id: TPL_DRAFT, account_id: ACCT, name: "Unfinished", status: "draft", current_version_id: null },
    { id: TPL_OLD, account_id: ACCT, name: "Archived", status: "archived", current_version_id: "ver1" },
  ]);
  db.seed("sign_template_versions", [
    { id: "ver1", account_id: ACCT, template_id: TPL, version_no: 1, source_path: "p", source_sha256: "a".repeat(64), page_count: 1, fields, roles, form: null, defaults: {} },
    { id: "verB", account_id: "someone-else", template_id: TPL_B, version_no: 1, source_path: "p", source_sha256: "b".repeat(64), page_count: 1, fields, roles, form: null, defaults: {} },
  ]);
  // the counts are made by the database (migration 164); a test that wants numbers installs its own
  db.rpcHandlers.sign_registration_counts = async () => ({ data: [], error: null });
  db.seed("tags", [
    { id: TAG, account_id: ACCT, name: "Merchant applicant", color: "#f59e0b", for_contacts: true, approval_status: "approved", deleted_at: null },
    { id: TAG_LABEL, account_id: ACCT, name: "Billing", color: "#000", for_contacts: false, approval_status: "approved", deleted_at: null },
    { id: TAG_GONE, account_id: ACCT, name: "Gone", color: "#000", for_contacts: true, approval_status: "approved", deleted_at: "2026-01-01T00:00:00Z" },
    { id: TAG_WAITING, account_id: ACCT, name: "Waiting", color: "#000", for_contacts: true, approval_status: "pending", deleted_at: null },
    { id: TAG_OTHER, account_id: "someone-else", name: "Not ours", color: "#000", for_contacts: true, approval_status: "approved", deleted_at: null },
  ]);
}

beforeEach(setup);

const director: OtherSigner = { role_key: "director", name: "Siti", email: "siti@vircle.example", channel: "email", phone: null };
const base = (over: Record<string, unknown> = {}) => ({ name: "Merchant sign-up", templateId: TPL, applicantRoleKey: "merchant", signersOther: [director], contactTagId: TAG, ...over });
const codes = (e: unknown) => (e as SignError).issues?.map((i) => i.code) ?? [];

describe("what stands between a form and a page that works", () => {
  const states = async (id = TPL) => {
    const t = db.rows("sign_templates").find((x) => x.id === id)!;
    const v = db.rows("sign_template_versions").find((x) => x.id === t.current_version_id) ?? null;
    return { name: t.name as string, status: t.status as string, version: v as never };
  };
  const form = (over: Partial<RegistrationFormRow> = {}) => ({ send_document: true, template_id: TPL, applicant_role_key: "merchant", signers_other: [director], ...over });

  it("is ready with a template, the applicant's role and a person for the other role that has something to sign", async () => {
    expect(formReadiness(form(), await states())).toEqual([]);
  });

  it("needs nothing when no document is sent", async () => {
    expect(formReadiness(form({ send_document: false, template_id: null, applicant_role_key: null, signers_other: [] }), null)).toEqual([]);
  });

  it("names what is missing", async () => {
    expect(formReadiness(form({ template_id: null }), null)).toEqual([{ code: "no_template" }]);
    expect(formReadiness(form(), null)).toEqual([{ code: "no_template" }]);
    expect(formReadiness(form(), { ...(await states()), status: "archived" })).toEqual([{ code: "template_not_active" }]);
    expect(formReadiness(form(), { name: "x", status: "active", version: null })).toEqual([{ code: "template_has_no_version" }]);
    expect(formReadiness(form({ applicant_role_key: null }), await states())).toEqual([{ code: "no_applicant_role" }]);
    expect(formReadiness(form({ applicant_role_key: "ghost" }), await states())).toEqual([{ code: "applicant_role_unknown", role: "ghost" }]);
    // the director has a signature to place and nobody is named
    expect(formReadiness(form({ signers_other: [] }), await states()).map((i) => i.code)).toEqual(["role_without_person"]);
    expect(formReadiness(form({ signers_other: [] }), await states())[0]).toMatchObject({ role: "director" });
  });

  it("refuses people for a role the template lacks or for the applicant's own role", async () => {
    const issues = formReadiness(form({ signers_other: [director, { ...director, role_key: "merchant" }, { ...director, role_key: "ghost" }] }), await states());
    expect(issues.filter((i) => i.code === "signer_role").map((i) => i.role)).toEqual(["merchant", "ghost"]);
  });

  it("reuses the rules a sender meets at Send: a signing role needs a signature, a person needs an email", async () => {
    // the finance contact only fills in: the merchant's signature then has nobody
    expect(formReadiness(form({ applicant_role_key: "finance" }), await states()).filter((i) => i.code === "role_without_person").map((i) => i.role)).toEqual(["merchant"]);
    expect(formReadiness(form({ signers_other: [{ ...director, email: "nope" }] }), await states()).map((i) => i.code)).toContain("signer_email");
  });
});

describe("making a form", () => {
  it("starts switched off with a fresh address, the defaults, and the person who made it", async () => {
    const f = await createForm(ctx, base());
    expect(f).toMatchObject({ account_id: ACCT, name: "Merchant sign-up", active: false, send_document: true, template_id: TPL, applicant_role_key: "merchant", contact_tag_id: TAG, daily_cap: 100, created_by: USER });
    expect(f.fields).toEqual(DEFAULT_ASKED);
    expect(f.slug).toMatch(SLUG_RE);
    expect(f.slug).toMatch(/^merchant-sign-up-[a-hj-km-np-z2-9]{8}$/);
    expect(f.slug).not.toContain(ACCT);
    expect(f.signers_other).toEqual([director]);
  });

  it("gives each form its own address", async () => {
    const a = await createForm(ctx, base());
    const b = await createForm(ctx, base());
    expect(a.slug).not.toBe(b.slug);
  });

  it("keeps the wording, the language and the cap it was given, and the email is always required", async () => {
    const f = await createForm(ctx, base({ fields: { email: "off", phone: "off", company: "optional" }, consentText: { ms: "Kami simpan." }, successMessage: { en: "Thanks" }, defaultLocale: "ms", dailyCap: 25 }));
    expect(f).toMatchObject({ fields: { full_name: "required", email: "required", phone: "off", company: "optional" }, consent_text: { ms: "Kami simpan." }, success_message: { en: "Thanks" }, default_locale: "ms", daily_cap: 25 });
  });

  it("can be made switched on only when it can work", async () => {
    expect((await createForm(ctx, base({ active: true }))).active).toBe(true);
    const err = await createForm(ctx, base({ active: true, signersOther: [] })).catch((e) => e);
    expect(err).toMatchObject({ code: "form_not_ready", status: 409 });
    expect(codes(err)).toEqual(["role_without_person"]);
    // the same form is fine while it is off, or when it sends no document
    expect((await createForm(ctx, base({ signersOther: [] }))).active).toBe(false);
    expect((await createForm(ctx, base({ active: true, sendDocument: false, templateId: null, applicantRoleKey: null, signersOther: [] }))).active).toBe(true);
  });

  it("refuses what is not valid, with the codes the screen words", async () => {
    expect(await createForm(ctx, {}).catch((e) => e)).toMatchObject({ code: "invalid_form", status: 400 });
    expect(await createForm(ctx, base({ dailyCap: 0 })).catch((e) => e)).toMatchObject({ code: "invalid_form" });
    expect(await createForm(ctx, base({ name: "<b>x</b>" })).catch((e) => e)).toMatchObject({ code: "invalid_form" });
    expect(await createForm(ctx, "x").catch((e) => e)).toMatchObject({ code: "invalid_form" });
    expect(db.rows("sign_registration_forms")).toHaveLength(0);
  });

  it("keeps the list of people who receive the signed copy, and starts with none", async () => {
    const plain = await createForm(ctx, base());
    expect(plain.copy_recipients).toEqual([]);
    const copies = [{ fullName: "Rahman", email: "rahman@vircle.example" }, { fullName: "Mei", email: "mei@vircle.example" }];
    const f = await createForm(ctx, base({ copyRecipients: copies }));
    expect(f.copy_recipients).toEqual(copies);
    // refused as a whole, with the codes the screen words, and nothing is made
    const before = db.rows("sign_registration_forms").length;
    expect(await createForm(ctx, base({ copyRecipients: [{ fullName: "A", email: "bad" }] })).catch((e) => e)).toMatchObject({ code: "invalid_form", status: 400, issues: [{ code: "copy_email", field: "copyRecipients", detail: "0" }] });
    expect(await createForm(ctx, base({ copyRecipients: Array.from({ length: 11 }, (_, i) => ({ fullName: `P${i}`, email: `p${i}@vircle.example` })) })).catch((e) => e)).toMatchObject({ code: "invalid_form" });
    expect(db.rows("sign_registration_forms")).toHaveLength(before);
  });

  it("only points at its own workspace's template and tag, and a tag that can be applied", async () => {
    expect(await createForm(ctx, base({ templateId: TPL_B })).catch((e) => e)).toMatchObject({ code: "template_not_found" });
    expect(await createForm(ctx, base({ templateId: "99999999-9999-4999-8999-999999999999" })).catch((e) => e)).toMatchObject({ code: "template_not_found" });
    // another workspace's, removed, waiting for approval, a conversation label only, or not there at all
    for (const tag of [TAG_OTHER, TAG_GONE, TAG_WAITING, TAG_LABEL, "99999999-9999-4999-8999-999999999999"]) {
      expect(await createForm(ctx, base({ contactTagId: tag })).catch((e) => e), tag).toMatchObject({ code: "tag_not_found" });
    }
    expect(db.rows("sign_registration_forms")).toHaveLength(0);
  });
});

describe("changing a form", () => {
  it("changes the list of people who receive a copy, clears it with an empty list, and leaves it alone when it is not sent", async () => {
    const f = await createForm(ctx, base({ copyRecipients: [{ fullName: "Rahman", email: "rahman@vircle.example" }] }));
    const renamed = await updateForm(ctx, f.id, { name: "Renamed" });
    expect(renamed.copy_recipients).toEqual([{ fullName: "Rahman", email: "rahman@vircle.example" }]);
    const two = await updateForm(ctx, f.id, { copyRecipients: [{ fullName: "Mei", email: "mei@vircle.example" }, { fullName: "Rahman", email: "rahman@vircle.example" }] });
    expect(two.copy_recipients.map((c) => c.email)).toEqual(["mei@vircle.example", "rahman@vircle.example"]);
    expect((await updateForm(ctx, f.id, { copyRecipients: [] })).copy_recipients).toEqual([]);
    expect(await updateForm(ctx, f.id, { copyRecipients: [{ fullName: "A", email: "a@b.example" }, { fullName: "B", email: "A@B.example" }] }).catch((e) => e)).toMatchObject({ code: "invalid_form", issues: [{ code: "copy_duplicate", detail: "1" }] });
    expect(db.rows("sign_registration_forms").find((r) => r.id === f.id)!.copy_recipients).toEqual([]);
  });

  it("changes only what is sent", async () => {
    const f = await createForm(ctx, base());
    const g = await updateForm(ctx, f.id, { dailyCap: 10 });
    expect(g).toMatchObject({ daily_cap: 10, name: "Merchant sign-up", template_id: TPL, slug: f.slug });
    expect(await updateForm(ctx, f.id, {})).toMatchObject({ daily_cap: 10 });
  });

  it("switches on a form that can work, and off at any time", async () => {
    const f = await createForm(ctx, base());
    expect((await updateForm(ctx, f.id, { active: true })).active).toBe(true);
    expect((await updateForm(ctx, f.id, { active: false })).active).toBe(false);
  });

  it("refuses to switch on a form that cannot work, and says why", async () => {
    const f = await createForm(ctx, base({ signersOther: [] }));
    const err = await updateForm(ctx, f.id, { active: true }).catch((e) => e);
    expect(err).toMatchObject({ code: "form_not_ready", status: 409 });
    expect(codes(err)).toEqual(["role_without_person"]);
    expect(db.rows("sign_registration_forms")[0].active).toBe(false);
    for (const [id, code] of [[TPL_DRAFT, "template_not_active"], [TPL_OLD, "template_not_active"]] as const) {
      expect(codes(await updateForm(ctx, f.id, { active: true, templateId: id }).catch((e) => e))).toEqual([code]);
    }
  });

  it("holds a live form to the rules when a change could break it, but never a rename", async () => {
    const f = await createForm(ctx, base({ active: true }));
    expect(await updateForm(ctx, f.id, { signersOther: [] }).catch((e) => e)).toMatchObject({ code: "form_not_ready" });
    expect(await updateForm(ctx, f.id, { templateId: null }).catch((e) => e)).toMatchObject({ code: "form_not_ready" });
    expect(await updateForm(ctx, f.id, { applicantRoleKey: "ghost" }).catch((e) => e)).toMatchObject({ code: "form_not_ready" });
    // the template since became unusable: the form can still be renamed or have its cap changed
    db.rows("sign_templates").find((t) => t.id === TPL)!.status = "archived";
    expect(await updateForm(ctx, f.id, { name: "Renamed", dailyCap: 5 })).toMatchObject({ name: "Renamed", daily_cap: 5, active: true });
    // ...and can be switched off
    expect((await updateForm(ctx, f.id, { active: false })).active).toBe(false);
  });

  it("does not find another workspace's form, or one that is not there", async () => {
    await createForm(ctx, base());
    db.seed("sign_registration_forms", [{ id: "other-form", account_id: "someone-else", slug: "other-form-aaaaaaaa", name: "Not ours", send_document: false }]);
    expect(await updateForm(ctx, "other-form", { name: "Hijacked" }).catch((e) => e)).toMatchObject({ code: "form_not_found", status: 404 });
    expect(await regenerateFormSlug(ctx, "other-form").catch((e) => e)).toMatchObject({ code: "form_not_found" });
    expect(await formView(ctx, "other-form").catch((e) => e)).toMatchObject({ code: "form_not_found" });
    expect(db.rows("sign_registration_forms").find((f) => f.id === "other-form")!.name).toBe("Not ours");
  });
});

describe("a new address", () => {
  it("keeps the readable start, draws a new end, and the old address stops answering at once", async () => {
    const f = await createForm(ctx, base({ active: true }));
    expect(await loadPublicForm(ctx.admin, f.slug)).not.toBeNull();
    const g = await regenerateFormSlug(ctx, f.id);
    expect(g.slug).not.toBe(f.slug);
    expect(g.slug.startsWith("merchant-sign-up-")).toBe(true);
    expect(g.slug).toMatch(SLUG_RE);
    expect(await loadPublicForm(ctx.admin, f.slug)).toBeNull();
    expect((await loadPublicForm(ctx.admin, g.slug))?.form.id).toBe(f.id);
  });
});

describe("the list and the numbers", () => {
  /** The database function's own arithmetic, written the same way, so the plumbing around it is tested with real-looking answers. */
  const countsHandler = () => {
    const seen: Record<string, unknown>[] = [];
    db.rpcHandlers.sign_registration_counts = async (args) => {
      seen.push(args);
      const since = args.p_since as string;
      const today = args.p_today as string;
      const byForm = new Map<string, Record<string, number>>();
      for (const r of db.rows("sign_registrations")) {
        if (r.account_id !== args.p_account || (r.created_at as string) < since) continue;
        const c = byForm.get(r.form_id as string) ?? { accepted: 0, rejected_spam: 0, rejected_cap: 0, failed: 0, today: 0 };
        if (r.status === "accepted") c.accepted++;
        if (r.status === "rejected_spam") c.rejected_spam++;
        if (r.status === "rejected_cap") c.rejected_cap++;
        if (r.status === "failed" && r.reason !== "in_progress") c.failed++;
        if (r.status === "accepted" && r.reason == null && (r.created_at as string) >= today) c.today++;
        byForm.set(r.form_id as string, c);
      }
      // a bigint arrives as text once it is large: both must be read
      return { data: [...byForm].map(([form_id, c]) => ({ form_id, accepted: String(c.accepted), rejected_spam: c.rejected_spam, rejected_cap: c.rejected_cap, failed: c.failed, today: c.today })), error: null };
    };
    return seen;
  };

  it("shows each form with its address, readiness and what came of the last 30 days", async () => {
    const f = await createForm(ctx, base({ active: true, dailyCap: 10 }));
    const seen = countsHandler();
    const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
    const row = (status: string, reason: string | null, hoursAgo: number, form = f.id) => ({ id: `${status}-${reason}-${hoursAgo}-${form}`, account_id: ACCT, form_id: form, status, reason, created_at: iso(hoursAgo), email_hash: "x".repeat(64) });
    db.seed("sign_registrations", [
      row("accepted", null, 1),
      row("accepted", null, 5),
      row("accepted", null, 40), // yesterday: counted in 30 days, not today
      row("accepted", "duplicate", 2), // a repeat: counted as accepted, not towards today
      row("failed", "sign_limit_reached", 3),
      row("failed", "in_progress", 3), // a claim still being handled: not an outcome yet
      row("rejected_spam", "honeypot", 3),
      row("rejected_spam", "token_invalid", 3),
      row("rejected_cap", "daily_cap", 3),
      row("accepted", null, 24 * 31), // older than 30 days
      row("accepted", null, 1, "other-form"),
    ]);
    const [item] = await listForms(ctx);
    expect(item.url).toBe(`https://halo.test/r/${f.slug}`);
    expect(item.issues).toEqual([]);
    expect(item.counts).toEqual({ accepted: 4, failed: 1, rejected_spam: 2, rejected_cap: 1, today: 2 });
    // asked once for the workspace, with the two windows measured from now
    expect(seen).toEqual([{ p_account: ACCT, p_since: new Date(NOW.getTime() - 30 * 24 * 3600_000).toISOString(), p_today: new Date(NOW.getTime() - 24 * 3600_000).toISOString() }]);
  });

  it("shows zeros for a form nobody has used, and fails loudly (not with wrong numbers) when it cannot count", async () => {
    await createForm(ctx, base());
    countsHandler();
    expect((await listForms(ctx))[0].counts).toEqual({ accepted: 0, failed: 0, rejected_spam: 0, rejected_cap: 0, today: 0 });
    db.rpcHandlers.sign_registration_counts = async () => ({ data: null, error: { message: "function does not exist" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(listForms(ctx)).rejects.toMatchObject({ code: "database_error" });
    vi.restoreAllMocks();
  });

  it("flags a form that cannot work, and lists only this workspace's forms", async () => {
    await createForm(ctx, base({ signersOther: [] }));
    db.seed("sign_registration_forms", [{ id: "other-form", account_id: "someone-else", slug: "other-form-aaaaaaaa", name: "Not ours", send_document: false }]);
    const list = await listForms(ctx);
    expect(list).toHaveLength(1);
    expect(list[0].issues.map((i) => i.code)).toEqual(["role_without_person"]);
  });

  it("shows the newest submissions without any address or email, and nothing of another form", async () => {
    const f = await createForm(ctx, base());
    for (let i = 0; i < 60; i++) {
      db.seed("sign_registrations", [{ id: `r${String(i).padStart(2, "0")}`, account_id: ACCT, form_id: f.id, status: "accepted", reason: null, contact_id: "c", document_id: "d", locale: "ms", ip_hash: "i".repeat(64), email_hash: "e".repeat(64), user_agent: "UA", consent_version: "v", created_at: new Date(NOW.getTime() - i * 1000).toISOString() }]);
    }
    db.seed("sign_registrations", [{ id: "mine-not", account_id: ACCT, form_id: "other", status: "failed", created_at: NOW.toISOString() }]);
    const entries = await listEntries(ctx, f.id);
    expect(entries).toHaveLength(50);
    expect(entries[0].id).toBe("r00");
    expect(Object.keys(entries[0]).sort()).toEqual(["contact_id", "created_at", "document_id", "id", "locale", "reason", "status"]);
    expect(JSON.stringify(entries)).not.toMatch(/i{20}|e{20}|UA/);
    expect(await listEntries(ctx, f.id, 5000)).toHaveLength(60);
    const view = await formView(ctx, f.id);
    expect(view.entries).toHaveLength(50);
    expect(view.url).toBe(`https://halo.test/r/${f.slug}`);
  });
});

describe("what the editor offers", () => {
  it("lists the active templates with a saved version and their roles, and the tags a contact can have", async () => {
    const o = await formOptions(ctx);
    expect(o.templates).toEqual([{ id: TPL, name: "Merchant Application", roles: [{ key: "merchant", label: "Merchant", kind: "signer" }, { key: "finance", label: "Finance contact", kind: "filler" }, { key: "director", label: "Director", kind: "signer" }], hasForm: false, mode: "sign" }]);
    expect(o.tags).toEqual([{ id: TAG, name: "Merchant applicant", color: "#f59e0b" }]);
  });
});

describe("under the person's own client", () => {
  it("is the same context with a different client, and nothing else", () => {
    const other = { marker: true } as never;
    const as = withUserClient(ctx, other);
    expect(as.admin).toBe(other);
    expect({ ...as, admin: ctx.admin }).toEqual(ctx);
  });
});
