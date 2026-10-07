import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import type { PlacedField } from "../pdf/types";
import type { SignDocumentRow, SignRole, SignSignerRow } from "../types";
import type { SignCtx } from "./context";
import { installEnvelopeRpcs } from "./envelope-fake";
import { addEnvelopeDocuments, removeEnvelopeDocument, reorderEnvelopeDocuments } from "./envelope-documents";
import { createEnvelopeDraft, setEnvelopeSigners, type EnvelopePersonInput } from "./envelopes";
import { FakeDb } from "./fake-db";

// Document collections (migration 171, 174): several files with templates in ONE order, and adding, removing and reordering the documents of a
// draft. The services run for real; the database's own rules (the places, draft only, same workspace) are stood in by envelope-fake.ts and
// proved by supabase/ci/verify-171-sign-envelopes.sql and verify-174-sign-envelope-documents.sql.

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const TPL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TPL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TPL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TPL_THEIRS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

let db: FakeDb;
let ctx: SignCtx;
let counter: number;
let pdfBytes: Uint8Array;

const ALI = { fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email" as const };
const BALA = { fullName: "Bala Krishnan", email: "bala@kedai.example", channel: "email" as const };

async function seedTemplate(id: string, name: string, account = ACCT, own: { roles?: SignRole[]; fields?: PlacedField[] } = {}) {
  const bytes = await makePdf([{ ...A4 }]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  db.files.set(`account-${account}/templates/${id}/v1.pdf`, bytes);
  db.seed("sign_templates", [{ id, account_id: account, name, status: "active", category_id: null, current_version_id: `ver-${id}` }]);
  db.seed("sign_template_versions", [{ id: `ver-${id}`, account_id: account, template_id: id, version_no: 1, source_path: `account-${account}/templates/${id}/v1.pdf`, source_sha256: sha, original_path: null, page_count: 1, fields: own.fields ?? fields, roles: own.roles ?? roles, defaults: {}, mode: "sign" }]);
}

beforeEach(async () => {
  db = new FakeDb();
  counter = 0;
  const deps: NotifyDeps = { emailConfigured: () => true, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "Vircle" }), sendWhatsApp: async () => {} };
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  db.insertDefaults.sign_envelopes = () => ({ status: "draft", reference: `ENV-2026-00000${++counter}`, locale: "en", sign_in_order: false, code_required: false, message: null, reminder_days: null, expires_at: null, sent_at: null, completed_at: null, void_reason: null, end_notified_at: null });
  db.insertDefaults.sign_documents = () => ({ reference: `SGN-2026-00000${++counter}`, mode: "sign", test: false, merge_values: {}, form_snapshot: null, envelope_id: null, envelope_position: null, final_path: null, final_sha256: null, completed_at: null, retain_until: null, void_reason: null, sent_at: null, expires_at: null });
  db.insertDefaults.sign_signers = () => ({ status: "pending", kind: "signer", invited_at: null, viewed_at: null, signed_at: null, consented_at: null, consent_version: null, last_reminded_at: null, reminder_count: 0, part_keys: null, delegated_by: null, forward_count: 0, forward_history: [], party_id: null, locale: null, ip: null, device: null, phone: null });
  installEnvelopeRpcs(db, { newToken: () => "a".repeat(64), now: () => "2026-10-06T08:00:00.000Z" });
  await seedTemplate(TPL_A, "Merchant Agreement");
  await seedTemplate(TPL_B, "Fee Schedule");
  await seedTemplate(TPL_C, "Merchant NDA", ACCT, { roles: [roles[0]], fields: fields.filter((f) => f.role === "merchant") });
  pdfBytes = await makePdf([{ ...A4 }]);
});

const docRows = () => db.rows("sign_documents") as unknown as SignDocumentRow[];
const signerRows = () => db.rows("sign_signers") as unknown as SignSignerRow[];
const inOrder = (envelopeId: string) =>
  docRows()
    .filter((d) => d.envelope_id === envelopeId)
    .sort((a, b) => (a.envelope_position ?? 0) - (b.envelope_position ?? 0));
