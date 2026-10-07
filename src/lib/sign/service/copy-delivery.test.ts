import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENVELOPE_ATTACH_BYTES } from "../envelopes/status";
import type { SignDocumentRow, SignEnvelopeRow } from "../types";
import { addCopyRecipient, setCopyRecipients, type CopyTarget } from "./copy-recipients";
import { createDraftFromUpload, setSigners } from "./drafts";
import { loadEnvelope, loadEnvelopeDocuments } from "./envelope-data";
import { notifyEnvelopeCompleted } from "./envelope-delivery";
import { settleEnvelope, setEnvelopeSigners } from "./envelopes";
import { notifyCompleted } from "./outcome";
import { ALI_KEY, BALA_KEY, SENDER_EMAIL, docOf, makeWorld, signerIn, uploadedCollection, type World } from "./people-world";
import { runSealing } from "./seal";

// The completion step and the people who receive a copy (migration 175): ONE email each, with the signed PDF(s) attached, once, and never a link
// that opens the file. The sealing is the real service (with a self-signed certificate); the mail server is a recorder that can refuse an address.
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const to = (email: string) => w.mail.filter((m) => m.to === email);
const copyRow = (email: string) => w.copyRows().find((c) => c.email === email)!;
const bytes = (n: number) => new Uint8Array(n).fill(7);
const attachmentBytes = (m: { attachments?: { content: string }[] }) => (m.attachments ?? []).map((a) => Buffer.from(a.content, "base64").length);

const CARA = { fullName: "Cara Lim", email: "cara@kedai.example" };
const DEV = { fullName: "Dev Raj", email: "dev@kedai.example" };

/** A document on its own with two signers (Ali and Bala) and a title. */
async function singleDocument(opts: { form?: boolean } = {}) {
  const { document } = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Agreement.pdf", title: "Merchant Agreement" });
  await setSigners(w.ctx, document.id, [
    { roleKey: "signer", kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 },
    { roleKey: "signer2", kind: "signer", fullName: "Bala", email: "bala@kedai.example", channel: "email", orderNo: 2 },
  ]);
  if (opts.form) docOf(w, document.id).mode = "form";
  const doc = docOf(w, document.id);
  return { doc, id: document.id, target: { documentId: document.id } as CopyTarget, signers: () => w.signerRows().filter((s) => s.document_id === document.id) };
}

