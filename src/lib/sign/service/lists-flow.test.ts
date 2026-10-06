import { beforeEach, describe, expect, it } from "vitest";

import { displayValue, type FormDefinition, type L10n } from "../forms";
import { exportCsv } from "../lists/csv";
import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import type { PlacedField } from "../pdf/types";
import { SYSTEM_LISTS } from "../lists/system-lists";
import type { ListItem } from "../lists/types";
import { hashToken } from "../tokens";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { createDraftFromTemplate, setSigners } from "./drafts";
import { FakeDb } from "./fake-db";
import { createList, ensureSystemLists, exportList, getList, importIntoList, listAll, listsAreCurrent, loadCatalogue, refreshFormLists, resetList, resolveFormForSave, updateList } from "./lists";
import { sendDocument } from "./send";
import { buildView, lookupByToken, saveAnswers } from "./signing";
import { createTemplateFromDocument, createTemplateFromUpload, duplicateTemplate, saveTemplateVersion, updateTemplate } from "./templates";

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "a".repeat(64);

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });

const FORM: FormDefinition = {
  version: 1,
  parts: [{ key: "company", title: L("Company"), role: "merchant" }],
  fields: [
    { key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true },
    { key: "state", type: "choice", part: "company", label: L("State"), required: true, optionList: "states_my" },
    { key: "country", type: "choice", part: "company", label: L("Country"), required: false, optionList: "countries", defaultValue: "MY" },
    { key: "msic", type: "list", part: "company", label: L("MSIC codes"), required: true, maxItems: 3, itemFormat: "digits", itemLength: 5, optionList: "msic" },
  ],
};
const roles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];
const fields: PlacedField[] = [
  { key: "p_state", type: "text", role: "sender", page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.04, required: false, data: "state" },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.5, w: 0.4, h: 0.08, required: true },
  { key: "mname", type: "name", role: "merchant", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.04, required: true },
  { key: "mdate", type: "date_signed", role: "merchant", page: 0, x: 0.55, y: 0.5, w: 0.3, h: 0.04, required: true },
];

/** What the database function sign_seed_option_lists does, for a workspace: copy the shipped lists it does not have. */
function seedLists(db: FakeDb, account: string, only?: string[]) {
  const have = new Set(db.rows("sign_option_lists").filter((r) => r.account_id === account).map((r) => r.key));
  const rows = SYSTEM_LISTS.filter((l) => !have.has(l.key) && (!only || only.includes(l.key))).map((l) => ({
    id: `list-${account.slice(0, 4)}-${l.key}`,
    account_id: account,
    key: l.key,
    name: l.name,
    description: l.description,
    kind: l.kind,
    items: JSON.parse(JSON.stringify(l.items)) as ListItem[],
    item_count: l.items.length,
    is_system: true,
    version: 1,
    archived: false,
  }));
  db.seed("sign_option_lists", rows);
  return rows.length;
}

function setup() {
  const db = new FakeDb();
  const mail: { to: string; text: string }[] = [];
  const deps: NotifyDeps = {
    emailConfigured: () => true,
    sendEmail: async (a) => void mail.push({ to: a.to, text: a.text }),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
  };
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-07T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "g@vircle.example" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, retention_years: 7, certificate_id: null }]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
  let seedCalls = 0;
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_seed_option_lists = async (a) => {
    seedCalls++;
    return { data: seedLists(db, String(a.p_account)), error: null };
  };
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_send_document = async (args) => {
    const doc = db.rows("sign_documents").find((d) => d.id === args.p_document)!;
    // the database trigger: once sent, the form is frozen
    Object.assign(doc, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at, reference: "SGN-2026-000001", sent_at: "2026-10-07T08:00:00Z" });
    const people = db.rows("sign_signers").filter((s) => s.document_id === args.p_document);
    const invited = people.map((p) => ({ signer_id: p.id, token: TOKEN, name: p.full_name, email: p.email, phone: null, channel: p.channel, role_key: p.role_key, kind: p.kind, order_no: p.order_no }));
    for (const p of people) {
      Object.assign(p, { status: "sent", invited_at: "2026-10-07T08:00:00Z", consented_at: "2026-10-07T08:00:00Z" });
      db.seed("sign_signer_secrets", [{ signer_id: p.id, account_id: ACCT, token_hash: hashToken(TOKEN), code_hash: null, code_expires_at: null, code_attempts: 0 }]);
    }
    return { data: { reference: "SGN-2026-000001", invited }, error: null };
  };
  return { db, ctx, mail, seedCalls: () => seedCalls };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  t = setup();
});