const titles = (envelopeId: string) => inOrder(envelopeId).map((d) => d.title);
const events = (type: string) => db.rpcCalls.filter((c) => c.name === "sign_log" && c.args.p_type === type);
const baseFiles = () => [...db.files.keys()].filter((p) => p.includes("/base/")).length;
const file = (name: string) => ({ bytes: pdfBytes, filename: name });
const person = (who: typeof ALI, docIds: string[], role: string, step = 1): EnvelopePersonInput => ({ ...who, step, roles: Object.fromEntries(docIds.map((d) => [d, role])) });

describe("starting a collection from files and templates in one order", () => {
  it("makes the documents in the order given, files and templates interleaved, each a draft in its place", async () => {
    const { envelope, documents } = await createEnvelopeDraft(ctx, {
      templateIds: [],
      files: [file("Contract.pdf"), file("Annex.pdf")],
      order: [
        { kind: "template", id: TPL_A },
        { kind: "file", index: 1 },
        { kind: "template", id: TPL_B },
        { kind: "file", index: 0 },
      ],
    });
    expect(documents.map((d) => [d.envelope_position, d.title, d.status, d.envelope_id])).toEqual([
      [1, "Merchant Agreement", "draft", envelope.id],
      [2, "Annex", "draft", envelope.id],
      [3, "Fee Schedule", "draft", envelope.id],
      [4, "Contract", "draft", envelope.id],
    ]);
    expect(envelope.title).toBe("Merchant Agreement and 3 more");
    // the options of the collection are on every document, forwarding is off
    expect(documents.every((d) => d.allow_forwarding === false)).toBe(true);
  });

  it("takes the title the sender gave a document, and trims it", async () => {
    const { documents } = await createEnvelopeDraft(ctx, { templateIds: [], files: [file("a.pdf"), file("b.pdf")], order: [{ kind: "file", index: 1, title: "  Second  " }, { kind: "template", id: TPL_A, title: "Agreement for Kedai Ali" }, { kind: "file", index: 0 }] });
    expect(documents.map((d) => d.title)).toEqual(["Second", "Agreement for Kedai Ali", "a"]);
  });

  it("keeps working the old way: one file with templateIds and no order puts the file first", async () => {
    const { documents } = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B], file: file("Cover.pdf") });
    expect(documents.map((d) => [d.envelope_position, d.title])).toEqual([[1, "Cover"], [2, "Merchant Agreement"], [3, "Fee Schedule"]]);
  });

  it("makes six, refuses seven and one, and refuses an order that names a file that was not sent or leaves one out", async () => {
    const six = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B, TPL_C], files: [file("1.pdf"), file("2.pdf"), file("3.pdf")] });
    expect(six.documents).toHaveLength(6);
    const before = docRows().length;
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B, TPL_C], files: [file("1.pdf"), file("2.pdf"), file("3.pdf"), file("4.pdf")] })).rejects.toMatchObject({ code: "envelope_size" });
    await expect(createEnvelopeDraft(ctx, { templateIds: [], files: [file("1.pdf")] })).rejects.toMatchObject({ code: "envelope_size" });
    await expect(createEnvelopeDraft(ctx, { templateIds: [], files: [file("1.pdf")], order: [{ kind: "file", index: 0 }, { kind: "file", index: 5 }] })).rejects.toMatchObject({ code: "bad_order" });
    await expect(createEnvelopeDraft(ctx, { templateIds: [], files: [file("1.pdf"), file("2.pdf")], order: [{ kind: "file", index: 0 }, { kind: "template", id: TPL_A }] })).rejects.toMatchObject({ code: "bad_order" });
    expect(docRows()).toHaveLength(before);
    expect(db.rows("sign_envelopes")).toHaveLength(1);
  });

  it("is all or nothing: when the third document cannot be made, the first two and the collection are gone, files and all", async () => {
    const filesBefore = baseFiles();
    await expect(createEnvelopeDraft(ctx, { templateIds: [TPL_A], files: [file("ok.pdf"), { bytes: new TextEncoder().encode("plain text"), filename: "notes.txt" }], order: [{ kind: "file", index: 0 }, { kind: "template", id: TPL_A }, { kind: "file", index: 1 }] })).rejects.toMatchObject({ code: "upload_unsupported" });
    expect(db.rows("sign_envelopes")).toHaveLength(0);
    expect(docRows()).toHaveLength(0);
    expect(baseFiles()).toBe(filesBefore);
  });

  it("refuses a template of another workspace and the same template twice", async () => {
    await seedTemplate(TPL_THEIRS, "Theirs", OTHER);
    await expect(createEnvelopeDraft(ctx, { templateIds: [], files: [file("a.pdf")], order: [{ kind: "file", index: 0 }, { kind: "template", id: TPL_THEIRS }] })).rejects.toMatchObject({ code: "template_not_found" });
    await expect(createEnvelopeDraft(ctx, { templateIds: [], files: [file("a.pdf")], order: [{ kind: "template", id: TPL_A }, { kind: "template", id: TPL_A }, { kind: "file", index: 0 }] })).rejects.toMatchObject({ code: "envelope_duplicate_template" });
    expect(docRows()).toHaveLength(0);
  });
});

