// Private documents (migration 176), the service layer's half of the rule. The database holds the same rule with row level security (proved by
// supabase/ci/verify-176); every service here reads with the service role, which no policy applies to, so each read a person or a key can reach
// through the server has to ask the question itself (service/privacy.ts). This file proves it for every way into a document the staff screens, the
// public API and the exports have, over the in-memory database.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { documentsCsvStream, planZip } from "./export";
import { listDocumentsForApi, loadBundle, fileForApi, remindForApi, voidForApi } from "./api";
import { listNeedsAttention, openCountersign } from "./countersign";
import { loadDocument } from "./context";
import { addCopyRecipient, listCopyRecipients, removeCopyRecipient, setCopyRecipients } from "./copy-recipients";
import { setDocumentPeople } from "./document-people";
import { createDraftFromTemplate, createDraftFromUpload, deleteDocument, deleteDraft, setSigners, updateDraft } from "./drafts";
import { loadEnvelope, loadEnvelopeDocuments } from "./envelope-data";
import { addEnvelopeDocuments, removeEnvelopeDocument, reorderEnvelopeDocuments } from "./envelope-documents";
import {
  changeEnvelopeRecipient,
  createEnvelopeDraft,
  deleteEnvelope,
  envelopeBrief,
  envelopeData,
  extendEnvelopeExpiry,
  remindEnvelopePerson,
  resendEnvelopePerson,
  sendEnvelope,
  setEnvelopeSigners,
  updateEnvelope,
  voidEnvelope,
} from "./envelopes";
import { setForwarding } from "./forward";
import { ACCT, ALI_KEY, OTHER_USER, USER, TPL_A, makeWorld, signerIn, type World } from "./people-world";
import { assertMayChangePrivacy, callerOf, canSeeDocument, canSeeEnvelope, documentListScope, parsePrivate, visibleDocuments } from "./privacy";
import { extendExpiry, loadProgress, uploadedFileForStaff } from "./progress";
import { replaceDraftFile } from "./replace-file";
import { revealAnswer } from "./sensitive-staff";
import { changeRecipient, moveSigner, remindSigner, resendSigner, sendDocument, voidDocument } from "./send";
import { createTemplateFromDocument } from "./templates";
import type { SignCtx } from "./context";
import type { SignDocumentRow, SignEnvelopeRow } from "../types";

const ADMIN_U = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_U = "aaaaaaaa-0000-4000-8000-000000000002";
const NAMED_U = "aaaaaaaa-0000-4000-8000-000000000003";
const STAFF_U = "aaaaaaaa-0000-4000-8000-000000000004";
const KEY_ID = "key-1";

let w: World;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  w = await makeWorld();
  w.db.seed("profiles", [
    { user_id: ADMIN_U, account_id: ACCT, account_role: "admin", full_name: "Admin", email: "admin@vircle.example" },
    { user_id: OWNER_U, account_id: ACCT, account_role: "owner", full_name: "Owner", email: "owner@vircle.example" },
    { user_id: NAMED_U, account_id: ACCT, account_role: "agent", full_name: "Named", email: "named@vircle.example" },
    { user_id: STAFF_U, account_id: ACCT, account_role: "agent", full_name: "Staff", email: "staff@vircle.example" },
  ]);
  // USER (the uploader) is an agent of the workspace
  w.db.rows("profiles").find((p) => p.user_id === USER)!.account_role = "agent";
});

/** A context for a person at a screen, for a key (userId is whoever made it) or for the system. */
const as = (userId: string | null, via?: string): SignCtx => ({ ...w.ctx, userId, ...(via ? { via } : {}) });
const uploader = () => as(USER);
const admin = () => as(ADMIN_U);
const owner = () => as(OWNER_U);
const named = () => as(NAMED_U);
const staff = () => as(STAFF_U);
const key = (madeBy: string | null = ADMIN_U) => as(madeBy, `api_key:${KEY_ID}`);
const system = () => as(null);

const privateDoc = async (title = "Secret"): Promise<SignDocumentRow> => (await createDraftFromUpload(uploader(), { bytes: w.pdf, filename: `${title}.pdf`, isPrivate: true })).document;
const publicDoc = async (title = "Open"): Promise<SignDocumentRow> => (await createDraftFromUpload(uploader(), { bytes: w.pdf, filename: `${title}.pdf` })).document;
const nameNamedSigner = (documentId: string, userId = NAMED_U) =>
  w.db.seed("sign_signers", [{ id: `named-${documentId}-${userId}`, account_id: ACCT, document_id: documentId, role_key: "director", kind: "signer", full_name: "Named", email: "named@vircle.example", channel: "email", order_no: 1, status: "pending", internal_user_id: userId }]);

const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; status?: number; message?: string });
  return err ? { code: err.code, status: err.status } : null;
};
const NOT_FOUND = { code: "document_not_found", status: 404 };
const ENV_NOT_FOUND = { code: "envelope_not_found", status: 404 };

