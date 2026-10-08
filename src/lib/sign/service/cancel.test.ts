// Cancelling a COMPLETED document, or a whole document collection (migration 181), through the real services over the in-memory database. The database
// functions are stood in by cancel-fake.ts (and proved against PostgreSQL by supabase/ci/verify-181-sign-cancel-completed.sql); what is tested here is
// everything around them: who may cancel, what is refused, that the record is left alone, the notice (who gets one, in which language, once, and what a failure
// does), and what the webhooks and automations are told.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelDocument, cancelEnvelope, mayCancel, parseCancelRequest, uniqueRecipients } from "./cancel";
import { createDraftFromUpload } from "./drafts";
import { ACCT, OTHER, OTHER_USER, SENDER_EMAIL, USER, docOf, makeWorld, uploadedCollection, type World } from "./people-world";
import type { SignCtx } from "./context";
import type { SignDocumentRow } from "../types";

const rec = vi.hoisted(() => ({ automations: vi.fn(), webhooks: vi.fn() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: (...a: unknown[]) => rec.automations(...a) }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: (...a: unknown[]) => rec.webhooks(...a) }));

const ADMIN_U = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_U = "aaaaaaaa-0000-4000-8000-000000000002";
const NAMED_U = "aaaaaaaa-0000-4000-8000-000000000003";
const STAFF_U = "aaaaaaaa-0000-4000-8000-000000000004";
const KEY_ID = "key-1";
const REASON = "Signed with the wrong price list; a corrected agreement was sent.";
const SHA = "ab".repeat(32);
const CERT = "cd".repeat(32);

let w: World;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  rec.automations.mockReset().mockResolvedValue(undefined);
  rec.webhooks.mockReset().mockResolvedValue(undefined);
  w = await makeWorld();
  w.db.seed("profiles", [
    { user_id: ADMIN_U, account_id: ACCT, account_role: "admin", full_name: "Admin", email: "admin@vircle.example" },
    { user_id: OWNER_U, account_id: ACCT, account_role: "owner", full_name: "Owner", email: "owner@vircle.example" },
    { user_id: NAMED_U, account_id: ACCT, account_role: "agent", full_name: "Named", email: "named@vircle.example" },
    { user_id: STAFF_U, account_id: ACCT, account_role: "agent", full_name: "Staff", email: "staff@vircle.example" },
  ]);
  // USER, who made every document here, is an agent of the workspace
  w.db.rows("profiles").find((p) => p.user_id === USER)!.account_role = "agent";
  w.db.seed("automations", [{ id: "a1", account_id: ACCT, trigger_type: "sign_document_event", is_active: true }]);
});

const as = (userId: string | null, via?: string): SignCtx => ({ ...w.ctx, userId, ...(via ? { via } : {}) });
const maker = () => as(USER);
const admin = () => as(ADMIN_U);
const owner = () => as(OWNER_U);
const staff = () => as(STAFF_U);
const named = () => as(NAMED_U);
const key = () => as(ADMIN_U, `api_key:${KEY_ID}`);
const system = () => as(null);

const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; status?: number; issues?: unknown });
  return err ? { code: err.code, status: err.status } : null;
};
const ask = (reason: string | undefined = REASON, notify = false) => ({ reason: reason ?? "", notify });