async function collection() {
  const { envelope, documents } = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B] });
  return { envelope, ids: documents.map((d) => d.id) };
}

describe("adding documents to a draft collection", () => {
  it("adds several files and templates after the ones it has, in order, with the collection's own options and links", async () => {
    const { envelope } = await collection();
    const { added, documents } = await addEnvelopeDocuments(ctx, envelope.id, { files: [file("One.pdf"), file("Two.pdf")], order: [{ kind: "file", index: 0 }, { kind: "template", id: TPL_C }, { kind: "file", index: 1 }] });
    expect(added.map((d) => [d.envelope_position, d.title])).toEqual([[3, "One"], [4, "Merchant NDA"], [5, "Two"]]);
    expect(documents).toHaveLength(5);
    expect(titles(envelope.id)).toEqual(["Merchant Agreement", "Fee Schedule", "One", "Merchant NDA", "Two"]);
    expect(added.every((d) => d.status === "draft" && d.allow_forwarding === false && d.envelope_id === envelope.id)).toBe(true);
    // each new document says so in its history
    expect(events("envelope_document_added")).toHaveLength(3);
    expect(events("envelope_document_added")[0].args).toMatchObject({ p_detail: { envelope_id: envelope.id, position: 3, count: 5 }, p_actor_type: "user" });
  });

  it("adds templates by id with no order, one by one", async () => {
    const { envelope } = await collection();
    await addEnvelopeDocuments(ctx, envelope.id, { templateIds: [TPL_C] });
    await addEnvelopeDocuments(ctx, envelope.id, { files: [file("Late.pdf")] });
    expect(titles(envelope.id)).toEqual(["Merchant Agreement", "Fee Schedule", "Merchant NDA", "Late"]);
  });

  it("holds six: what does not fit is refused as a whole and nothing is made", async () => {
    const { envelope } = await collection();
    const before = docRows().length;
    const filesBefore = baseFiles();
    await expect(addEnvelopeDocuments(ctx, envelope.id, { files: [file("1.pdf"), file("2.pdf"), file("3.pdf"), file("4.pdf"), file("5.pdf")] })).rejects.toMatchObject({ code: "envelope_full", status: 409 });
    expect(docRows()).toHaveLength(before);
    expect(baseFiles()).toBe(filesBefore);
    await addEnvelopeDocuments(ctx, envelope.id, { files: [file("1.pdf"), file("2.pdf"), file("3.pdf"), file("4.pdf")] });
    expect(inOrder(envelope.id)).toHaveLength(6);
    await expect(addEnvelopeDocuments(ctx, envelope.id, { files: [file("7.pdf")] })).rejects.toMatchObject({ code: "envelope_full" });
  });

  it("is all or nothing: when a later document cannot be made, the ones this call made are deleted again", async () => {
    const { envelope } = await collection();
    const filesBefore = baseFiles();
    await expect(addEnvelopeDocuments(ctx, envelope.id, { files: [file("fine.pdf"), { bytes: new TextEncoder().encode("x"), filename: "bad.txt" }] })).rejects.toMatchObject({ code: "upload_unsupported" });
    expect(titles(envelope.id)).toEqual(["Merchant Agreement", "Fee Schedule"]);
    expect(baseFiles()).toBe(filesBefore);
    expect(events("envelope_document_added")).toHaveLength(0);
  });

  it("asks for something to add, and is refused on a collection that was sent", async () => {
    const { envelope } = await collection();
    await expect(addEnvelopeDocuments(ctx, envelope.id, {})).rejects.toMatchObject({ code: "bad_order" });
    db.rows("sign_envelopes")[0].status = "sent";
    await expect(addEnvelopeDocuments(ctx, envelope.id, { templateIds: [TPL_C] })).rejects.toMatchObject({ code: "envelope_not_draft", status: 409 });
    expect(docRows()).toHaveLength(2);
  });

  it("never reaches into another workspace's collection", async () => {
    const { envelope } = await collection();
    const other: SignCtx = { ...ctx, accountId: OTHER };
    await expect(addEnvelopeDocuments(other, envelope.id, { templateIds: [TPL_C] })).rejects.toMatchObject({ code: "envelope_not_found" });
    await expect(reorderEnvelopeDocuments(other, envelope.id, inOrder(envelope.id).map((d) => d.id).reverse())).rejects.toMatchObject({ code: "envelope_not_found" });
    await expect(removeEnvelopeDocument(other, envelope.id, inOrder(envelope.id)[0].id)).rejects.toMatchObject({ code: "envelope_not_found" });
    expect(docRows()).toHaveLength(2);
  });

  it("closes a gap in the places first, so a sixth document has room", async () => {
    const { envelope } = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B, TPL_C], files: [file("1.pdf"), file("2.pdf")] });
    // a removal that left a gap (the places 1, 2, 3, 4 and 6 are in use)
    const docs = inOrder(envelope.id);
    docs[4].envelope_position = 6;
    await addEnvelopeDocuments(ctx, envelope.id, { files: [file("new.pdf")] });
    expect(inOrder(envelope.id).map((d) => d.envelope_position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(inOrder(envelope.id).at(-1)?.title).toBe("new");
  });
});