describe("who is who", () => {
  it("tells a person, a key and the system apart by the context", () => {
    expect(callerOf(as(USER))).toEqual({ kind: "person", userId: USER });
    expect(callerOf(as(USER, "bulk:job"))).toEqual({ kind: "person", userId: USER });
    expect(callerOf(key())).toEqual({ kind: "api" });
    expect(callerOf(key(null))).toEqual({ kind: "api" });
    expect(callerOf(system())).toEqual({ kind: "system" });
  });

  it("reads the choice from a request: a boolean, the words true and false, nothing, and refuses anything else", () => {
    expect(parsePrivate(true)).toBe(true);
    expect(parsePrivate("true")).toBe(true);
    expect(parsePrivate(false)).toBe(false);
    expect(parsePrivate("false")).toBe(false);
    for (const nothing of [undefined, null, ""]) expect(parsePrivate(nothing)).toBeUndefined();
    for (const bad of ["yes", 1, "1", {}, []]) expect(() => parsePrivate(bad)).toThrowError(expect.objectContaining({ code: "bad_private", status: 400 }));
  });
});

describe("making a document private", () => {
  it("is private only when asked: a document made without the choice (an automation, bulk send, a registration form) is not", async () => {
    expect((await privateDoc()).is_private).toBe(true);
    expect((await publicDoc()).is_private ?? false).toBe(false);
    const fromTemplate = await createDraftFromTemplate(uploader(), { templateId: TPL_A, isPrivate: true });
    expect(fromTemplate.is_private).toBe(true);
    expect((await createDraftFromTemplate(uploader(), { templateId: TPL_A })).is_private ?? false).toBe(false);
    expect((await createDraftFromTemplate(system(), { templateId: TPL_A })).is_private ?? false).toBe(false);
  });

  it("is chosen again on a draft by its uploader or an admin, and by nobody else", async () => {
    const d = await publicDoc();
    // another agent sees the document (it is not private) but may not make it private
    expect(await refusal(updateDraft(staff(), d.id, { isPrivate: true }))).toEqual({ code: "private_not_allowed", status: 403 });
    expect(await refusal(updateDraft(key(), d.id, { isPrivate: true }))).toEqual({ code: "private_not_allowed", status: 403 });
    expect((await updateDraft(uploader(), d.id, { isPrivate: true })).is_private).toBe(true);
    // now it is private: the other agent is told it is not there, which is the answer they get for anything private
    expect(await refusal(updateDraft(staff(), d.id, { isPrivate: false }))).toEqual(NOT_FOUND);
    expect((await updateDraft(admin(), d.id, { isPrivate: false })).is_private).toBe(false);
    expect((await updateDraft(owner(), d.id, { isPrivate: true })).is_private).toBe(true);
    // nothing is written for a choice that is already the document's
    const before = w.db.rows("sign_documents").find((x) => x.id === d.id)!.updated_at;
    await updateDraft(uploader(), d.id, { isPrivate: true });
    expect(w.db.rows("sign_documents").find((x) => x.id === d.id)!.updated_at).toBe(before);
    // the system (a job with no person) may; the choice must be a boolean
    expect((await updateDraft(system(), d.id, { isPrivate: false })).is_private).toBe(false);
    expect(await refusal(updateDraft(uploader(), d.id, { isPrivate: "yes" as unknown as boolean }))).toEqual({ code: "bad_private", status: 400 });
  });

  it("is fixed once the document is sent", async () => {
    const d = await privateDoc();
    w.db.rows("sign_documents").find((x) => x.id === d.id)!.status = "sent";
    expect(await refusal(updateDraft(uploader(), d.id, { isPrivate: false }))).toEqual({ code: "document_not_draft", status: 409 });
  });

  it("says who may change it: the uploader, an admin or the owner, never a key", async () => {
    const row = { created_by: USER };
    await expect(assertMayChangePrivacy(uploader(), row)).resolves.toBeUndefined();
    await expect(assertMayChangePrivacy(admin(), row)).resolves.toBeUndefined();
    await expect(assertMayChangePrivacy(owner(), row)).resolves.toBeUndefined();
    await expect(assertMayChangePrivacy(system(), row)).resolves.toBeUndefined();
    await expect(assertMayChangePrivacy(staff(), row)).rejects.toMatchObject({ code: "private_not_allowed", status: 403 });
    await expect(assertMayChangePrivacy(named(), row)).rejects.toMatchObject({ code: "private_not_allowed" });
    await expect(assertMayChangePrivacy(key(ADMIN_U), row)).rejects.toMatchObject({ code: "private_not_allowed" });
  });
});