/** A document on its own, completed and sealed (a standalone certificate), with two signers and a delegate. */
async function completedDocument(over: Record<string, unknown> = {}): Promise<SignDocumentRow> {
  const { document } = await createDraftFromUpload(maker(), { bytes: w.pdf, filename: "Agreement.pdf", title: "Merchant Agreement", isPrivate: over.is_private === true });
  Object.assign(docOf(w, document.id), {
    status: "completed",
    sent_at: "2026-10-01T08:00:00Z",
    completed_at: "2026-10-02T09:00:00Z",
    retain_until: "2033-10-02T09:00:00Z",
    final_path: `account-${ACCT}/${document.id}/final.pdf`,
    final_sha256: SHA,
    certificate_path: `account-${ACCT}/${document.id}/certificate.pdf`,
    certificate_sha256: CERT,
    ...over,
  });
  w.db.files.set(`account-${ACCT}/${document.id}/final.pdf`, new Uint8Array([1, 2, 3]));
  const person = (id: string, name: string, email: string, order: number, more: Record<string, unknown> = {}) => ({
    id: `${document.id}-${id}`, account_id: ACCT, document_id: document.id, role_key: "signer", kind: "signer", full_name: name, email, channel: "email", order_no: order, status: "signed", signed_at: "2026-10-02T08:50:00Z", party_id: null, ...more,
  });
  w.db.seed("sign_signers", [person("ali", "Ali bin Ahmad", "ali@kedai.example", 1), person("bala", "Bala Krishnan", "bala@kedai.example", 2, { locale: "ms" }), person("delegate", "Dee Legate", "dee@kedai.example", 3, { part_keys: ["bank"], delegated_by: `${document.id}-ali` })]);
  return docOf(w, document.id);
}

/** A collection of two completed documents; Ali signs both, Bala only the first. */
async function completedCollection() {
  const { envelope, documents } = await uploadedCollection(w, 2);
  const env = w.db.rows("sign_envelopes").find((e) => e.id === envelope.id)!;
  Object.assign(env, { status: "completed", title: "Merchant onboarding", locale: "en", sent_at: "2026-10-01T08:00:00Z", completed_at: "2026-10-02T09:00:00Z" });
  documents.forEach((d, i) => {
    Object.assign(docOf(w, d.id), { status: "completed", completed_at: "2026-10-02T09:00:00Z", final_path: `account-${ACCT}/${d.id}/final.pdf`, final_sha256: SHA, certificate_path: `account-${ACCT}/${d.id}/certificate.pdf`, certificate_sha256: CERT, title: `Document ${i + 1}` });
  });
  const row = (id: string, documentId: string, party: string, name: string, email: string, order: number) => ({ id, account_id: ACCT, document_id: documentId, role_key: "signer", kind: "signer", full_name: name, email, channel: "email", order_no: order, status: "signed", party_id: party });
  w.db.seed("sign_signers", [
    row("ali-1", documents[0].id, "ali-1", "Ali bin Ahmad", "ali@kedai.example", 1),
    row("ali-2", documents[1].id, "ali-1", "Ali bin Ahmad", "ali@kedai.example", 1),
    row("bala-1", documents[0].id, "bala-1", "Bala Krishnan", "bala@kedai.example", 2),
  ]);
  return { id: envelope.id, ids: documents.map((d) => d.id) };
}

const mailTo = (email: string) => w.mail.filter((m) => m.to === email);

/** A person who receives a copy, who was already sent the signed copy when the document completed (their row is marked), on a document or a collection. */
let copyN = 0;
const seedCopy = (target: { documentId: string } | { envelopeId: string }, fullName: string, email: string) =>
  w.db.seed("sign_copy_recipients", [{ id: `copy-${++copyN}`, account_id: ACCT, document_id: "documentId" in target ? target.documentId : null, envelope_id: "envelopeId" in target ? target.envelopeId : null, full_name: fullName, email, notified_at: "2026-10-02T09:01:00Z", created_at: `2026-10-01T08:0${copyN}:00Z` }]);

/** The workspace that is not the documents': a person there, and the context they call with. */
const elsewhere = (): SignCtx => ({ ...w.ctx, accountId: OTHER, userId: OTHER_USER });