const listRow = (key: string, account = ACCT) => t.db.rows("sign_option_lists").find((r) => r.key === key && r.account_id === account)!;
const itemsOf = (key: string) => listRow(key).items as ListItem[];
const field = (f: FormDefinition, key: string) => f.fields.find((x) => x.key === key)!;

async function makeTemplate() {
  const { template } = await createTemplateFromUpload(t.ctx, { bytes: await makePdf([{ ...A4 }]), filename: "Form.pdf", name: "Merchant form" });
  const saved = await saveTemplateVersion(t.ctx, template.id, { fields, roles, form: FORM });
  await updateTemplate(t.ctx, template.id, { status: "active" });
  return { template, ...saved };
}

describe("saving a template version with a form that names lists", () => {
  it("copies the lists' items into the fields' options and keeps the names", async () => {
    const { version } = await makeTemplate();
    const form = version.form!;
    expect(field(form, "state")).toMatchObject({ optionList: "states_my" });
    expect(field(form, "state").options).toHaveLength(16);
    expect(field(form, "state").options?.[0]).toEqual({ value: "johor", label: { en: "Johor", ms: "Johor", zh: "柔佛", ko: "조호르" } });
    expect(field(form, "country").options).toHaveLength(249);
    expect(field(form, "msic").options).toHaveLength(1174);
    expect(field(form, "msic").options?.find((o) => o.value === "62010")?.label).toEqual({ en: "Computer programming activities", ms: "Aktiviti pengaturcaraan komputer" });
    // a version stores what the builder posted with the options taken off or put on, the same either way
    const again = await saveTemplateVersion(t.ctx, (await t.db.rows("sign_templates"))[0].id as string, { fields, roles, form: { ...form, fields: form.fields.map((f) => ({ ...f, options: f.optionList ? [{ value: "stale", label: L("Stale") }] : f.options })) } });
    expect(field(again.version.form!, "state").options).toHaveLength(16);
  });

  it("asks for the shipped lists when the workspace does not have them yet, once", async () => {
    expect(t.db.rows("sign_option_lists")).toHaveLength(0);
    await makeTemplate();
    expect(t.db.rows("sign_option_lists").filter((r) => r.account_id === ACCT)).toHaveLength(7);
    expect(t.seedCalls()).toBeGreaterThanOrEqual(1);
    const calls = t.seedCalls();
    await loadCatalogue(t.ctx, ["states_my", "msic"]);
    expect(t.seedCalls()).toBe(calls);
  });

  it("refuses a field that names a list the workspace does not have, with the issue, and saves nothing", async () => {
    const { template } = await createTemplateFromUpload(t.ctx, { bytes: await makePdf([{ ...A4 }]), filename: "Form.pdf" });
    const before = t.db.rows("sign_template_versions").length;
    const bad: FormDefinition = { ...FORM, fields: [...FORM.fields, { key: "ghost", type: "choice", part: "company", label: L("Ghost"), required: false, optionList: "no_such_list" }] };
    await expect(saveTemplateVersion(t.ctx, template.id, { fields, roles, form: bad })).rejects.toMatchObject({ code: "invalid_layout", issues: expect.arrayContaining([{ code: "unknown_list", field: "ghost", detail: "no_such_list" }]) });
    expect(t.db.rows("sign_template_versions")).toHaveLength(before);
  });

  it("refuses a list that has no active item", async () => {
    await ensureSystemLists(t.ctx);
    const { template } = await createTemplateFromUpload(t.ctx, { bytes: await makePdf([{ ...A4 }]), filename: "Form.pdf" });
    const mine = await createList(t.ctx, { name: "Hidden", items: [{ value: "a", label: L("A"), archived: true }] });
    const f: FormDefinition = { ...FORM, fields: [{ key: "pick", type: "choice", part: "company", label: L("Pick"), required: false, optionList: mine.key }] };
    await expect(saveTemplateVersion(t.ctx, template.id, { fields: [], roles, form: f })).rejects.toMatchObject({ issues: [{ code: "list_empty", field: "pick", detail: mine.key }] });
  });

  it("a placement-only save keeps a field's options when its list was emptied later, where editing the form refuses", async () => {
    const { template, version } = await makeTemplate();
    await updateList(t.ctx, "states_my", { items: itemsOf("states_my").map((i) => ({ ...i, archived: true })) });
    const kept = await saveTemplateVersion(t.ctx, template.id, { fields, roles });
    expect(field(kept.version.form!, "state").options).toHaveLength(16);
    await expect(saveTemplateVersion(t.ctx, template.id, { fields, roles, form: version.form })).rejects.toMatchObject({ code: "invalid_layout", issues: [{ code: "list_empty", field: "state", detail: "states_my" }] });
  });

  it("does not read another workspace's lists", async () => {
    seedLists(t.db, OTHER, ["states_my"]);
    expect(t.db.rows("sign_option_lists").filter((r) => r.account_id === ACCT)).toHaveLength(0);
    const catalogue = await loadCatalogue(t.ctx, ["states_my"]);
    expect([...catalogue.values()]).toHaveLength(1);
    expect(t.db.rows("sign_option_lists").filter((r) => r.account_id === ACCT && r.key === "states_my")).toHaveLength(1);
    // editing the other workspace's list is not visible here
    listRow("states_my", OTHER).items = [{ value: "only_there", label: L("Only there") }];
    expect((await loadCatalogue(t.ctx, ["states_my"])).get("states_my")?.items.length).toBe(16);
  });
});