describe("who sees a private document", () => {
  it("is its uploader, an admin, the owner, a Halo user named as a signer on it, and the system", async () => {
    const d = await privateDoc();
    nameNamedSigner(d.id);
    for (const [who, ctx] of [["uploader", uploader()], ["admin", admin()], ["owner", owner()], ["named signer", named()], ["system", system()]] as const) {
      expect((await loadDocument(ctx, d.id)).id, who).toBe(d.id);
      expect(await canSeeDocument(ctx, d), who).toBe(true);
    }
  });

  it("is not another agent, not a key (even one an admin made), not another workspace's person", async () => {
    const d = await privateDoc();
    nameNamedSigner(d.id);
    for (const [who, ctx] of [["another agent", staff()], ["a key made by an admin", key(ADMIN_U)], ["a key made by the uploader", key(USER)], ["a key whose maker was removed", key(null)], ["another workspace's person", as(OTHER_USER)]] as const) {
      expect(await refusal(loadDocument(ctx, d.id)), who).toEqual(NOT_FOUND);
      expect(await canSeeDocument(ctx, d), who).toBe(false);
    }
  });

  it("answers a person who may not see it exactly as it answers for a document that is not there", async () => {
    const d = await privateDoc();
    const hidden = await loadDocument(staff(), d.id).catch((e) => e);
    const missing = await loadDocument(staff(), "00000000-0000-4000-8000-000000000000").catch((e) => e);
    expect({ code: hidden.code, status: hidden.status, message: hidden.message }).toEqual({ code: missing.code, status: missing.status, message: missing.message });
  });

  it("is seen as before by everyone when it is not private", async () => {
    const d = await publicDoc();
    for (const ctx of [uploader(), admin(), staff(), named(), key(), system()]) expect((await loadDocument(ctx, d.id)).id).toBe(d.id);
  });

  it("is judged from the database each time the document is read: naming a signer opens it, removing them closes it", async () => {
    const d = await privateDoc();
    expect(await refusal(loadDocument(named(), d.id))).toEqual(NOT_FOUND);
    nameNamedSigner(d.id);
    expect((await loadDocument(named(), d.id)).id).toBe(d.id);
    w.db.tables.sign_signers = [];
    expect(await refusal(loadDocument(named(), d.id))).toEqual(NOT_FOUND);
    // a signer who is not a Halo user (no internal_user_id) opens nothing
    w.db.seed("sign_signers", [{ id: "outside", account_id: ACCT, document_id: d.id, role_key: "merchant", kind: "signer", full_name: "Ali", email: "ali@kedai.example", channel: "email", order_no: 1, status: "pending", internal_user_id: null }]);
    expect(await refusal(loadDocument(staff(), d.id))).toEqual(NOT_FOUND);
  });
});