describe("removing a document from a draft collection", () => {
  it("deletes the draft with its files, closes up the places, writes the people again, and says so in the history", async () => {
    const { envelope, documents } = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B, TPL_C] });
    const ids = documents.map((d) => d.id);
    await setEnvelopeSigners(ctx, envelope.id, [person(ALI, ids, "merchant", 1), person(BALA, [ids[0], ids[1]], "director", 2)]);
    const gone = documents[0];
    const filesBefore = baseFiles();

    const { documents: left } = await removeEnvelopeDocument(ctx, envelope.id, gone.id);
    expect(left.map((d) => [d.envelope_position, d.title])).toEqual([[1, "Fee Schedule"], [2, "Merchant NDA"]]);
    expect(docRows().find((d) => d.id === gone.id)).toBeUndefined();
    expect(baseFiles()).toBe(filesBefore - 1);
    // each person's link row is on their (new) first document: one anchor each, whose id is the party id
    const live = signerRows().filter((s) => left.some((d) => d.id === s.document_id));
    const anchors = live.filter((s) => s.id === s.party_id);
    expect(anchors.map((s) => [s.email, s.document_id]).sort()).toEqual([
      ["ali@kedai.example", left[0].id],
      ["bala@kedai.example", left[0].id],
    ]);
    expect(live.filter((s) => s.email === "ali@kedai.example")).toHaveLength(2);
    expect(live.filter((s) => s.email === "bala@kedai.example")).toHaveLength(1);
    expect(events("envelope_document_removed")).toHaveLength(2);
    expect(events("envelope_document_removed")[0].args).toMatchObject({ p_detail: { title: "Merchant Agreement", count: 2, envelope_id: envelope.id } });
  });

  it("keeps two documents at least, and the next one added takes the next place after a removal", async () => {
    const { envelope, ids } = await collection();
    await expect(removeEnvelopeDocument(ctx, envelope.id, ids[0])).rejects.toMatchObject({ code: "envelope_minimum", status: 409 });
    expect(docRows()).toHaveLength(2);
    await addEnvelopeDocuments(ctx, envelope.id, { templateIds: [TPL_C] });
    await removeEnvelopeDocument(ctx, envelope.id, ids[0]);
    await addEnvelopeDocuments(ctx, envelope.id, { files: [file("Again.pdf")] });
    expect(inOrder(envelope.id).map((d) => [d.envelope_position, d.title])).toEqual([[1, "Fee Schedule"], [2, "Merchant NDA"], [3, "Again"]]);
  });

  it("never deletes a document that is not a draft, one that is in no such collection, or any document of a collection that was sent", async () => {
    const { envelope, ids } = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B, TPL_C] }).then((r) => ({ envelope: r.envelope, ids: r.documents.map((d) => d.id) }));
    const filesBefore = baseFiles();
    // a sent document in a draft collection (never made by the screens; the service holds the line anyway)
    docRows().find((d) => d.id === ids[0])!.status = "sent";
    await expect(removeEnvelopeDocument(ctx, envelope.id, ids[0])).rejects.toMatchObject({ code: "document_not_draft" });
    // a document of another collection, and of no collection, is not found through this one
    const second = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B] });
    await expect(removeEnvelopeDocument(ctx, envelope.id, second.documents[0].id)).rejects.toMatchObject({ code: "document_not_found", status: 404 });
    await expect(removeEnvelopeDocument(ctx, envelope.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "document_not_found" });
    expect(docRows().filter((d) => d.envelope_id === envelope.id)).toHaveLength(3);
    // and once the collection itself was sent, nothing in it is removed (signed or sealed documents included)
    docRows().find((d) => d.id === ids[0])!.status = "completed";
    docRows().find((d) => d.id === ids[1])!.status = "sealing";
    db.rows("sign_envelopes").find((e) => e.id === envelope.id)!.status = "in_progress";
    for (const id of ids) await expect(removeEnvelopeDocument(ctx, envelope.id, id)).rejects.toMatchObject({ code: "envelope_not_draft", status: 409 });
    expect(docRows().filter((d) => d.envelope_id === envelope.id)).toHaveLength(3);
    expect(baseFiles()).toBe(filesBefore + 2); // only the second collection's two copies were added
  });
});

