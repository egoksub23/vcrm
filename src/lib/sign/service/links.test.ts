import { beforeEach, describe, expect, it } from "vitest";

import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import { fromDatabaseError } from "./errors";
import type { SignCtx } from "./context";
import { createDraftFromTemplate, createDraftFromUpload, updateDraft } from "./drafts";
import { FakeDb } from "./fake-db";
import { decideLinks, resolveLinks } from "./links";

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const ALI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BALA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: FakeDb;
let ctx: SignCtx;

beforeEach(() => {
  db = new FakeDb();
  const deps: NotifyDeps = { emailConfigured: () => true, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "Vircle" }), sendWhatsApp: async () => {} };
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-08T08:00:00Z") };
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null }]);
  db.seed("contacts", [
    { id: ALI, account_id: ACCT, name: "Ali", deleted_at: null },
    { id: BALA, account_id: ACCT, name: "Bala", deleted_at: null },
  ]);
  db.seed("tickets", [
    { id: "tk-ali", account_id: ACCT, contact_id: ALI, subject: "Ali's ticket" },
    { id: "tk-bala", account_id: ACCT, contact_id: BALA, subject: "Bala's ticket" },
    { id: "tk-theirs", account_id: OTHER, contact_id: "x", subject: "Another workspace" },
  ]);
  db.seed("deals", [
    { id: "dl-ali", account_id: ACCT, contact_id: ALI, title: "Ali's deal" },
    { id: "dl-bala", account_id: ACCT, contact_id: BALA, title: "Bala's deal" },
    { id: "dl-none", account_id: ACCT, contact_id: null, title: "A deal with no contact" },
    { id: "dl-theirs", account_id: OTHER, contact_id: "x", title: "Another workspace" },
  ]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
});

const upload = async () => makePdf([{ ...A4 }]);

describe("decideLinks", () => {
  const t = (id: string, contactId: string | null) => ({ id, contactId });

  it("keeps what it was given when everything agrees, and detaches with null", () => {
    expect(decideLinks({ contactId: ALI, ticket: t("t", ALI), deal: t("d", ALI) })).toEqual({ contactId: ALI, ticketId: "t", dealId: "d" });
    expect(decideLinks({ contactId: ALI, ticket: null, deal: null })).toEqual({ contactId: ALI, ticketId: null, dealId: null });
    expect(decideLinks({ contactId: null, ticket: null, deal: null })).toEqual({ contactId: null, ticketId: null, dealId: null });
  });

  it("takes the record's contact when the document has none, and refuses a record of another contact", () => {
    expect(decideLinks({ contactId: null, ticket: t("t", ALI), deal: null })).toEqual({ contactId: ALI, ticketId: "t", dealId: null });
    expect(decideLinks({ contactId: null, ticket: null, deal: t("d", BALA) })).toEqual({ contactId: BALA, ticketId: null, dealId: "d" });
    expect(() => decideLinks({ contactId: ALI, ticket: t("t", BALA), deal: null })).toThrowError(expect.objectContaining({ code: "ticket_contact_mismatch", status: 400 }));
    expect(() => decideLinks({ contactId: ALI, ticket: null, deal: t("d", BALA) })).toThrowError(expect.objectContaining({ code: "deal_contact_mismatch", status: 400 }));
  });

  it("makes a ticket and a deal named together be about the same contact, and lets a deal with no contact through", () => {
    expect(() => decideLinks({ contactId: null, ticket: t("t", ALI), deal: t("d", BALA) })).toThrowError(expect.objectContaining({ code: "deal_contact_mismatch" }));
    expect(decideLinks({ contactId: null, ticket: t("t", ALI), deal: t("d", null) })).toEqual({ contactId: ALI, ticketId: "t", dealId: "d" });
    expect(decideLinks({ contactId: ALI, ticket: null, deal: t("d", null) })).toEqual({ contactId: ALI, ticketId: null, dealId: "d" });
  });
});

describe("resolveLinks", () => {
  it("finds the ticket and the deal in this workspace", async () => {
    expect(await resolveLinks(ctx, { contactId: null, ticketId: "tk-ali", dealId: "dl-ali" })).toEqual({ contactId: ALI, ticketId: "tk-ali", dealId: "dl-ali" });
    expect(await resolveLinks(ctx, { contactId: ALI })).toEqual({ contactId: ALI, ticketId: null, dealId: null });
  });

  it("refuses a ticket or a deal of another workspace or one that does not exist, as not found", async () => {
    await expect(resolveLinks(ctx, { contactId: null, ticketId: "tk-theirs" })).rejects.toMatchObject({ code: "ticket_not_found", status: 400 });
    await expect(resolveLinks(ctx, { contactId: null, ticketId: "nope" })).rejects.toMatchObject({ code: "ticket_not_found" });
    await expect(resolveLinks(ctx, { contactId: null, dealId: "dl-theirs" })).rejects.toMatchObject({ code: "deal_not_found", status: 400 });
  });
});