describe("every way into a private document is closed to whoever may not see it", () => {
  // each entry reads or changes one document through a service the screens, the routes or the API use; the first thing every one does is load the document
  const doc = (d: SignDocumentRow) => d.id;
  const ways: [string, (ctx: SignCtx, d: SignDocumentRow) => Promise<unknown>][] = [
    ["the document", (c, d) => loadDocument(c, doc(d))],
    ["the document with its people (API)", (c, d) => loadBundle(c, doc(d))],
    ["change a draft", (c, d) => updateDraft(c, doc(d), { title: "Changed" })],
    ["change the signers", (c, d) => setSigners(c, doc(d), [{ roleKey: "signer", kind: "signer", fullName: "A", email: "a@x.example", channel: "email", orderNo: 1 }])],
    ["change the people", (c, d) => setDocumentPeople(c, doc(d), [signerIn("Ali", "ali@kedai.example", ALI_KEY)])],
    ["send", (c, d) => sendDocument(c, doc(d))],
    ["void", (c, d) => voidDocument(c, doc(d), "no")],
    ["void (API)", (c, d) => voidForApi(c, doc(d), "no")],
    ["remind (API)", (c, d) => remindForApi(c, doc(d), null)],
    ["delete", (c, d) => deleteDocument(c, doc(d))],
    ["delete a draft", (c, d) => deleteDraft(c, doc(d))],
    ["extend the expiry", (c, d) => extendExpiry(c, doc(d), "2027-01-01T00:00:00Z")],
    ["the form's progress", (c, d) => loadProgress(c, doc(d))],
    ["a file the signer uploaded", (c, d) => uploadedFileForStaff(c, doc(d), "f1")],
    ["a file of the document (API)", (c, d) => fileForApi(c, doc(d), "original")],
    ["reveal a sensitive answer", (c, d) => revealAnswer(c, doc(d), "icNumber")],
    ["add a person who receives a copy", (c, d) => addCopyRecipient(c, { documentId: doc(d) }, { fullName: "C", email: "c@x.example" })],
    ["remove a person who receives a copy", (c, d) => removeCopyRecipient(c, { documentId: doc(d) }, "nobody")],
    ["set the people who receive a copy", (c, d) => setCopyRecipients(c, { documentId: doc(d) }, [{ fullName: "C", email: "c@x.example" }])],
    ["forwarding", (c, d) => setForwarding(c, doc(d), true)],
    ["replace the file", (c, d) => replaceDraftFile(c, doc(d), { bytes: w.pdf, filename: "x.pdf" })],
    ["make a template of it", (c, d) => createTemplateFromDocument(c, doc(d), { name: "T" })],
    ["resend to a person", (c, d) => resendSigner(c, doc(d), "s1")],
    ["remind a person", (c, d) => remindSigner(c, doc(d), "s1")],
    ["change a person", (c, d) => changeRecipient(c, doc(d), "s1", { fullName: "X", email: "x@y.example" })],
    ["move a person", (c, d) => moveSigner(c, doc(d), "s1", 1)],
  ];

  // a fresh document for every call: some of these delete or void the document they are given
  const fresh = async (isPrivate: boolean) => {
    const d = isPrivate ? await privateDoc() : await publicDoc();
    nameNamedSigner(d.id);
    return d;
  };

  // (a file that is not there and a file of a document that is not the caller's are the same answer: "file not found")
  const goneAnswer = (name: string) => (name === "a file the signer uploaded" ? { code: "file_not_found", status: 404 } : NOT_FOUND);

  it("the people who receive a copy: none, for a person who may not see the document (the same list as for a document that is not there), the list for those who may", async () => {
    const d = await fresh(true);
    await setCopyRecipients(uploader(), { documentId: d.id }, [{ fullName: "Siti", email: "siti@copy.example" }]);
    expect(await listCopyRecipients(staff(), { documentId: d.id })).toEqual([]);
    expect(await listCopyRecipients(key(ADMIN_U), { documentId: d.id })).toEqual([]);
    expect((await listCopyRecipients(uploader(), { documentId: d.id })).map((c) => c.email)).toEqual(["siti@copy.example"]);
    expect((await listCopyRecipients(admin(), { documentId: d.id })).map((c) => c.email)).toEqual(["siti@copy.example"]);
    expect((await listCopyRecipients(named(), { documentId: d.id })).map((c) => c.email)).toEqual(["siti@copy.example"]);
    expect((await listCopyRecipients(system(), { documentId: d.id })).map((c) => c.email)).toEqual(["siti@copy.example"]);
  });

  for (const [name, call] of ways) {
    it(`${name}: not found for another agent and for a key; never "not found" for the uploader, an admin and the owner`, async () => {
      expect(await refusal(call(staff(), await fresh(true))), "another agent").toEqual(goneAnswer(name));
      expect(await refusal(call(key(ADMIN_U), await fresh(true))), "a key").toEqual(goneAnswer(name));
      for (const [who, ctx] of [["uploader", uploader()], ["admin", admin()], ["owner", owner()]] as const) {
        const r = await refusal(call(ctx, await fresh(true)));
        expect(r?.code, who).not.toBe("document_not_found");
      }
    });

    it(`${name}: the same call is not refused as "not found" when the document is not private (so the rule is proved, not a broken call)`, async () => {
      const r = await refusal(call(staff(), await fresh(false)));
      // (a file that does not exist is "file not found" even when the document is open: the uploaded file here is made up)
      expect(r?.code).not.toBe("document_not_found");
    });
  }

  it("countersign in Halo: a person who is not a signer gets the same 403 for a private document, a public one and one that is not there; a named signer is let through", async () => {
    const secret = await fresh(true);
    const open = await fresh(false);
    const answer = async (ctx: SignCtx, id: string) => refusal(openCountersign(ctx, id, { ip: null, device: null }));
    const expected = { code: "not_a_signer", status: 403 };
    expect(await answer(staff(), secret.id)).toEqual(expected);
    expect(await answer(staff(), open.id)).toEqual(expected);
    expect(await answer(staff(), "00000000-0000-4000-8000-000000000000")).toEqual(expected);
    // the named signer is a signer: what stops them is what always stops a signer (here the place is addressed to someone else), never "not found"
    expect((await answer(named(), secret.id))?.code).not.toBe("document_not_found");
    expect(await answer(uploader(), secret.id)).toEqual(expected);
  });
});