describe("putting the documents of a draft collection in a new order", () => {
  it("writes the places, moves each person's link row to their new first document, and logs it", async () => {
    const { envelope, documents } = await createEnvelopeDraft(ctx, { templateIds: [TPL_A, TPL_B, TPL_C] });
    const [a, b, c] = documents.map((d) => d.id);
    await setEnvelopeSigners(ctx, envelope.id, [person(ALI, [a, b, c], "merchant", 1), person(BALA, [a, b], "director", 2)]);

    const { documents: next } = await reorderEnvelopeDocuments(ctx, envelope.id, [c, a, b]);
    expect(next.map((d) => [d.envelope_position, d.id])).toEqual([[1, c], [2, a], [3, b]]);
    const anchors = signerRows().filter((s) => s.id === s.party_id);
    expect(anchors.map((s) => [s.email, s.document_id]).sort()).toEqual([
      ["ali@kedai.example", c],
      ["bala@kedai.example", a],
    ]);
    expect(signerRows().filter((s) => s.email === "ali@kedai.example")).toHaveLength(3);
    expect(events("envelope_reordered")).toHaveLength(3);
  });

  it("does nothing, and logs nothing, when the order is the order it has", async () => {
    const { envelope, ids } = await collection();
    await reorderEnvelopeDocuments(ctx, envelope.id, ids);
    expect(events("envelope_reordered")).toHaveLength(0);
    expect(inOrder(envelope.id).map((d) => d.id)).toEqual(ids);
  });

  it("refuses a list that is not every document once, and a collection that was sent", async () => {
    const { envelope, ids } = await collection();
    await expect(reorderEnvelopeDocuments(ctx, envelope.id, [ids[0]])).rejects.toMatchObject({ code: "bad_order" });
    await expect(reorderEnvelopeDocuments(ctx, envelope.id, [ids[0], ids[0]])).rejects.toMatchObject({ code: "bad_order" });
    await expect(reorderEnvelopeDocuments(ctx, envelope.id, [ids[0], "00000000-0000-4000-8000-000000000000"])).rejects.toMatchObject({ code: "bad_order" });
    expect(inOrder(envelope.id).map((d) => d.id)).toEqual(ids);
    db.rows("sign_envelopes")[0].status = "sent";
    await expect(reorderEnvelopeDocuments(ctx, envelope.id, [ids[1], ids[0]])).rejects.toMatchObject({ code: "envelope_not_draft", status: 409 });
    expect(inOrder(envelope.id).map((d) => d.id)).toEqual(ids);
  });
});