describe("a new draft", () => {
  it("is attached to a ticket and takes its contact when none was given", async () => {
    const { document } = await createDraftFromUpload(ctx, { bytes: await upload(), filename: "a.pdf", ticketId: "tk-ali" });
    expect(document).toMatchObject({ ticket_id: "tk-ali", deal_id: null, contact_id: ALI });
  });

  it("is attached to both, for the same contact", async () => {
    const { document } = await createDraftFromUpload(ctx, { bytes: await upload(), filename: "a.pdf", contactId: ALI, ticketId: "tk-ali", dealId: "dl-ali" });
    expect(document).toMatchObject({ ticket_id: "tk-ali", deal_id: "dl-ali", contact_id: ALI });
  });

  it("is refused for a ticket of another workspace, a ticket of another contact and a deal of another contact, and leaves nothing behind", async () => {
    const bytes = await upload();
    await expect(createDraftFromUpload(ctx, { bytes, filename: "a.pdf", ticketId: "tk-theirs" })).rejects.toMatchObject({ code: "ticket_not_found" });
    await expect(createDraftFromUpload(ctx, { bytes, filename: "a.pdf", contactId: ALI, ticketId: "tk-bala" })).rejects.toMatchObject({ code: "ticket_contact_mismatch" });
    await expect(createDraftFromUpload(ctx, { bytes, filename: "a.pdf", contactId: ALI, dealId: "dl-bala" })).rejects.toMatchObject({ code: "deal_contact_mismatch" });
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(db.files.size).toBe(0);
  });

  it("works the same from a template", async () => {
    const pdf = await upload();
    db.files.set(`account-${ACCT}/templates/t/v1.pdf`, pdf);
    db.seed("sign_templates", [{ id: "tpl", account_id: ACCT, name: "Agreement", status: "active", category_id: null, current_version_id: "ver" }]);
    db.seed("sign_template_versions", [{ id: "ver", account_id: ACCT, template_id: "tpl", version_no: 1, source_path: `account-${ACCT}/templates/t/v1.pdf`, source_sha256: "a".repeat(64), page_count: 1, fields: [], roles: [], defaults: {}, form: null }]);
    const doc = await createDraftFromTemplate(ctx, { templateId: "tpl", dealId: "dl-bala" });
    expect(doc).toMatchObject({ deal_id: "dl-bala", contact_id: BALA });
    await expect(createDraftFromTemplate(ctx, { templateId: "tpl", dealId: "dl-theirs" })).rejects.toMatchObject({ code: "deal_not_found" });
  });
});

describe("changing the links of a draft", () => {
  async function draft(over: Record<string, unknown> = {}) {
    const { document } = await createDraftFromUpload(ctx, { bytes: await upload(), filename: "a.pdf", ...over });
    return document.id;
  }
  const row = () => db.rows("sign_documents")[0];

  it("attaches a ticket and a deal to a draft, and detaches them again", async () => {
    const id = await draft({ contactId: ALI });
    await updateDraft(ctx, id, { ticketId: "tk-ali", dealId: "dl-ali" });
    expect(row()).toMatchObject({ ticket_id: "tk-ali", deal_id: "dl-ali", contact_id: ALI });
    await updateDraft(ctx, id, { ticketId: null });
    expect(row()).toMatchObject({ ticket_id: null, deal_id: "dl-ali", contact_id: ALI });
    await updateDraft(ctx, id, { dealId: null });
    expect(row()).toMatchObject({ ticket_id: null, deal_id: null, contact_id: ALI });
  });

  it("refuses a ticket or deal that does not match the contact or the workspace, and keeps what the draft had", async () => {
    const id = await draft({ contactId: ALI, ticketId: "tk-ali" });
    await expect(updateDraft(ctx, id, { ticketId: "tk-bala" })).rejects.toMatchObject({ code: "ticket_contact_mismatch" });
    await expect(updateDraft(ctx, id, { dealId: "dl-theirs" })).rejects.toMatchObject({ code: "deal_not_found" });
    // changing the contact while a ticket of the old contact stays attached is refused too: the screen detaches it first
    await expect(updateDraft(ctx, id, { contactId: BALA })).rejects.toMatchObject({ code: "ticket_contact_mismatch" });
    expect(row()).toMatchObject({ ticket_id: "tk-ali", contact_id: ALI });
    await updateDraft(ctx, id, { contactId: BALA, ticketId: null });
    expect(row()).toMatchObject({ ticket_id: null, contact_id: BALA });
  });

  it("leaves the links alone when the patch does not name them", async () => {
    const id = await draft({ ticketId: "tk-ali" });
    await updateDraft(ctx, id, { title: "Renamed" });
    expect(row()).toMatchObject({ title: "Renamed", ticket_id: "tk-ali", contact_id: ALI });
  });

  it("is not possible once the document was sent", async () => {
    const id = await draft();
    row().status = "sent";
    await expect(updateDraft(ctx, id, { ticketId: "tk-ali" })).rejects.toMatchObject({ code: "document_not_draft" });
  });
});

describe("what the database says when it refuses", () => {
  it("is turned into the same stable codes the screens word", () => {
    expect(fromDatabaseError({ message: "sign_document_ticket_not_in_workspace" })).toMatchObject({ code: "link_not_found", status: 400 });
    expect(fromDatabaseError({ message: "sign_document_deal_not_in_workspace" })).toMatchObject({ code: "link_not_found", status: 400 });
    expect(fromDatabaseError({ message: "sign_document_test_is_fixed" })).toMatchObject({ code: "test_is_fixed", status: 409 });
  });
});