describe("a Halo user named on a private draft reads it and does not edit it", () => {
  const DENIED = { code: "private_not_allowed", status: 403 };

  it("refuses a document: changing it, its signers, its people, its file, sending it, deleting it, its copy recipients", async () => {
    const d = await privateDoc();
    nameNamedSigner(d.id);
    expect((await loadDocument(named(), d.id)).id).toBe(d.id);
    expect(await refusal(updateDraft(named(), d.id, { title: "Changed" }))).toEqual(DENIED);
    expect(await refusal(setSigners(named(), d.id, []))).toEqual(DENIED);
    expect(await refusal(setDocumentPeople(named(), d.id, []))).toEqual(DENIED);
    expect(await refusal(replaceDraftFile(named(), d.id, { bytes: w.pdf, filename: "x.pdf" }))).toEqual(DENIED);
    expect(await refusal(sendDocument(named(), d.id))).toEqual(DENIED);
    expect(await refusal(deleteDraft(named(), d.id))).toEqual(DENIED);
    expect(await refusal(deleteDocument(named(), d.id))).toEqual(DENIED);
    expect(await refusal(addCopyRecipient(named(), { documentId: d.id }, { fullName: "C", email: "c@x.example" }))).toEqual(DENIED);
    expect(await refusal(setCopyRecipients(named(), { documentId: d.id }, [{ fullName: "C", email: "c@x.example" }]))).toEqual(DENIED);
    // reading the copy recipients is reading
    await expect(listCopyRecipients(named(), { documentId: d.id })).resolves.toEqual([]);
    // nothing was changed or removed
    expect(w.docRows().find((x) => x.id === d.id)?.title).toBe("Secret");
    // the uploader and an admin change it as always
    expect((await updateDraft(uploader(), d.id, { title: "By the uploader" })).title).toBe("By the uploader");
    expect((await updateDraft(admin(), d.id, { title: "By an admin" })).title).toBe("By an admin");
  });

  it("refuses a collection: changing it, its people, its documents, sending it, deleting it, and does not leave it half deleted", async () => {
    const files = [w.file("One.pdf"), w.file("Two.pdf")];
    const { envelope, documents } = await createEnvelopeDraft(uploader(), { templateIds: [], files, isPrivate: true });
    nameNamedSigner(documents[0].id);
    expect((await loadEnvelope(named(), envelope.id)).id).toBe(envelope.id);
    expect(await refusal(updateEnvelope(named(), envelope.id, { title: "Changed" }))).toEqual(DENIED);
    expect(await refusal(setEnvelopeSigners(named(), envelope.id, []))).toEqual(DENIED);
    expect(await refusal(addEnvelopeDocuments(named(), envelope.id, { files: [w.file("Three.pdf")] }))).toEqual(DENIED);
    expect(await refusal(removeEnvelopeDocument(named(), envelope.id, documents[0].id))).toEqual(DENIED);
    expect(await refusal(reorderEnvelopeDocuments(named(), envelope.id, [documents[1].id, documents[0].id]))).toEqual(DENIED);
    expect(await refusal(sendEnvelope(named(), envelope.id))).toEqual(DENIED);
    expect(await refusal(deleteEnvelope(named(), envelope.id))).toEqual(DENIED);
    expect(await refusal(addCopyRecipient(named(), { envelopeId: envelope.id }, { fullName: "C", email: "c@x.example" }))).toEqual(DENIED);
    // every document is still there
    expect(w.docRows().filter((d) => d.envelope_id === envelope.id)).toHaveLength(2);
    expect(w.db.rows("sign_envelopes").some((e) => e.id === envelope.id)).toBe(true);
  });

  it("is not held to this once it is sent: the rule is about drafts", async () => {
    const d = await privateDoc();
    nameNamedSigner(d.id);
    w.db.rows("sign_documents").find((x) => x.id === d.id)!.status = "sent";
    // (it is "not a draft", which is what changing a sent document always answers; not the draft rule)
    expect(await refusal(updateDraft(named(), d.id, { title: "x" }))).toEqual({ code: "document_not_draft", status: 409 });
  });
});