describe("who may cancel", () => {
  it("lets the person who made the document cancel it, and stamps it without touching the record", async () => {
    const doc = await completedDocument();
    const before = { ...doc };
    const files = [...w.db.files.keys()];
    const result = await cancelDocument(maker(), doc.id, ask());
    expect(result).toMatchObject({ cancelled: true, scope: "document", documents: 1, cancelledAt: "2026-10-06T08:00:00.000Z", notice: null });

    const after = docOf(w, doc.id);
    expect(after).toMatchObject({ cancelled_at: "2026-10-06T08:00:00.000Z", cancelled_by: USER, cancel_reason: REASON });
    // the sealed record is exactly as it was: still completed, the same files, dates and fingerprints
    for (const k of ["status", "final_path", "final_sha256", "certificate_path", "certificate_sha256", "completed_at", "retain_until", "sent_at", "title", "reference", "created_by"] as const) expect(after[k], k).toEqual(before[k]);
    expect([...w.db.files.keys()]).toEqual(files);
    // the signers are as they were
    expect(w.signerRows().filter((s) => s.document_id === doc.id).map((s) => s.status)).toEqual(["signed", "signed", "signed"]);
    // one 'cancelled' event, carrying the reason typed
    expect(w.events("cancelled")).toHaveLength(1);
    expect(w.events("cancelled")[0].args).toMatchObject({ p_document: doc.id, p_user: USER, p_detail: { reason: REASON } });
    // and nothing was asked for that could remove or replace anything
    expect(w.rpcs("sign_cancel_document")).toHaveLength(1);
    expect(w.rpcs("sign_cancel_document")[0].args).toEqual({ p_document: doc.id, p_reason: REASON, p_actor: USER });
  });

  it("lets an admin and the owner cancel someone else's document", async () => {
    for (const ctx of [admin(), owner()]) {
      const doc = await completedDocument();
      await cancelDocument(ctx, doc.id, ask());
      expect(docOf(w, doc.id).cancelled_by).toBe(ctx.userId);
    }
  });

  it("refuses another agent, a key (even one an admin made), the system, and another workspace's person, and changes nothing", async () => {
    const doc = await completedDocument();
    expect(await refusal(cancelDocument(staff(), doc.id, ask()))).toEqual({ code: "cancel_not_allowed", status: 403 });
    expect(await refusal(cancelDocument(key(), doc.id, ask()))).toEqual({ code: "cancel_not_allowed", status: 403 });
    expect(await refusal(cancelDocument(system(), doc.id, ask()))).toEqual({ code: "cancel_not_allowed", status: 403 });
    expect(await refusal(cancelDocument(elsewhere(), doc.id, ask()))).toEqual({ code: "document_not_found", status: 404 });
    expect(docOf(w, doc.id).cancelled_at ?? null).toBeNull();
    expect(w.rpcs("sign_cancel_document")).toHaveLength(0);
  });

  it("asks the same question of a context on its own", async () => {
    const doc = await completedDocument();
    expect(await mayCancel(maker(), doc)).toBe(true);
    expect(await mayCancel(admin(), doc)).toBe(true);
    expect(await mayCancel(owner(), doc)).toBe(true);
    expect(await mayCancel(staff(), doc)).toBe(false);
    expect(await mayCancel(key(), doc)).toBe(false);
    expect(await mayCancel(system(), doc)).toBe(false);
    // a document with no maker (one whose login was deleted) is cancelled by an admin, never by "nobody"
    expect(await mayCancel(staff(), { created_by: null })).toBe(false);
    expect(await mayCancel(admin(), { created_by: null })).toBe(true);
  });
});