describe("a document on its own, through the real sealing", () => {
  it("mails each person who receives a copy ONE email with the signed PDF attached; the signers' mail is as before; the copy rows are marked; the sender who is also on the list is marked and mailed once", async () => {
    const { doc, id, target } = await singleDocument();
    await addCopyRecipient(w.ctx, target, CARA);
    await addCopyRecipient(w.ctx, target, DEV);
    await addCopyRecipient(w.ctx, target, { fullName: "Gokula (me)", email: SENDER_EMAIL });
    // everyone has signed: the database has the document sealing
    docOf(w, id).status = "sealing";
    for (const s of w.signerRows()) Object.assign(s, { status: "signed", signed_at: "2026-10-06T07:00:00Z", consented_at: "2026-10-06T06:59:00Z" });
    w.seedCertificate();

    expect(await runSealing({ admin: w.ctx.admin, origin: w.ctx.origin, deps: w.ctx.deps, now: w.ctx.now }, 4)).toEqual({ claimed: 1, completed: 1, retry: 0 });
    expect(docOf(w, id).status).toBe("completed");

    // the signers and the sender: one each, with the signed file, as before
    for (const email of ["ali@kedai.example", "bala@kedai.example", SENDER_EMAIL]) {
      expect(to(email)).toHaveLength(1);
      expect(to(email)[0].subject).toBe("Signed: Merchant Agreement");
      expect(to(email)[0].attachments?.[0].filename).toBe(`${doc.reference}-signed.pdf`);
    }
    // the copy recipients: one each, the sealed PDF attached, never a link that opens it
    for (const p of [CARA, DEV]) {
      const mails = to(p.email);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe("Signed copy: Merchant Agreement");
      expect(mails[0].attachments).toHaveLength(1);
      expect(mails[0].attachments![0].filename).toBe(`${doc.reference}-signed.pdf`);
      expect(attachmentBytes(mails[0])[0]).toBeGreaterThan(1000);
      expect(mails[0].text).toContain(`Hello ${p.fullName}`);
      expect(mails[0].text).not.toMatch(/\/s\/[0-9a-f]/);
      expect(mails[0].text).not.toContain("/verify/");
      expect(mails[0].html).not.toMatch(/href=/);
    }
    // the same file reached the signer and the copy
    expect(to(CARA.email)[0].attachments![0].content).toBe(to("ali@kedai.example")[0].attachments![0].content);
    // the sender is on the copy list too: marked as sent, not mailed a second time
    expect(copyRow(SENDER_EMAIL).notified_at).toBeTruthy();
    expect(w.mail.filter((m) => m.to === SENDER_EMAIL)).toHaveLength(1);
    for (const p of [CARA, DEV]) expect(copyRow(p.email).notified_at).toBeTruthy();
  }, 30_000);

  it("sends nothing more when the completion step runs again: not the sealing re-run, not the step itself", async () => {
    const { id, target, signers } = await singleDocument();
    await addCopyRecipient(w.ctx, target, CARA);
    docOf(w, id).status = "sealing";
    for (const s of w.signerRows()) Object.assign(s, { status: "signed", signed_at: "2026-10-06T07:00:00Z" });
    w.seedCertificate();
    await runSealing({ admin: w.ctx.admin, origin: w.ctx.origin, deps: w.ctx.deps, now: w.ctx.now }, 4);
    expect(to(CARA.email)).toHaveLength(1);
    // the sealing job comes round again: the document is not sealing any more
    expect(await runSealing({ admin: w.ctx.admin, origin: w.ctx.origin, deps: w.ctx.deps, now: w.ctx.now }, 4)).toEqual({ claimed: 0, completed: 0, retry: 0 });
    // and the step itself, called again with the same document
    await notifyCompleted(w.ctx, docOf(w, id), signers(), w.db.files.get(docOf(w, id).final_path!)!);
    expect(to(CARA.email)).toHaveLength(1);
  }, 30_000);

  it("sends the copies once even when two runs of the step overlap (the claim is one update that hands back only the rows it changed)", async () => {
    const { id, target, signers } = await singleDocument();
    await setCopyRecipients(w.ctx, target, [CARA, DEV]);
    await Promise.all([notifyCompleted(w.ctx, docOf(w, id), signers(), w.pdf), notifyCompleted(w.ctx, docOf(w, id), signers(), w.pdf)]);
    expect(to(CARA.email)).toHaveLength(1);
    expect(to(DEV.email)).toHaveLength(1);
  });

  it("a copy recipient whose address became a signer's is marked and mailed only as the signer", async () => {
    const { id, signers } = await singleDocument();
    // the screens refuse this, the database does not (a signer's address can be changed later): the person must still not get two
    w.db.seed("sign_copy_recipients", [{ id: "cp1", account_id: w.ctx.accountId, document_id: id, envelope_id: null, full_name: "Ali again", email: "ALI@kedai.example", notified_at: null }]);
    await notifyCompleted(w.ctx, docOf(w, id), signers(), w.pdf);
    expect(w.mail.filter((m) => m.to.toLowerCase() === "ali@kedai.example")).toHaveLength(1);
    expect(w.copyRows()[0].notified_at).toBeTruthy();
  });

  it("gives the claim back when the message cannot be delivered, records delivery_failed with kind copy, mails the others, and the next run sends only to the one that failed", async () => {
    const { id, target, signers } = await singleDocument();
    await setCopyRecipients(w.ctx, target, [CARA, DEV]);
    w.failTo.add(CARA.email);
    await notifyCompleted(w.ctx, docOf(w, id), signers(), w.pdf);
    expect(to(CARA.email)).toHaveLength(0);
    expect(copyRow(CARA.email).notified_at).toBeNull();
    expect(copyRow(DEV.email).notified_at).toBeTruthy();
    expect(to(DEV.email)).toHaveLength(1);
    const failed = w.events("delivery_failed").filter((e) => (e.args.p_detail as { kind?: string }).kind === "copy");
    expect(failed).toHaveLength(1);
    expect(failed[0].args).toMatchObject({ p_document: id, p_actor_type: "system", p_detail: { kind: "copy", status: "failed", reason: "mailbox unavailable" } });
    // the address is not in the history
    expect(JSON.stringify(failed[0].args)).not.toContain("cara@");
    // a later run (the sender fixes the address problem, the mail server is back)
    w.failTo.clear();
    await notifyCompleted(w.ctx, docOf(w, id), signers(), w.pdf);
    expect(to(CARA.email)).toHaveLength(1);
    expect(to(DEV.email)).toHaveLength(1);
  });

  it("mails a copy that is too large to attach WITHOUT the file, says the sender can provide it, and names only the page that checks the document: no link that opens it", async () => {
    const { doc, id, target, signers } = await singleDocument();
    await addCopyRecipient(w.ctx, target, CARA);
    await notifyCompleted(w.ctx, docOf(w, id), signers(), bytes(21 * 1024 * 1024));
    const m = to(CARA.email)[0];
    expect(m.attachments).toBeUndefined();
    expect(m.text).toContain("too large to attach");
    expect(m.text).toContain("Ask Gokula for it");
    expect(m.text).toContain(`https://halo.test/verify/${doc.id}`);
    expect(m.html).toContain(`https://halo.test/verify/${doc.id}`);
    // no signing link, no download address anywhere in the message
    for (const body of [m.text, m.html]) {
      expect(body).not.toMatch(/\/s\/[0-9a-f]{8}/);
      expect(body).not.toMatch(/download|\/api\//i);
      expect([...body.matchAll(/https?:\/\/[^\s"<)]+/g)].map((x) => x[0]).filter((u) => u.includes("halo.test"))).toEqual(expect.arrayContaining([`https://halo.test/verify/${doc.id}`]));
    }
    expect(copyRow(CARA.email).notified_at).toBeTruthy();
  });

  it("sends the sealed submission record to a form-only document's copy, in the form's words", async () => {
    const { doc, id, target, signers } = await singleDocument({ form: true });
    await addCopyRecipient(w.ctx, target, CARA);
    await notifyCompleted(w.ctx, docOf(w, id), signers(), w.pdf);
    const m = to(CARA.email)[0];
    expect(m.subject).toBe("Received: Merchant Agreement");
    expect(m.attachments![0].filename).toBe(`${doc.reference}-record.pdf`);
    expect(m.text).toContain("a record of the details submitted");
    expect(m.text).not.toContain("Everyone has signed");
  });

  it("sends the signers and the sender exactly what they got before when nobody receives a copy", async () => {
    const { id, signers } = await singleDocument();
    await notifyCompleted(w.ctx, docOf(w, id), signers(), w.pdf);
    expect(w.mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example", SENDER_EMAIL]);
    expect(w.copyRows()).toHaveLength(0);
  });
});

describe("a document collection", () => {
  async function sealedCollection(opts: { form?: boolean } = {}) {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await setCopyRecipients(w.ctx, { envelopeId: envelope.id }, [CARA, DEV]);
    if (opts.form) for (const id of ids) docOf(w, id).mode = "form";
    return { envelope, ids, target: { envelopeId: envelope.id } as CopyTarget };
  }
  const complete = (ids: string[], size = 5000) => {
    for (const id of ids) {
      const d = docOf(w, id);
      Object.assign(d, { status: "completed", final_path: `account-${w.ctx.accountId}/${id}/final/x.pdf`, completed_at: "2026-10-06T08:00:00Z" });
      w.db.files.set(d.final_path!, bytes(size));
    }
  };
  const settle = (envelopeId: string) => settleEnvelope(w.ctx, envelopeId);

  it("says nothing to anyone before the LAST document is complete", async () => {
    const { envelope, ids } = await sealedCollection();
    complete([ids[0]]);
    await settle(envelope.id);
    expect(w.mail).toHaveLength(0);
    expect(w.copyRows().every((c) => c.notified_at === null)).toBe(true);
  });

  it("sends ONE email to each person who receives a copy with ALL the signed PDFs attached, once; the people's own messages are unchanged", async () => {
    const { envelope, ids } = await sealedCollection();
    complete(ids);
    await settle(envelope.id);
    for (const email of ["ali@kedai.example", "bala@kedai.example", SENDER_EMAIL]) {
      expect(to(email)).toHaveLength(1);
      expect(to(email)[0].attachments).toHaveLength(2);
    }
    for (const p of [CARA, DEV]) {
      const mails = to(p.email);
      expect(mails).toHaveLength(1);
      expect(mails[0].attachments).toHaveLength(2);
      expect(mails[0].attachments!.map((a) => a.filename)).toEqual(ids.map((id) => `${docOf(w, id).reference}-signed.pdf`));
      expect(mails[0].subject).toBe(`Signed copies: ${envelope.title} (2 documents)`);
      expect(mails[0].text).toContain("The 2 signed copies are attached");
      expect(mails[0].text).not.toMatch(/\/s\/[0-9a-f]/);
      expect(mails[0].text).not.toContain("/verify/");
      expect(copyRow(p.email).notified_at).toBeTruthy();
    }
    // the completion step again (settled twice, or run on its own): nothing more to the copies
    await settle(envelope.id);
    const [env, docs] = await Promise.all([loadEnvelope(w.ctx, envelope.id), loadEnvelopeDocuments(w.ctx, envelope.id)]);
    await notifyEnvelopeCompleted(w.ctx, env, docs, []);
    expect(to(CARA.email)).toHaveLength(1);
    expect(to(DEV.email)).toHaveLength(1);
  });

  it("through the real sealing: nothing is sent when the first document is sealed, one email each when the last is", async () => {
    const { envelope, ids } = await sealedCollection();
    for (const id of ids) docOf(w, id).status = "sealing";
    for (const s of w.signerRows()) Object.assign(s, { status: "signed", signed_at: "2026-10-06T07:00:00Z" });
    w.seedCertificate();
    const base = { admin: w.ctx.admin, origin: w.ctx.origin, deps: w.ctx.deps, now: w.ctx.now };
    const claim = w.db.rpcHandlers.sign_claim_sealing;
    w.db.rpcHandlers.sign_claim_sealing = async () => ({ data: [{ document_id: ids[0], account_id: w.ctx.accountId }], error: null });
    await runSealing(base, 1);
    expect(docOf(w, ids[0]).status).toBe("completed");
    expect(w.mail).toHaveLength(0);
    expect(w.copyRows().every((c) => c.notified_at === null)).toBe(true);
    w.db.rpcHandlers.sign_claim_sealing = claim;
    await runSealing(base, 1);
    expect((await loadEnvelope(w.ctx, envelope.id)).status).toBe("completed");
    for (const p of [CARA, DEV]) {
      expect(to(p.email)).toHaveLength(1);
      expect(to(p.email)[0].attachments).toHaveLength(2);
      // each attachment is a real sealed PDF
      for (const a of to(p.email)[0].attachments!) expect(Buffer.from(a.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    }
  }, 30_000);

  it("attaches while the files fit in ENVELOPE_ATTACH_BYTES and lists the documents that did not fit with the page that checks each, never a download link", async () => {
    const { envelope, ids } = await sealedCollection();
    complete([ids[0]], 15 * 1024 * 1024);
    complete([ids[1]], 10 * 1024 * 1024);
    expect(15 * 1024 * 1024 + 10 * 1024 * 1024).toBeGreaterThan(ENVELOPE_ATTACH_BYTES);
    await settle(envelope.id);
    const m = to(CARA.email)[0];
    expect(m.attachments).toHaveLength(1);
    expect(attachmentBytes(m)).toEqual([15 * 1024 * 1024]);
    expect(m.text).toContain("1 of the 2 signed copies are attached");
    expect(m.text).toContain(`${docOf(w, ids[1]).title}: https://halo.test/verify/${ids[1]}`);
    expect(m.text).not.toContain(`/verify/${ids[0]}`);
    expect(m.text).not.toMatch(/\/s\/[0-9a-f]{8}/);
    expect(m.html).toContain(`https://halo.test/verify/${ids[1]}`);
  });

  it("lists every document when none fits", async () => {
    const { envelope, ids } = await sealedCollection();
    complete(ids, 21 * 1024 * 1024);
    await settle(envelope.id);
    const m = to(CARA.email)[0];
    expect(m.attachments).toBeUndefined();
    expect(m.text).toContain("The signed copies are too large to attach. Ask Gokula for them.");
    for (const id of ids) expect(m.text).toContain(`https://halo.test/verify/${id}`);
    expect(copyRow(CARA.email).notified_at).toBeTruthy();
  });

  it("sends the sealed submission records, in the form's words, when every document is a form without a signature", async () => {
    const { envelope, ids } = await sealedCollection({ form: true });
    complete(ids);
    await settle(envelope.id);
    const m = to(CARA.email)[0];
    expect(m.subject).toBe(`Received: ${envelope.title} (2 documents)`);
    expect(m.attachments!.map((a) => a.filename)).toEqual(ids.map((id) => `${docOf(w, id).reference}-record.pdf`));
    expect(m.text).toContain("records of what was submitted are attached");
    expect(m.text).not.toContain("Everyone has signed");
  });

  it("gives the claim back for a person whose message failed, logs delivery_failed on the first document, and a later run sends only to them", async () => {
    const { envelope, ids } = await sealedCollection();
    complete(ids);
    w.failTo.add(CARA.email);
    await settle(envelope.id);
    expect(to(CARA.email)).toHaveLength(0);
    expect(copyRow(CARA.email).notified_at).toBeNull();
    expect(to(DEV.email)).toHaveLength(1);
    const failed = w.events("delivery_failed").filter((e) => (e.args.p_detail as { kind?: string }).kind === "copy");
    expect(failed.map((e) => e.args.p_document)).toEqual([ids[0]]);
    w.failTo.clear();
    const [env, docs] = await Promise.all([loadEnvelope(w.ctx, envelope.id), loadEnvelopeDocuments(w.ctx, envelope.id)]);
    const files = docs.map((d) => ({ bytes: bytes(5000), filename: `${d.reference}-signed.pdf`, documentId: d.id }));
    await notifyEnvelopeCompleted(w.ctx, env as SignEnvelopeRow, docs as SignDocumentRow[], files);
    expect(to(CARA.email)).toHaveLength(1);
    expect(to(DEV.email)).toHaveLength(1);
  });

  it("marks a copy recipient who is also the sender and mails them once", async () => {
    const { envelope, ids, target } = await sealedCollection();
    await addCopyRecipient(w.ctx, target, { fullName: "Gokula", email: SENDER_EMAIL });
    complete(ids);
    await settle(envelope.id);
    expect(to(SENDER_EMAIL)).toHaveLength(1);
    expect(copyRow(SENDER_EMAIL).notified_at).toBeTruthy();
  });
});