describe("lists the server builds", () => {
  const seedStopped = (id: string, over: Record<string, unknown>) =>
    w.db.seed("sign_documents", [{ id, account_id: ACCT, reference: `SGN-${id}`, title: `Doc ${id}`, status: "declined", test: false, created_by: USER, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", ...over }]);

  const OPEN = "dddddddd-0000-4000-8000-000000000001";
  const SECRET = "dddddddd-0000-4000-8000-000000000002";
  const SECRET_NAMED = "dddddddd-0000-4000-8000-000000000003";
  const SECRET_OTHER = "dddddddd-0000-4000-8000-000000000004";

  it("narrows what the workspace's documents are to what the caller may see: everyone, a person, a key", async () => {
    seedStopped(OPEN, {});
    seedStopped(SECRET, { is_private: true });
    seedStopped(SECRET_NAMED, { is_private: true, created_by: ADMIN_U });
    nameNamedSigner(SECRET_NAMED);
    const idsFor = async (ctx: SignCtx) => {
      const scope = await documentListScope(ctx);
      const { data } = await scope.apply(ctx.admin.from("sign_documents").select("id").eq("account_id", ACCT));
      return { unrestricted: scope.unrestricted, ids: ((data ?? []) as { id: string }[]).map((r) => r.id).sort() };
    };
    const all = [OPEN, SECRET, SECRET_NAMED].sort();
    expect(await idsFor(system())).toEqual({ unrestricted: true, ids: all });
    expect(await idsFor(admin())).toEqual({ unrestricted: true, ids: all });
    expect(await idsFor(owner())).toEqual({ unrestricted: true, ids: all });
    expect(await idsFor(uploader())).toEqual({ unrestricted: false, ids: [OPEN, SECRET].sort() });
    expect(await idsFor(named())).toEqual({ unrestricted: false, ids: [OPEN, SECRET_NAMED].sort() });
    expect(await idsFor(staff())).toEqual({ unrestricted: false, ids: [OPEN] });
    expect(await idsFor(key(ADMIN_U))).toEqual({ unrestricted: false, ids: [OPEN] });
  });

  it("filters rows already read the same way, with one question about who is named however many rows there are", async () => {
    const rows = [
      { id: OPEN, is_private: false, created_by: USER },
      { id: SECRET, is_private: true, created_by: USER },
      { id: SECRET_NAMED, is_private: true, created_by: ADMIN_U },
      { id: SECRET_OTHER, is_private: true, created_by: ADMIN_U },
    ];
    nameNamedSigner(SECRET_NAMED);
    const ids = async (ctx: SignCtx) => (await visibleDocuments(ctx, rows)).map((r) => r.id);
    expect(await ids(system())).toEqual([OPEN, SECRET, SECRET_NAMED, SECRET_OTHER]);
    expect(await ids(admin())).toEqual([OPEN, SECRET, SECRET_NAMED, SECRET_OTHER]);
    expect(await ids(uploader())).toEqual([OPEN, SECRET]);
    expect(await ids(named())).toEqual([OPEN, SECRET_NAMED]);
    expect(await ids(staff())).toEqual([OPEN]);
    expect(await ids(key(ADMIN_U))).toEqual([OPEN]);
    expect(await visibleDocuments(staff(), [])).toEqual([]);
  });

  it("leaves a private document off what needs attention for anyone who may not see it", async () => {
    seedStopped(OPEN, { status: "declined" });
    seedStopped(SECRET, { status: "expired", is_private: true });
    seedStopped(SECRET_NAMED, { status: "failed", is_private: true, created_by: ADMIN_U });
    nameNamedSigner(SECRET_NAMED);
    const titles = async (ctx: SignCtx) => (await listNeedsAttention(ctx)).map((i) => i.documentId).sort();
    expect(await titles(admin())).toEqual([OPEN, SECRET, SECRET_NAMED].sort());
    expect(await titles(uploader())).toEqual([OPEN, SECRET].sort());
    expect(await titles(named())).toEqual([OPEN, SECRET_NAMED].sort());
    expect(await titles(staff())).toEqual([OPEN]);
  });

  it("leaves a private document out of the CSV for anyone who may not see it", async () => {
    seedStopped("open", { status: "completed", title: "Open agreement", category_id: null });
    seedStopped("secret", { status: "completed", title: "Secret agreement", is_private: true });
    const none = { group: "all" as const, category: "all", search: "", from: null, to: null, contactId: null };
    const text = async (ctx: SignCtx) => new Response(documentsCsvStream(ctx, none)).text();
    const admins = await text(admin());
    expect(admins).toContain("Open agreement");
    expect(admins).toContain("Secret agreement");
    expect(await text(uploader())).toContain("Secret agreement");
    const others = await text(staff());
    expect(others).toContain("Open agreement");
    expect(others).not.toContain("Secret agreement");
    expect(await text(key(ADMIN_U))).not.toContain("Secret agreement");
  });

  it("leaves a private document out of the zip for anyone who may not see it, as if it was not there", async () => {
    for (const id of ["open", "secret"]) {
      const path = `account-${ACCT}/${id}/final/${id}.pdf`;
      seedStopped(id, { status: "completed", final_path: path, is_private: id === "secret" });
      w.db.files.set(path, new Uint8Array([1, 2, 3, 4]));
    }
    expect((await planZip(admin(), ["open", "secret"])).included.map((d) => d.id)).toEqual(["open", "secret"]);
    expect((await planZip(uploader(), ["open", "secret"])).included.map((d) => d.id)).toEqual(["open", "secret"]);
    const plan = await planZip(staff(), ["open", "secret"]);
    expect(plan.included.map((d) => d.id)).toEqual(["open"]);
    expect(plan.skipped).toEqual([{ id: "secret", reference: null, reason: "not_found" }]);
    // what the plan carries never includes the fields it read to decide
    expect("is_private" in plan.included[0] || "created_by" in plan.included[0]).toBe(false);
    // asking only for the private one: nothing to download, and nothing said about it beyond "not found"
    await expect(planZip(staff(), ["secret"])).rejects.toMatchObject({ code: "nothing_to_download", status: 409, issues: [{ code: "not_found", detail: "secret" }] });
  });

  it("never gives a key a private document: not in the API's list, not by id, not by reference", async () => {
    seedStopped("open", { status: "sent", mode: "sign", locale: "en", sign_in_order: false, code_required: false, page_count: 1, final_sha256: null, void_reason: null, envelope_id: null });
    seedStopped("secret", { status: "sent", mode: "sign", locale: "en", sign_in_order: false, code_required: false, page_count: 1, final_sha256: null, void_reason: null, envelope_id: null, is_private: true });
    const page = await listDocumentsForApi(key(ADMIN_U), { status: null, contactId: null, templateId: null, reference: null, createdAfter: null }, { limit: 50, cursor: null });
    expect(page.documents.map((d) => d.id)).toEqual(["open"]);
    expect(await refusal(loadBundle(key(ADMIN_U), "secret"))).toEqual(NOT_FOUND);
    // the same documents, as a person who may see them reads them (the API's own list is the key's)
    const byReference = await listDocumentsForApi(key(ADMIN_U), { status: null, contactId: null, templateId: null, reference: "SGN-secret", createdAfter: null }, { limit: 50, cursor: null });
    expect(byReference.documents).toEqual([]);
  });
});

describe("a private document collection", () => {
  const twoFiles = (ctx: SignCtx, isPrivate: boolean) => {
    const files = [w.file("One.pdf"), w.file("Two.pdf")];
    return createEnvelopeDraft(ctx, { templateIds: [], files, isPrivate });
  };

  it("is private with every document in it, and only on request", async () => {
    const { envelope, documents } = await twoFiles(uploader(), true);
    expect(envelope.is_private).toBe(true);
    expect(documents.every((d) => d.is_private === true)).toBe(true);
    const open = await twoFiles(uploader(), false);
    expect(open.envelope.is_private ?? false).toBe(false);
    expect(open.documents.every((d) => !d.is_private)).toBe(true);
  });

  it("is seen by its uploader, an admin, the owner, a Halo user named on it and the system, and not by another agent or a key", async () => {
    const { envelope, documents } = await twoFiles(uploader(), true);
    nameNamedSigner(documents[1].id);
    for (const [who, ctx] of [["uploader", uploader()], ["admin", admin()], ["owner", owner()], ["named", named()], ["system", system()]] as const) {
      expect((await loadEnvelope(ctx, envelope.id)).id, who).toBe(envelope.id);
      expect(await canSeeEnvelope(ctx, envelope), who).toBe(true);
    }
    for (const [who, ctx] of [["another agent", staff()], ["a key", key(ADMIN_U)], ["another workspace", as(OTHER_USER)]] as const) {
      expect(await refusal(loadEnvelope(ctx, envelope.id)), who).toEqual(ENV_NOT_FOUND);
      expect(await canSeeEnvelope(ctx, envelope), who).toBe(false);
    }
  });

  it("is one thing: named on one document of it, a Halo user sees every document of it (in a load, a list and a zip), and being named on another collection opens nothing here", async () => {
    const pack = await twoFiles(uploader(), true);
    const other = await twoFiles(uploader(), true);
    nameNamedSigner(pack.documents[0].id);
    for (const d of pack.documents) expect((await loadDocument(named(), d.id)).id).toBe(d.id);
    for (const d of other.documents) expect(await refusal(loadDocument(named(), d.id))).toEqual(NOT_FOUND);
    expect(await refusal(loadEnvelope(named(), other.envelope.id))).toEqual(ENV_NOT_FOUND);
    // a list
    const scope = await documentListScope(named());
    const { data } = await scope.apply(w.ctx.admin.from("sign_documents").select("id").eq("account_id", ACCT));
    expect(((data ?? []) as { id: string }[]).map((r) => r.id).sort()).toEqual(pack.documents.map((d) => d.id).sort());
    // rows already read
    const rows = [...pack.documents, ...other.documents].map((d) => ({ id: d.id, is_private: d.is_private, created_by: d.created_by, envelope_id: d.envelope_id }));
    expect((await visibleDocuments(named(), rows)).map((r) => r.id).sort()).toEqual(pack.documents.map((d) => d.id).sort());
    expect(await visibleDocuments(staff(), rows)).toEqual([]);
  });

  it("the people who receive a copy of a collection: none for a person who may not see it, the list for those who may", async () => {
    const pack = await twoFiles(uploader(), true);
    await setCopyRecipients(uploader(), { envelopeId: pack.envelope.id }, [{ fullName: "Siti", email: "siti@copy.example" }]);
    nameNamedSigner(pack.documents[0].id);
    expect(await listCopyRecipients(staff(), { envelopeId: pack.envelope.id })).toEqual([]);
    expect(await listCopyRecipients(key(ADMIN_U), { envelopeId: pack.envelope.id })).toEqual([]);
    for (const ctx of [uploader(), admin(), named(), system()]) expect((await listCopyRecipients(ctx, { envelopeId: pack.envelope.id })).map((c) => c.email)).toEqual(["siti@copy.example"]);
  });

  type Pack = Awaited<ReturnType<typeof twoFiles>>;
  const ways: [string, (c: SignCtx, p: Pack) => Promise<unknown>][] = [
    ["the collection", (c, p) => envelopeData(c, p.envelope.id)],
    ["the collection's brief", (c, p) => envelopeBrief(c, p.envelope.id)],
    ["change it", (c, p) => updateEnvelope(c, p.envelope.id, { title: "Changed" })],
    ["change the people", (c, p) => setEnvelopeSigners(c, p.envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)])],
    ["send it", (c, p) => sendEnvelope(c, p.envelope.id)],
    ["void it", (c, p) => voidEnvelope(c, p.envelope.id, "no")],
    ["delete it", (c, p) => deleteEnvelope(c, p.envelope.id)],
    ["extend its expiry", (c, p) => extendEnvelopeExpiry(c, p.envelope.id, "2027-01-01T00:00:00Z")],
    ["resend to a person", (c, p) => resendEnvelopePerson(c, p.envelope.id, "p1")],
    ["remind a person", (c, p) => remindEnvelopePerson(c, p.envelope.id, "p1")],
    ["change a person", (c, p) => changeEnvelopeRecipient(c, p.envelope.id, "p1", { fullName: "X", email: "x@y.example" })],
    ["add documents", (c, p) => addEnvelopeDocuments(c, p.envelope.id, { files: [w.file("Three.pdf")] })],
    ["remove a document", (c, p) => removeEnvelopeDocument(c, p.envelope.id, p.documents[0].id)],
    ["reorder the documents", (c, p) => reorderEnvelopeDocuments(c, p.envelope.id, [p.documents[1].id, p.documents[0].id])],
    ["add a person who receives a copy", (c, p) => addCopyRecipient(c, { envelopeId: p.envelope.id }, { fullName: "C", email: "c@x.example" })],
    ["a document of it", (c, p) => loadDocument(c, p.documents[0].id)],
    ["the brief on one of its documents", (c, p) => envelopeBrief(c, p.documents[0].envelope_id)],
  ];
  const GONE = ["envelope_not_found", "document_not_found"];

  for (const [name, call] of ways) {
    it(`${name}: not found for another agent and for a key; never "not found" for the uploader, an admin, the owner and a named signer`, async () => {
      const r = await refusal(call(staff(), await twoFiles(uploader(), true)));
      expect(r?.status).toBe(404);
      expect(GONE).toContain(r?.code);
      expect(await refusal(call(key(ADMIN_U), await twoFiles(uploader(), true)))).toMatchObject({ status: 404 });
      for (const [who, ctx] of [["uploader", uploader()], ["admin", admin()], ["owner", owner()]] as const) {
        const answer = await refusal(call(ctx, await twoFiles(uploader(), true)));
        expect(GONE, who).not.toContain(answer?.code);
      }
      // a Halo user named on a document of the collection is let in as well
      const pack = await twoFiles(uploader(), true);
      nameNamedSigner(pack.documents[0].id);
      expect(GONE).not.toContain((await refusal(call(named(), pack)))?.code);
    });
  }

  it("moves its choice onto every document of it, by its uploader or an admin, and by nobody else", async () => {
    const { envelope } = await twoFiles(uploader(), false);
    const docsOf = () => w.docRows().filter((d) => d.envelope_id === envelope.id);
    // another agent sees the (public) collection and may not make it private
    expect(await refusal(updateEnvelope(staff(), envelope.id, { isPrivate: true }))).toEqual({ code: "private_not_allowed", status: 403 });
    expect(await refusal(updateEnvelope(key(), envelope.id, { isPrivate: true }))).toEqual({ code: "private_not_allowed", status: 403 });
    expect((await updateEnvelope(uploader(), envelope.id, { isPrivate: true })).is_private).toBe(true);
    expect(docsOf().every((d) => d.is_private === true)).toBe(true);
    expect(await refusal(updateEnvelope(staff(), envelope.id, { isPrivate: false }))).toEqual(ENV_NOT_FOUND);
    expect((await updateEnvelope(admin(), envelope.id, { isPrivate: false })).is_private).toBe(false);
    expect(docsOf().every((d) => !d.is_private)).toBe(true);
    expect(await refusal(updateEnvelope(uploader(), envelope.id, { isPrivate: "yes" as unknown as boolean }))).toEqual({ code: "bad_private", status: 400 });
    // a document of the collection takes its choice from the collection: it is changed on the collection, not on the document
    expect(await refusal(updateDraft(uploader(), docsOf()[0].id, { isPrivate: true }))).toEqual({ code: "document_in_envelope", status: 409 });
  });

  it("makes a document added to a private collection private too", async () => {
    const { envelope } = await twoFiles(uploader(), true);
    const added = await addEnvelopeDocuments(uploader(), envelope.id, { files: [w.file("Three.pdf")] });
    expect(added.added.map((d) => d.is_private)).toEqual([true]);
    expect(added.documents).toHaveLength(3);
    expect(added.documents.every((d) => d.is_private === true)).toBe(true);
    // and a document added to a public one is public
    const open = await twoFiles(uploader(), false);
    const more = await addEnvelopeDocuments(uploader(), open.envelope.id, { files: [w.file("Three.pdf")] });
    expect(more.added.every((d) => !d.is_private)).toBe(true);
  });

  it("reads its documents for a person who may see the collection (the collection decides)", async () => {
    const { envelope } = await twoFiles(uploader(), true);
    expect((await loadEnvelopeDocuments(admin(), envelope.id)).length).toBe(2);
    const row = w.db.rows("sign_envelopes").find((e) => e.id === envelope.id) as unknown as SignEnvelopeRow;
    expect(row.is_private).toBe(true);
  });
});