describe("a private document", () => {
  const privateDoc = () => completedDocument({ is_private: true });
  const nameNamed = (documentId: string) =>
    w.db.seed("sign_signers", [{ id: `named-${documentId}`, account_id: ACCT, document_id: documentId, role_key: "director", kind: "signer", full_name: "Named", email: "named@vircle.example", channel: "email", order_no: 9, status: "signed", internal_user_id: NAMED_U }]);

  it("is cancelled by the person who made it and by an admin or the owner", async () => {
    for (const ctx of [maker(), admin(), owner()]) {
      const doc = await privateDoc();
      await cancelDocument(ctx, doc.id, ask());
      expect(docOf(w, doc.id).cancelled_at).toBeTruthy();
    }
  });

  it("is 'not found' for another agent and a key, exactly as for a document that is not there", async () => {
    const doc = await privateDoc();
    const gone = await refusal(cancelDocument(maker(), "00000000-0000-4000-8000-000000000000", ask()));
    expect(gone).toEqual({ code: "document_not_found", status: 404 });
    expect(await refusal(cancelDocument(staff(), doc.id, ask()))).toEqual(gone);
    expect(await refusal(cancelDocument(key(), doc.id, ask()))).toEqual(gone);
    expect(docOf(w, doc.id).cancelled_at ?? null).toBeNull();
  });

  it("is seen by a Halo user named on it, who still may not cancel it: seeing is not enough", async () => {
    const doc = await privateDoc();
    nameNamed(doc.id);
    expect(await refusal(cancelDocument(named(), doc.id, ask()))).toEqual({ code: "cancel_not_allowed", status: 403 });
    expect(docOf(w, doc.id).cancelled_at ?? null).toBeNull();
  });

  it("makes a private collection 'not found' to those who cannot see it, and cancels it for the maker and an admin", async () => {
    const c = await uploadedCollection(w, 2);
    w.db.rows("sign_envelopes").find((e) => e.id === c.envelope.id)!.is_private = true;
    for (const id of c.ids) docOf(w, id).is_private = true;
    expect(await refusal(cancelEnvelope(staff(), c.envelope.id, ask()))).toEqual({ code: "envelope_not_found", status: 404 });
    expect(await refusal(cancelEnvelope(key(), c.envelope.id, ask()))).toEqual({ code: "envelope_not_found", status: 404 });
    // (still a draft: the maker and an admin are told what is wrong with it, not that it is missing)
    expect(await refusal(cancelEnvelope(maker(), c.envelope.id, ask()))).toEqual({ code: "envelope_not_completed", status: 409 });
    expect(await refusal(cancelEnvelope(admin(), c.envelope.id, ask()))).toEqual({ code: "envelope_not_completed", status: 409 });
  });
});

describe("what can be cancelled", () => {
  it("only a completed document: every other state is a 409 and nothing is stamped", async () => {
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) {
      const doc = await completedDocument({ status });
      expect(await refusal(cancelDocument(maker(), doc.id, ask())), status).toEqual({ code: "document_not_completed", status: 409 });
      expect(docOf(w, doc.id).cancelled_at ?? null).toBeNull();
    }
    expect(w.rpcs("sign_cancel_document")).toHaveLength(0);
  });

  it("only once: a second cancel is a 409 and neither the stamp nor the notice moves", async () => {
    const doc = await completedDocument();
    await cancelDocument(maker(), doc.id, ask("The first reason", true));
    const sent = w.mail.length;
    expect(await refusal(cancelDocument(maker(), doc.id, ask("A second reason", true)))).toEqual({ code: "document_already_cancelled", status: 409 });
    expect(docOf(w, doc.id).cancel_reason).toBe("The first reason");
    expect(w.mail).toHaveLength(sent);
    expect(w.events("cancelled")).toHaveLength(1);
  });

  it("never a document of a collection on its own: 409 belongs_to_collection, which names the collection to cancel instead", async () => {
    const c = await completedCollection();
    const err = await cancelDocument(maker(), c.ids[0], ask()).then(() => null, (e: unknown) => e as { code: string; status: number; issues?: { code: string; detail?: string }[] });
    expect(err).toMatchObject({ code: "belongs_to_collection", status: 409, issues: [{ code: "belongs_to_collection", detail: c.id }] });
    expect(w.rpcs("sign_cancel_document")).toHaveLength(0);
    expect(docOf(w, c.ids[0]).cancelled_at ?? null).toBeNull();
  });

  it("needs a reason of 3 to 500 characters once trimmed, counted the way the database counts them", async () => {
    const doc = await completedDocument();
    for (const bad of ["", "   ", "ab", "  a  ", "x".repeat(501), 42 as unknown as string, undefined as unknown as string]) {
      expect(await refusal(cancelDocument(maker(), doc.id, { reason: bad, notify: false })), String(bad)).toEqual({ code: "cancel_reason_invalid", status: 400 });
    }
    expect(w.rpcs("sign_cancel_document")).toHaveLength(0);
    // 500 characters outside the basic plane are 500 characters, not 1000
    const emoji = "😀".repeat(500);
    await cancelDocument(maker(), doc.id, { reason: `   ${emoji}  `, notify: false });
    expect(docOf(w, doc.id).cancel_reason).toBe(emoji);
  });

  it("reads the request: the reason trimmed, and notify only when it is a real true", () => {
    expect(parseCancelRequest({ reason: "  Wrong price  ", notify: true })).toEqual({ reason: "Wrong price", notify: true });
    expect(parseCancelRequest({ reason: 5, notify: "true" })).toEqual({ reason: "", notify: false });
    expect(parseCancelRequest({})).toEqual({ reason: "", notify: false });
  });
});