describe("a document is frozen with the form it was sent with", () => {
  async function sentFrom(templateId: string) {
    const doc = await createDraftFromTemplate(t.ctx, { templateId });
    await setSigners(t.ctx, doc.id, [{ roleKey: "merchant", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email", orderNo: 1 }]);
    await sendDocument(t.ctx, doc.id);
    return doc.id;
  }
  const snapshot = (docId: string) => t.db.rows("sign_documents").find((d) => d.id === docId)!.form_snapshot as FormDefinition;

  it("a draft made after a list was edited has the edit; a document sent keeps what it had, whatever happens to the list afterwards", async () => {
    const { template } = await makeTemplate();
    const early = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    expect(field(early.form_snapshot!, "state").options?.[0].label.en).toBe("Johor");

    // the admin relabels one state, adds one and hides another
    await updateList(t.ctx, "states_my", {
      items: itemsOf("states_my").map((i) => (i.value === "johor" ? { ...i, label: { ...i.label, en: "Johor Darul Takzim" } } : i.value === "perlis" ? { ...i, archived: true } : i)).concat({ value: "labuan_extra", label: L("Labuan extra") }),
    });

    // a draft made now starts from today's list; the draft made before is unchanged until it is sent
    const late = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    const lateState = field(late.form_snapshot!, "state").options!;
    expect(lateState.find((o) => o.value === "johor")?.label.en).toBe("Johor Darul Takzim");
    expect(lateState.some((o) => o.value === "perlis")).toBe(false);
    expect(lateState.some((o) => o.value === "labuan_extra")).toBe(true);
    expect(field(snapshot(early.id), "state").options?.[0].label.en).toBe("Johor");

    // sending reads the lists once more and freezes the result
    await setSigners(t.ctx, early.id, [{ roleKey: "merchant", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email", orderNo: 1 }]);
    await sendDocument(t.ctx, early.id);
    const frozen = snapshot(early.id);
    expect(field(frozen, "state").options?.find((o) => o.value === "johor")?.label.en).toBe("Johor Darul Takzim");

    // from now on the list can change as it likes: the document does not
    await updateList(t.ctx, "states_my", { items: itemsOf("states_my").map((i) => (i.value === "kedah" ? { ...i, label: { en: "Kedah (renamed again)" } } : i)).concat({ value: "added_after", label: L("Added after") }) });
    const stillFrozen = snapshot(early.id);
    expect(JSON.stringify(stillFrozen)).toBe(JSON.stringify(frozen));
    expect(field(stillFrozen, "state").options?.some((o) => o.value === "added_after")).toBe(false);
    expect(field(stillFrozen, "state").options?.find((o) => o.value === "kedah")?.label.en).toBe("Kedah");
    expect(await listsAreCurrent(t.ctx, stillFrozen)).toBe(false);
    expect(await listsAreCurrent(t.ctx, (await refreshFormLists(t.ctx, stillFrozen)))).toBe(true);
  });

  it("the signer's page, the checks on an answer and the printed words all come from the frozen options", async () => {
    const { template } = await makeTemplate();
    const docId = await sentFrom(template.id);
    // the list changes after the document went out
    await updateList(t.ctx, "states_my", { items: itemsOf("states_my").map((i) => (i.value === "johor" ? { ...i, label: { en: "Johor (new wording)" } } : i)).concat({ value: "added_after", label: L("Added after") }) });
    await updateList(t.ctx, "msic", { items: itemsOf("msic").map((i) => (i.value === "62010" ? { ...i, label: { en: "Changed wording" } } : i)) });

    const look = async () => (await lookupByToken(t.ctx.admin, TOKEN))!;
    const view = await buildView(t.ctx, await look(), false);
    const defn = view.content!.form!.definition;
    expect(field(defn, "state").options).toHaveLength(16);
    expect(field(defn, "state").options?.find((o) => o.value === "johor")?.label.en).toBe("Johor");
    expect(field(defn, "msic").options).toHaveLength(1174);
    expect(field(defn, "msic").options?.find((o) => o.value === "62010")?.label.en).toBe("Computer programming activities");

    // an answer that was a valid choice when the document was sent is still valid, one that came later is not
    const ok = await saveAnswers(t.ctx, await look(), { state: { text: "johor" }, msic: { list: ["62010", "47111"] }, legalName: { text: "Kedai Ali" } });
    expect(ok.rejected).toEqual([]);
    const refused = await saveAnswers(t.ctx, await look(), { state: { text: "added_after" } });
    expect(refused.rejected).toEqual([{ field: "state", code: "not_an_option" }]);
    const notACode = await saveAnswers(t.ctx, await look(), { msic: { list: ["62010", "00000"] } });
    expect(notACode.rejected).toEqual([{ field: "msic", code: "not_an_option" }]);
    const tooMany = await saveAnswers(t.ctx, await look(), { msic: { list: ["62010", "47111", "01111", "62021"] } });
    expect(tooMany.rejected).toEqual([{ field: "msic", code: "too_many_items", detail: "3" }]);

    // what is printed uses the label as it was when the document was sent
    const answer = t.db.rows("sign_answers").find((a) => a.field_key === "state")!;
    expect(answer.value).toEqual({ text: "johor" });
    const frozen = t.db.rows("sign_documents").find((d) => d.id === docId)!.form_snapshot as FormDefinition;
    expect(displayValue(field(frozen, "state"), { text: "johor" }, "en")).toBe("Johor");
    expect(displayValue(field(frozen, "msic"), { list: ["62010", "47111"] }, "en")).toBe("62010, 47111");
  });

  it("sending reads the lists as they are, and a list that has gone cannot stop a document that was prepared with it", async () => {
    const { template } = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    await setSigners(t.ctx, doc.id, [{ roleKey: "merchant", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email", orderNo: 1 }]);
    // every list of the workspace disappears (a restored backup, a bug): the draft still has its own copy
    t.db.tables.sign_option_lists = [];
    t.db.rpcHandlers.sign_seed_option_lists = async () => ({ data: 0, error: null });
    const sent = await sendDocument(t.ctx, doc.id);
    expect(sent.reference).toBe("SGN-2026-000001");
    const frozen = t.db.rows("sign_documents").find((d) => d.id === doc.id)!.form_snapshot as FormDefinition;
    expect(field(frozen, "state").options).toHaveLength(16);
  });

  it("a template made from a document, or a duplicate, starts from today's lists", async () => {
    const { template } = await makeTemplate();
    const doc = await createDraftFromTemplate(t.ctx, { templateId: template.id });
    await updateList(t.ctx, "banks_my", { items: itemsOf("banks_my") });
    await updateList(t.ctx, "states_my", { items: itemsOf("states_my").concat({ value: "newest", label: L("Newest") }) });
    const dup = await duplicateTemplate(t.ctx, template.id, "Copy");
    expect(field(dup.version.form!, "state").options?.some((o) => o.value === "newest")).toBe(true);
    const fromDoc = await createTemplateFromDocument(t.ctx, doc.id, { name: "From draft" });
    expect(field(fromDoc.version.form!, "state").options?.some((o) => o.value === "newest")).toBe(true);
    // the original version is untouched
    const original = t.db.rows("sign_template_versions").find((v) => v.template_id === template.id && v.version_no === 2) as { form: FormDefinition };
    expect(field(original.form, "state").options?.some((o) => o.value === "newest")).toBe(false);
  });
});

describe("a form with no list is left alone", () => {
  it("makes no call to the lists at all", async () => {
    const plain: FormDefinition = { version: 1, parts: FORM.parts, fields: [{ key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true }] };
    expect(await resolveFormForSave(t.ctx, plain)).toBe(plain);
    expect(await refreshFormLists(t.ctx, plain)).toBe(plain);
    expect(t.seedCalls()).toBe(0);
  });
});

describe("the lists screen's operations", () => {
  it("lists the seven shipped lists first, then the workspace's own, without their items", async () => {
    await createList(t.ctx, { name: "Our suppliers", description: "Who we buy from" });
    const all = await listAll(t.ctx);
    expect(all.map((l) => l.key)).toEqual(["states_my", "countries", "banks_my", "company_id_types", "einvoice_phases", "tax_types", "msic", "our_suppliers"]);
    expect(all[6]).toMatchObject({ key: "msic", kind: "msic", is_system: true, itemCount: 1174 });
    expect(all[7]).toMatchObject({ is_system: false, itemCount: 0, description: "Who we buy from" });
    expect(JSON.stringify(all)).not.toContain("Growing of maize");
  });

  it("makes a list with a key from its name, never one a shipped list uses, and refuses a bad one", async () => {
    const a = await createList(t.ctx, { name: "Our suppliers", items: [{ value: "acme", label: L("Acme") }] });
    expect(a).toMatchObject({ key: "our_suppliers", kind: "options", is_system: false });
    expect((await createList(t.ctx, { name: "Our suppliers" })).key).toBe("our_suppliers_2");
    expect((await createList(t.ctx, { name: "MSIC" })).key).toBe("msic_2");
    expect((await createList(t.ctx, { name: "Banks MY" })).key).toBe("banks_my_2");
    await expect(createList(t.ctx, { name: "  " })).rejects.toMatchObject({ code: "bad_list", issues: expect.arrayContaining([{ code: "bad_name" }]) });
    await expect(createList(t.ctx, { name: "Dup", items: [{ value: "a", label: L("A") }, { value: "a", label: L("B") }] })).rejects.toMatchObject({ code: "bad_list", issues: [{ code: "duplicate_value", field: "a" }] });
  });

  it("relabels, adds, reorders and archives items; renames and archives the list", async () => {
    await ensureSystemLists(t.ctx);
    const row = await updateList(t.ctx, "tax_types", {
      name: "Taxes",
      description: "  Which tax  ",
      items: [...itemsOf("tax_types")].reverse().map((i) => (i.value === "sst" ? { ...i, label: { ...i.label, en: "SST " } } : i)).concat({ value: "new_tax", label: { en: " New tax ", ms: "Cukai baru" } }),
    });
    expect(row).toMatchObject({ name: "Taxes", description: "Which tax" });
    expect(row.items.map((i: ListItem) => i.value)).toEqual(["na", "tourism_tax", "sales_tax", "service_tax", "sst", "new_tax"]);
    expect(row.items.find((i: ListItem) => i.value === "sst")?.label.en).toBe("SST");
    expect(row.items[5].label).toEqual({ en: "New tax", ms: "Cukai baru" });
    expect((await updateList(t.ctx, "tax_types", { archived: true })).archived).toBe(true);
    expect((await updateList(t.ctx, "tax_types", { archived: false })).archived).toBe(false);
    await expect(updateList(t.ctx, "tax_types", { name: " " })).rejects.toMatchObject({ code: "bad_list" });
    await expect(updateList(t.ctx, "tax_types", { archived: "yes" as never })).rejects.toMatchObject({ code: "bad_list" });
    await expect(updateList(t.ctx, "does_not_exist", { name: "x" })).rejects.toMatchObject({ code: "list_not_found", status: 404 });
    await expect(updateList(t.ctx, "Bad Key", { name: "x" })).rejects.toMatchObject({ code: "list_not_found", status: 404 });
  });

  it("never lets a list that comes with Doc Sign lose a value, and says which would have gone", async () => {
    await ensureSystemLists(t.ctx);
    const err = await updateList(t.ctx, "states_my", { items: itemsOf("states_my").filter((i) => i.value !== "johor" && i.value !== "kedah") }).catch((e) => e);
    expect(err).toMatchObject({ code: "list_values_locked", status: 409, issues: [{ code: "value_removed", field: "johor" }, { code: "value_removed", field: "kedah" }] });
    expect(itemsOf("states_my")).toHaveLength(16);
    // an ordinary list may
    const mine = await createList(t.ctx, { name: "Mine", items: [{ value: "a", label: L("A") }, { value: "b", label: L("B") }] });
    expect((await updateList(t.ctx, mine.key, { items: [{ value: "b", label: L("B") }] })).items).toHaveLength(1);
  });

  it("refuses MSIC codes that are not five digits", async () => {
    await ensureSystemLists(t.ctx);
    await expect(updateList(t.ctx, "msic", { items: itemsOf("msic").concat({ value: "1234", label: L("Short") }) })).rejects.toMatchObject({ code: "bad_list", issues: [{ code: "bad_msic_code", field: "1234" }] });
    expect((await updateList(t.ctx, "msic", { items: itemsOf("msic").concat({ value: "99998", label: L("Our own code") }) })).items).toHaveLength(1175);
  });

  it("imports a CSV: a preview first, then the change; a system list can only be merged", async () => {
    await ensureSystemLists(t.ctx);
    const csv = "﻿value,en,ms,zh\r\njohor,Johor,Johor Darul Takzim,\r\nnew_state,\"New, state\",Negeri baru,新州\r\n,No value,,\r\n";
    const preview = await importIntoList(t.ctx, "states_my", { csv, mode: "merge", dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, added: 1, updated: 1, unchanged: 0, removed: 0 });
    expect(preview.problems).toEqual([{ row: 3, code: "empty_value", level: "error" }]);
    expect(preview.list).toBeUndefined();
    expect(itemsOf("states_my")).toHaveLength(16);

    const done = await importIntoList(t.ctx, "states_my", { csv, mode: "merge" });
    expect(done.list?.items).toHaveLength(17);
    expect(itemsOf("states_my").find((i) => i.value === "johor")?.label).toMatchObject({ ms: "Johor Darul Takzim", zh: "柔佛" });
    expect(itemsOf("states_my")[16]).toEqual({ value: "new_state", label: { en: "New, state", ms: "Negeri baru", zh: "新州" } });
    await expect(importIntoList(t.ctx, "states_my", { csv, mode: "replace" })).rejects.toMatchObject({ code: "system_list_merge_only", status: 409 });
  });

  it("replaces an ordinary list with the file, and refuses a file that is no use at all, row by row", async () => {
    const mine = await createList(t.ctx, { name: "Mine", items: [{ value: "old", label: L("Old") }] });
    const r = await importIntoList(t.ctx, mine.key, { csv: "value,en\nnew_1,One\nnew_2,Two", mode: "replace" });
    expect(r).toMatchObject({ added: 2, removed: 1 });
    expect(itemsOf(mine.key).map((i) => i.value)).toEqual(["new_1", "new_2"]);
    await expect(importIntoList(t.ctx, mine.key, { csv: "name,note\nx,y", mode: "merge" })).rejects.toMatchObject({ code: "import_failed", issues: [{ code: "missing_value_column", field: "0" }] });
    await expect(importIntoList(t.ctx, mine.key, { csv: "value,en\n,\n", mode: "merge" })).rejects.toMatchObject({ code: "import_failed", issues: [{ code: "no_rows", field: "0" }] });
    await expect(importIntoList(t.ctx, mine.key, { csv: "value,en\n,Only a label\nbad value,Space", mode: "merge" })).rejects.toMatchObject({ code: "import_failed", issues: [{ code: "empty_value", field: "1" }, { code: "bad_value", field: "2", detail: "bad value" }] });
    await expect(importIntoList(t.ctx, mine.key, { csv: 5 as never, mode: "merge" })).rejects.toMatchObject({ code: "bad_import" });
    await expect(importIntoList(t.ctx, mine.key, { csv: "value,en\na,A", mode: "wrong" as never })).rejects.toMatchObject({ code: "bad_import" });
    await expect(importIntoList(t.ctx, mine.key, { csv: "x".repeat(2_000_001), mode: "merge" })).rejects.toMatchObject({ code: "body_too_large", status: 413 });
  });

  it("loads the full MSIC list from a CSV an admin supplies (code, English, Malay)", async () => {
    await ensureSystemLists(t.ctx);
    const csv = ["Code,Description,Description (Malay)", "1111,Growing of maize,Penanaman jagung", "99998,Our own code,Kod kami"].join("\n");
    const r = await importIntoList(t.ctx, "msic", { csv, mode: "merge" });
    expect(r).toMatchObject({ added: 1, unchanged: 1, updated: 0 });
    expect(r.problems).toEqual([{ row: 1, code: "code_padded", level: "warning", detail: "1111" }]);
    expect(itemsOf("msic")).toHaveLength(1175);
  });

  it("exports a list that imports back as it was", async () => {
    await ensureSystemLists(t.ctx);
    const { filename, csv } = await exportList(t.ctx, "countries");
    expect(filename).toBe("countries.csv");
    expect(csv.startsWith("﻿value,en,ms,zh,ko,group,archived")).toBe(true);
    const before = JSON.stringify(itemsOf("countries"));
    const r = await importIntoList(t.ctx, "countries", { csv, mode: "merge" });
    expect(r).toMatchObject({ added: 0, updated: 0, unchanged: 249 });
    expect(JSON.stringify(itemsOf("countries"))).toBe(before);
    expect(exportCsv(itemsOf("countries"))).toBe(csv);
  });

  it("puts a system list back as shipped, keeping what was added, and refuses on an ordinary list", async () => {
    await ensureSystemLists(t.ctx);
    await updateList(t.ctx, "banks_my", { items: itemsOf("banks_my").map((i) => (i.value === "maybank" ? { ...i, label: { en: "Mayb@nk" }, archived: true } : i)).concat({ value: "my_credit_union", label: L("Credit union") }) });
    const back = await resetList(t.ctx, "banks_my");
    expect(back.items.find((i) => i.value === "maybank")).toEqual({ value: "maybank", label: { en: "Maybank" } });
    expect(back.items[back.items.length - 1]).toEqual({ value: "my_credit_union", label: L("Credit union") });
    expect(back.items).toHaveLength(30);
    const mine = await createList(t.ctx, { name: "Mine" });
    await expect(resetList(t.ctx, mine.key)).rejects.toMatchObject({ code: "not_a_system_list" });
  });

  it("says which templates use a list, from their current version", async () => {
    const { template } = await makeTemplate();
    const a = await getList(t.ctx, "states_my");
    expect(a.usedBy).toEqual([{ id: template.id, name: "Merchant form", status: "active" }]);
    expect((await getList(t.ctx, "tax_types")).usedBy).toEqual([]);
    expect(a.list.items).toHaveLength(16);
    // a template that no longer names it does not count
    await saveTemplateVersion(t.ctx, template.id, { fields: [], roles, form: { ...FORM, fields: FORM.fields.filter((f) => f.optionList !== "states_my") } });
    expect((await getList(t.ctx, "states_my")).usedBy).toEqual([]);
  });

  it("finds a shipped list the workspace does not have yet by asking for it", async () => {
    expect((await getList(t.ctx, "tax_types")).list.is_system).toBe(true);
    await expect(getList(t.ctx, "suppliers")).rejects.toMatchObject({ code: "list_not_found" });
  });
});