describe("a document collection", () => {
  it("is cancelled as one: the collection and every document get the same stamp, each document has its event, and the statuses stay completed", async () => {
    const c = await completedCollection();
    const result = await cancelEnvelope(maker(), c.id, ask());
    expect(result).toMatchObject({ cancelled: true, scope: "collection", documents: 2, notice: null });
    const env = w.db.rows("sign_envelopes").find((e) => e.id === c.id)!;
    expect(env).toMatchObject({ status: "completed", cancelled_at: "2026-10-06T08:00:00.000Z", cancelled_by: USER, cancel_reason: REASON });
    for (const id of c.ids) {
      expect(docOf(w, id), id).toMatchObject({ status: "completed", cancelled_at: "2026-10-06T08:00:00.000Z", cancelled_by: USER, cancel_reason: REASON, final_sha256: SHA, certificate_sha256: CERT });
    }
    const events = w.events("cancelled");
    expect(events.map((e) => e.args.p_document)).toEqual(c.ids);
    expect(events[0].args.p_detail).toMatchObject({ reason: REASON, envelope_id: c.id, position: 1, count: 2 });
  });

  it("is refused whole when it is not completed, already cancelled, or the person is neither its maker nor an admin", async () => {
    const c = await completedCollection();
    expect(await refusal(cancelEnvelope(staff(), c.id, ask()))).toEqual({ code: "cancel_not_allowed", status: 403 });
    docOf(w, c.ids[1]).status = "sealing";
    w.db.rows("sign_envelopes").find((e) => e.id === c.id)!.status = "sealing";
    expect(await refusal(cancelEnvelope(maker(), c.id, ask()))).toEqual({ code: "envelope_not_completed", status: 409 });
    docOf(w, c.ids[1]).status = "completed";
    w.db.rows("sign_envelopes").find((e) => e.id === c.id)!.status = "completed";
    await cancelEnvelope(admin(), c.id, ask());
    expect(await refusal(cancelEnvelope(maker(), c.id, ask()))).toEqual({ code: "envelope_already_cancelled", status: 409 });
    expect(await refusal(cancelEnvelope(maker(), "00000000-0000-4000-8000-000000000000", ask()))).toEqual({ code: "envelope_not_found", status: 404 });
    expect(await refusal(cancelEnvelope(elsewhere(), c.id, ask()))).toEqual({ code: "envelope_not_found", status: 404 });
    // (only the one that succeeded reached the database: every refusal was made before it)
    expect(w.rpcs("sign_cancel_envelope")).toHaveLength(1);
  });
});

describe("Notify everyone", () => {
  it("is off unless asked: nobody is emailed and the notice is not even claimed", async () => {
    const doc = await completedDocument();
    const result = await cancelDocument(maker(), doc.id, ask(REASON, false));
    expect(result.notice).toBeNull();
    expect(w.mail).toHaveLength(0);
    expect(w.rpcs("sign_cancel_claim_notice")).toHaveLength(0);
  });

  it("emails the signers, the people who receive a copy and the sender, ONE message each, never a person handed only a part", async () => {
    const doc = await completedDocument();
    seedCopy({ documentId: doc.id }, "Cara Lim", "cara@kedai.example");
    // the sender is also on the copy list: still one message
    seedCopy({ documentId: doc.id }, "Gokula (me)", SENDER_EMAIL);
    const result = await cancelDocument(maker(), doc.id, ask(REASON, true));
    expect(result.notice).toEqual({ sent: 4, failed: 0 });
    expect(w.mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example", "cara@kedai.example", SENDER_EMAIL].sort());
    expect(mailTo("dee@kedai.example")).toHaveLength(0);

    const ali = mailTo("ali@kedai.example")[0];
    expect(ali.subject).toBe("Cancelled: Merchant Agreement");
    expect(ali.text).toContain(`“Merchant Agreement” (${doc.reference}) was cancelled by Vircle Sdn Bhd on 6 Oct 2026.`);
    expect(ali.text).toContain(`Reason: ${REASON}`);
    expect(ali.text).toContain("The signed copy you already have remains a record of what was signed; it is no longer in force.");
    // no link of any kind, no file, no document
    for (const m of w.mail) {
      expect(m.text, m.to).not.toMatch(/https?:|\/s\/|\/verify\//);
      expect(m.html, m.to).not.toMatch(/href=|<img/);
      expect(m.attachments ?? [], m.to).toEqual([]);
    }
    // the notice is claimed once, in the database, and recorded in the history as counts only
    expect(w.rpcs("sign_cancel_claim_notice")).toHaveLength(1);
    expect(docOf(w, doc.id).cancel_notified_at).toBeTruthy();
    expect(w.events("cancel_notice_sent")[0].args).toMatchObject({ p_document: doc.id, p_detail: { sent: 4, failed: 0 } });
    expect(JSON.stringify(w.events("cancel_notice_sent"))).not.toContain("@");
  });

  it("writes each person's message in their own language: the signer's, else the document's", async () => {
    const doc = await completedDocument({ locale: "zh" });
    seedCopy({ documentId: doc.id }, "Cara Lim", "cara@kedai.example");
    await cancelDocument(maker(), doc.id, ask(REASON, true));
    // Bala has asked for Bahasa Melayu; Ali and the copy follow the document
    expect(mailTo("bala@kedai.example")[0].subject).toBe("Dibatalkan: Merchant Agreement");
    expect(mailTo("ali@kedai.example")[0].subject).toBe("已取消：Merchant Agreement");
    expect(mailTo("cara@kedai.example")[0].subject).toBe("已取消：Merchant Agreement");
    expect(mailTo("ali@kedai.example")[0].text).toContain("原因：");
    expect(mailTo("bala@kedai.example")[0].text).toContain("Sebab:");
  });

  it("sends nothing twice: a notice that was already claimed is not sent again, and the cancellation still stands", async () => {
    const doc = await completedDocument();
    docOf(w, doc.id).cancel_notified_at = "2026-10-06T07:00:00.000Z"; // (a claim another call already made)
    const result = await cancelDocument(maker(), doc.id, ask(REASON, true));
    expect(result.notice).toBeNull();
    expect(w.mail).toHaveLength(0);
    expect(docOf(w, doc.id).cancelled_at).toBeTruthy();
    expect(w.events("cancel_notice_sent")).toHaveLength(0);
  });

  it("records a message that could not be delivered (never the address), mails the others, and does not undo the cancellation", async () => {
    const doc = await completedDocument();
    w.failTo.add("ali@kedai.example");
    const result = await cancelDocument(maker(), doc.id, ask(REASON, true));
    expect(result.notice).toEqual({ sent: 2, failed: 1 });
    expect(docOf(w, doc.id).cancelled_at).toBeTruthy();
    expect(mailTo("ali@kedai.example")).toHaveLength(0);
    expect(mailTo("bala@kedai.example")).toHaveLength(1);
    const failed = w.events("delivery_failed").filter((e) => (e.args.p_detail as { kind?: string }).kind === "cancel");
    expect(failed).toHaveLength(1);
    expect(failed[0].args).toMatchObject({ p_document: doc.id, p_actor_type: "system", p_detail: { kind: "cancel", status: "failed", reason: "mailbox unavailable" } });
    expect(JSON.stringify(failed[0].args)).not.toContain("ali@");
    expect(w.events("cancel_notice_sent")[0].args.p_detail).toEqual({ sent: 2, failed: 1 });
  });

  it("tells each person of a collection once, whatever the number of documents, and writes the collection's words", async () => {
    const c = await completedCollection();
    seedCopy({ envelopeId: c.id }, "Cara Lim", "cara@kedai.example");
    const result = await cancelEnvelope(maker(), c.id, ask(REASON, true));
    // Ali is on both documents and gets one message; so do Bala, the copy and the sender
    expect(result.notice).toEqual({ sent: 4, failed: 0 });
    expect(w.mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example", "cara@kedai.example", SENDER_EMAIL].sort());
    const ali = mailTo("ali@kedai.example")[0];
    expect(ali.subject).toBe("Cancelled: Merchant onboarding (2 documents)");
    expect(ali.text).toContain("a collection of 2 documents, was cancelled by Vircle Sdn Bhd on 6 Oct 2026");
    expect(ali.text).toContain("The signed copies you already have remain a record of what was signed; they are no longer in force.");
    // the claim is the collection's, and every document's history says the notice went
    expect(w.rpcs("sign_cancel_claim_notice")).toEqual([expect.objectContaining({ args: { p_envelope: c.id } })]);
    expect(w.events("cancel_notice_sent").map((e) => e.args.p_document)).toEqual(c.ids);
  });

  it("de-duplicates the people by address, case ignored, keeping the first", () => {
    expect(uniqueRecipients([
      { name: "Ali", email: "Ali@Kedai.example", locale: "en" },
      { name: "Ali again", email: "ali@kedai.example ", locale: "ms" },
      { name: "Bala", email: "bala@kedai.example", locale: "en" },
      { name: "Nobody", email: "  ", locale: "en" },
    ]).map((p) => p.name)).toEqual(["Ali", "Bala"]);
  });
});

describe("what the webhooks and automations are told", () => {
  it("sends sign.cancelled for the document, still completed, with the date and the proof, and neither an address nor the reason (a void's reason is not sent either)", async () => {
    const doc = await completedDocument();
    await cancelDocument(maker(), doc.id, ask());
    expect(rec.webhooks).toHaveBeenCalledTimes(1);
    const [, account, event, data] = rec.webhooks.mock.calls[0];
    expect(account).toBe(ACCT);
    expect(event).toBe("sign.cancelled");
    expect(data).toMatchObject({ document_id: doc.id, status: "completed", cancelled_at: "2026-10-06T08:00:00.000Z", final_sha256: SHA, certificate_sha256: CERT, verify_url: `https://halo.test/verify/${doc.id}` });
    expect(JSON.stringify(data)).not.toMatch(/@kedai|ali@|price list|cancel_reason|cancelled_by/);
    expect(rec.automations).toHaveBeenCalledTimes(1);
    expect(rec.automations.mock.calls[0][0].context.sign).toMatchObject({ event: "cancelled", status: "completed", cancelled_at: "2026-10-06T08:00:00.000Z" });
    expect(JSON.stringify(rec.automations.mock.calls[0][0].context.sign)).not.toContain("price list");
  });

  it("sends one sign.cancelled for each document of a collection", async () => {
    const c = await completedCollection();
    await cancelEnvelope(maker(), c.id, ask());
    expect(rec.webhooks.mock.calls.map((x) => [x[2], (x[3] as { document_id: string }).document_id, (x[3] as { envelope_id: string }).envelope_id])).toEqual(c.ids.map((id) => ["sign.cancelled", id, c.id]));
  });

  it("sends nothing when the cancel was refused", async () => {
    const doc = await completedDocument();
    await cancelDocument(staff(), doc.id, ask()).catch(() => undefined);
    expect(rec.webhooks).not.toHaveBeenCalled();
    expect(rec.automations).not.toHaveBeenCalled();
  });
});
