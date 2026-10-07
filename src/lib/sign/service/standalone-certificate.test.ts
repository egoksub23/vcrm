import { createHash } from "node:crypto";

import { strFromU8, unzipSync } from "fflate";
import { getDocumentProxy } from "unpdf";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySealed } from "../pdf/verify";
import { fileForApi } from "./api";
import { createDraftFromUpload, deleteDocument, setSigners, updateDraft } from "./drafts";
import { finishEnvelope } from "./envelope-signing";
import { loadEnvelope, loadEnvelopeDocuments } from "./envelope-data";
import { sendEnvelope, setEnvelopeSigners } from "./envelopes";
import { planEnvelopeZip, planZip, zipStream } from "./export";
import { ALI_KEY, BALA_KEY, OTHER_USER, SENDER_EMAIL, docOf, makeWorld, sig, signerIn, uploadedCollection, type World } from "./people-world";
import { runSealing } from "./seal";
import { buildView, certificateForSigner, fileForSigner, lookupByToken, pickDocument, recordConsent, saveAnswers, zipForSigner } from "./signing";
import { loadVerification } from "./verify";

// The certificate as a file of its own (migration 178) through the REAL sealing, the real PDF engine and a real self-signed certificate, against the
// in-memory database: what is sealed and stored, what the database is told in the one call that completes the document, the ID line on every page, the
// layouts (standalone by default, also embedded when the workspace asks), a failure while making or storing the certificate (the document is never
// completed without it, and the attempt is retried like any other), the downloads that answer for both layouts (the zip, the API, the signer's page,
// the verify page), deletion, and the old documents whose certificate is inside the signed PDF. The database's own rules are proved by
// supabase/ci/verify-178-sign-standalone-certificate.sql.

const rec = vi.hoisted(() => ({ automations: vi.fn(), webhooks: vi.fn() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: (...a: unknown[]) => rec.automations(...a) }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: (...a: unknown[]) => rec.webhooks(...a) }));
// the real seal, except that the test can make the Nth seal of a sealing attempt fail (the first is the signed file, the second the certificate)
const seal = vi.hoisted(() => ({ calls: 0, failOn: 0 }));
vi.mock("../pdf/seal", async (original) => {
  const real = await original<typeof import("../pdf/seal")>();
  return {
    ...real,
    sealPdf: async (...args: Parameters<typeof real.sealPdf>) => {
      seal.calls++;
      if (seal.failOn > 0 && seal.calls === seal.failOn) throw new Error(`seal number ${seal.calls} failed`);
      return real.sealPdf(...args);
    },
  };
});

let w: World;
beforeEach(async () => {
  seal.calls = 0;
  seal.failOn = 0;
  rec.automations.mockReset().mockResolvedValue(undefined);
  rec.webhooks.mockReset().mockResolvedValue(undefined);
  w = await makeWorld();
});

const base = () => ({ admin: w.ctx.admin, origin: w.ctx.origin, deps: w.ctx.deps, now: w.ctx.now });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const to = (email: string) => w.mail.filter((m) => m.to === email);

async function pages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " "));
  return out;
}
const squash = (s: string) => s.replace(/\s/g, "");
const unzip = async (stream: ReadableStream<Uint8Array>) => unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));

/** A document on its own with two signers, the way the sealing job finds it: everyone has signed. */
async function sealingDocument(over: Record<string, unknown> = {}) {
  const { document } = await createDraftFromUpload(w.ctx, { bytes: await (await import("../pdf/fixtures")).makePdf([{ w: 595.28, h: 841.89 }, { w: 792, h: 612 }]), filename: "Agreement.pdf", title: "Merchant Agreement" });
  await setSigners(w.ctx, document.id, [
    { roleKey: "signer", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email", orderNo: 1 },
    { roleKey: "signer2", kind: "signer", fullName: "Bala", email: "bala@kedai.example", channel: "email", orderNo: 2 },
  ]);
  Object.assign(docOf(w, document.id), { status: "sealing", sent_at: "2026-10-06T02:00:00Z", base_sha256: "f".repeat(64), page_count: 2, ...over });
  for (const s of w.signerRows()) Object.assign(s, { status: "signed", signed_at: "2026-10-06T07:00:00Z", consented_at: "2026-10-06T06:59:00Z", ip: "203.0.113.9", device: "Chrome" });
  w.seedCertificate();
  return docOf(w, document.id);
}

describe("sealing a document on its own", () => {
  it("seals the signed file with the ID line on every page and NO certificate pages, then the certificate as a file of its own that names it, and tells the database about both in one call", async () => {
    const doc = await sealingDocument();
    expect(await runSealing(base(), 4)).toEqual({ claimed: 1, completed: 1, retry: 0 });

    const d = docOf(w, doc.id);
    expect(d.status).toBe("completed");
    const signed = w.db.files.get(d.final_path!)!;
    const certificate = w.db.files.get(String(d.certificate_path))!;
    expect(sha(signed)).toBe(d.final_sha256);
    expect(sha(certificate)).toBe(d.certificate_sha256);
    expect(d.certificate_path).toMatch(new RegExp(`^account-${w.ctx.accountId}/${doc.id}/certificate/[0-9a-f]{64}\\.pdf$`));
    // both are sealed with the workspace's certificate, and both verify
    for (const bytes of [signed, certificate]) {
      const v = verifySealed(bytes);
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.signer?.subject).toContain("Test seal");
    }
    // the database is told once, with the signed file and the certificate together
    const fin = w.rpcs("sign_finish_sealing");
    expect(fin).toHaveLength(1);
    expect(fin[0].args).toMatchObject({ p_document: doc.id, p_final_path: d.final_path, p_final_sha256: d.final_sha256, p_certificate_path: d.certificate_path, p_certificate_sha256: d.certificate_sha256 });

    // the signed file: the document's own two pages (portrait and landscape), the ID line on each, and no certificate
    const signedPages = await pages(signed);
    expect(signedPages).toHaveLength(2);
    for (const text of signedPages) expect(text).toContain(`Vircle Secure Sign · ID ${doc.id}`);
    expect(signedPages.join(" ")).not.toContain("Certificate of Completion");
    // the certificate: its own pages, naming the signed file, its fingerprint, the reference and the id, who signed
    const text = (await pages(certificate)).join(" ");
    for (const s of ["Certificate of Completion", doc.reference!, `${doc.reference}-signed.pdf`, doc.id, "Ali bin Ahmad", "Bala", "203.0.113.9"]) expect(text, s).toContain(s);
    expect(squash(text)).toContain(String(d.final_sha256));
    expect(text).toContain("This certificate is a separate file");

    // both are kept as files of the document
    const rows = w.db.rows("sign_document_files").filter((f) => f.document_id === doc.id);
    expect(rows.find((f) => f.kind === "signed")).toMatchObject({ path: d.final_path, name: `${doc.reference}-signed.pdf`, sha256: d.final_sha256, size_bytes: signed.byteLength });
    expect(rows.find((f) => f.kind === "certificate")).toMatchObject({ path: d.certificate_path, name: `${doc.reference}-certificate.pdf`, sha256: d.certificate_sha256, size_bytes: certificate.byteLength });
  }, 30_000);

  it("sends the signed document AND the certificate as two separate attachments to each signer and the sender, and says so", async () => {
    const doc = await sealingDocument();
    await runSealing(base(), 4);
    for (const email of ["ali@kedai.example", "bala@kedai.example", SENDER_EMAIL]) {
      const [m] = to(email);
      expect(m.attachments?.map((a) => a.filename)).toEqual([`${doc.reference}-signed.pdf`, `${doc.reference}-certificate.pdf`]);
      expect(m.text).toContain("The signed copy is attached to this message.");
      expect(m.text).toContain("The certificate is attached to this message as a separate file.");
      for (const a of m.attachments!) expect(Buffer.from(a.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    }
  }, 30_000);

  it("sends the webhook the certificate's fingerprint beside the signed file's", async () => {
    const doc = await sealingDocument();
    await runSealing(base(), 4);
    const d = docOf(w, doc.id);
    const sent = rec.webhooks.mock.calls.find((c) => c[2] === "sign.completed")!;
    expect(sent[3]).toMatchObject({ document_id: doc.id, final_sha256: d.final_sha256, certificate_sha256: d.certificate_sha256 });
    // (the automation's own variables are checked on the pure payload in outbound.test.ts)
  }, 30_000);

  it("also puts the certificate pages inside the signed file when the workspace asks (the setting is off until it does), with the ID line on those pages too", async () => {
    const doc = await sealingDocument();
    w.db.rows("sign_settings").find((s) => s.account_id === w.ctx.accountId)!.embed_certificate = true;
    expect(await runSealing(base(), 4)).toEqual({ claimed: 1, completed: 1, retry: 0 });
    const d = docOf(w, doc.id);
    const signed = w.db.files.get(d.final_path!)!;
    const signedPages = await pages(signed);
    expect(signedPages.length).toBeGreaterThan(2);
    expect(signedPages.join(" ")).toContain("Certificate of Completion");
    for (const text of signedPages) expect(text).toContain(`Vircle Secure Sign · ID ${doc.id}`);
    expect(verifySealed(signed).ok).toBe(true);
    // and the standalone certificate is made as well, naming THIS signed file (the one with the pages in it)
    const certificate = w.db.files.get(String(d.certificate_path))!;
    expect(verifySealed(certificate).ok).toBe(true);
    expect(squash((await pages(certificate)).join(" "))).toContain(String(d.final_sha256));
    expect(sha(signed)).toBe(d.final_sha256);
  }, 30_000);

  it("leaves the setting off for a workspace that never chose: no certificate pages in the signed file", async () => {
    const doc = await sealingDocument();
    expect(w.db.rows("sign_settings").find((s) => s.account_id === w.ctx.accountId)!.embed_certificate).toBeUndefined();
    await runSealing(base(), 4);
    expect((await pages(w.db.files.get(docOf(w, doc.id).final_path!)!)).length).toBe(2);
  }, 30_000);
});

describe("a failure while making or storing the certificate", () => {
  /** Storage that refuses what is written under /certificate/ (or lies about what it read back), as a full disk or a faulty bucket would. */
  function breakCertificateStorage(how: "write" | "readback") {
    const files = w.db.files;
    w.db.files = new (class extends Map<string, Uint8Array> {
      override set(key: string, value: Uint8Array) {
        if (how === "write" && key.includes("/certificate/")) throw new Error("disk full");
        return super.set(key, value);
      }
      override get(key: string) {
        const found = super.get(key);
        return how === "readback" && key.includes("/certificate/") && found ? new Uint8Array([...found, 0]) : found;
      }
    })(files);
    return () => {
      w.db.files = new Map(w.db.files);
    };
  }

  it.each(["write", "readback"] as const)("never completes the document without its certificate: nothing is recorded, the signed file stored a moment before is removed, the reason is kept, and the next attempt completes it with nothing left over (%s)", async (how) => {
    const doc = await sealingDocument();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repair = breakCertificateStorage(how);
    const first = await runSealing(base(), 4);
    expect(first).toMatchObject({ claimed: 1, completed: 0, retry: 1 });
    expect(first.errors?.[0]).toContain(how === "write" ? "disk full" : "does not match");
    // the database was never told: the document is still being sealed, with the reason kept and recorded
    expect(w.rpcs("sign_finish_sealing")).toHaveLength(0);
    expect(docOf(w, doc.id).status).toBe("sealing");
    expect(w.rpcs("sign_fail_sealing")).toHaveLength(1);
    expect(String(w.rpcs("sign_fail_sealing")[0].args.p_error)).toContain(how === "write" ? "disk full" : "does not match");
    // no completed state, no half-made files: only the file that was sent
    expect(w.db.rows("sign_document_files").filter((f) => f.kind === "signed" || f.kind === "certificate")).toHaveLength(0);
    expect([...w.db.files.keys()].filter((p) => p.includes("/final/") || p.includes("/certificate/"))).toEqual([]);
    expect(w.mail).toHaveLength(0);
    expect(rec.webhooks).not.toHaveBeenCalled();

    // the same retry the job makes: once storage works, the document completes with both files and exactly one of each is stored
    repair();
    await w.ctx.admin.rpc("sign_fail_sealing", { p_document: doc.id, p_error: "x" });
    docOf(w, doc.id).sealing_started_at = null;
    const second = await runSealing(base(), 4);
    expect(second).toEqual({ claimed: 1, completed: 1, retry: 0 });
    const d = docOf(w, doc.id);
    expect(d.status).toBe("completed");
    expect(w.db.files.has(String(d.certificate_path))).toBe(true);
    expect([...w.db.files.keys()].filter((p) => p.includes("/final/"))).toHaveLength(1);
    expect([...w.db.files.keys()].filter((p) => p.includes("/certificate/"))).toHaveLength(1);
    vi.restoreAllMocks();
  }, 30_000);

  it("fails and retries when the certificate cannot be SEALED, like any seal failure: the signed file stored a moment before is removed, nothing is recorded, nothing is sent, and the next attempt completes", async () => {
    const doc = await sealingDocument();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    seal.failOn = 2; // the signed file seals (1), the certificate does not (2)
    const first = await runSealing(base(), 4);
    expect(first).toMatchObject({ claimed: 1, completed: 0, retry: 1 });
    expect(first.errors?.[0]).toContain("seal number 2 failed");
    expect(w.rpcs("sign_finish_sealing")).toHaveLength(0);
    expect(docOf(w, doc.id).status).toBe("sealing");
    expect(w.rpcs("sign_fail_sealing")).toHaveLength(1);
    expect([...w.db.files.keys()].filter((p) => p.includes("/final/") || p.includes("/certificate/"))).toEqual([]);
    expect(w.mail).toHaveLength(0);
    // the next attempt (a new lease) seals both
    seal.failOn = 0;
    docOf(w, doc.id).sealing_started_at = null;
    expect(await runSealing(base(), 4)).toEqual({ claimed: 1, completed: 1, retry: 0 });
    expect(docOf(w, doc.id).certificate_path).toBeTruthy();
    vi.restoreAllMocks();
  }, 30_000);

  it("still holds a document for a certificate that has expired before anything is made (nothing is stored, no attempt is used)", async () => {
    const doc = await sealingDocument();
    w.db.tables["sign_certificates"] = [];
    const p12 = (await import("../pdf/p12")).createSelfSignedP12({ commonName: "Old seal", passphrase: "pw", bits: 1024, notBefore: new Date("2020-01-01T00:00:00Z"), years: 1 });
    const { encrypt } = await import("@/lib/whatsapp/encryption");
    w.db.seed("sign_certificates", [{ id: "old", account_id: w.ctx.accountId, name: "Uploaded: old", p12_enc: encrypt(Buffer.from(p12).toString("base64")), passphrase_enc: encrypt("pw"), valid_until: null, is_default: true, source: "uploaded" }]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = await runSealing(base(), 4);
    expect(run).toMatchObject({ claimed: 1, completed: 0, retry: 1 });
    expect(w.rpcs("sign_hold_sealing")).toHaveLength(1);
    expect(w.rpcs("sign_fail_sealing")).toHaveLength(0);
    expect(w.rpcs("sign_finish_sealing")).toHaveLength(0);
    expect(docOf(w, doc.id).status).toBe("sealing");
    expect([...w.db.files.keys()].filter((p) => p.includes("/final/") || p.includes("/certificate/"))).toEqual([]);
    vi.restoreAllMocks();
  }, 30_000);
});

describe("a document collection", () => {
  async function sealingCollection() {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    for (const id of ids) Object.assign(docOf(w, id), { status: "sealing", sent_at: "2026-10-06T02:00:00Z", base_sha256: "e".repeat(64) });
    for (const s of w.signerRows()) Object.assign(s, { status: "signed", signed_at: "2026-10-06T07:00:00Z", consented_at: "2026-10-06T06:59:00Z" });
    w.seedCertificate();
    return { envelope, ids };
  }

  it("stamps the collection's reference on the line of every page, names the collection and its size on each document's certificate, and sends ONE email each with every signed document and every certificate", async () => {
    const { envelope, ids } = await sealingCollection();
    expect(await runSealing(base(), 4)).toEqual({ claimed: 2, completed: 2, retry: 0 });
    for (const id of ids) {
      const d = docOf(w, id);
      for (const text of await pages(w.db.files.get(d.final_path!)!)) expect(text).toContain(`Vircle Secure Sign · ${envelope.reference} · ID ${id}`);
      const certificate = (await pages(w.db.files.get(String(d.certificate_path))!)).join(" ").toUpperCase();
      expect(certificate).toContain(`PART OF DOCUMENT COLLECTION ${envelope.reference} (DOCUMENT ${d.envelope_position} OF 2)`.toUpperCase());
    }
    for (const email of ["ali@kedai.example", "bala@kedai.example", SENDER_EMAIL]) {
      expect(to(email)).toHaveLength(1);
      expect(to(email)[0].attachments).toHaveLength(4);
      expect(to(email)[0].text).toContain("The 2 certificates are attached to this message as separate files.");
    }
  }, 60_000);

  it("is one zip ('Download all'): every signed document and its certificate, the 'Collection summary' PDF in front with each document's fingerprint and its signers; a download is recorded for each document", async () => {
    const { envelope, ids } = await sealingCollection();
    await runSealing(base(), 4);
    const { plan, extras, fileName } = await planEnvelopeZip(w.ctx, envelope.id);
    expect(fileName).toBe(`${envelope.reference}.zip`);
    const zip = await unzip(zipStream(w.ctx, plan, { extras }));
    const docs = ids.map((id) => docOf(w, id));
    const names = Object.keys(zip);
    expect(names).toHaveLength(5);
    expect(names[0]).toBe("Collection summary.pdf");
    for (const d of docs) {
      const signedName = names.find((n) => n.startsWith(String(d.reference)) && !n.includes("certificate"))!;
      const certificateName = names.find((n) => n.startsWith(String(d.reference)) && n.includes("certificate"))!;
      expect(signedName, d.reference!).toBeTruthy();
      expect(certificateName, d.reference!).toBeTruthy();
      expect(zip[signedName]).toEqual(w.db.files.get(d.final_path!));
      expect(zip[certificateName]).toEqual(w.db.files.get(String(d.certificate_path)));
    }
    // the summary names the collection, each document, the files and their fingerprints, and the signers
    const summary = (await pages(zip["Collection summary.pdf"])).join(" ");
    expect(summary).toContain("Collection summary");
    expect(summary).toContain(String(envelope.reference));
    expect(summary).toContain("Documents 2");
    for (const d of docs) {
      expect(summary).toContain(String(d.reference));
      expect(squash(summary)).toContain(String(d.final_sha256));
      expect(squash(summary)).toContain(String(d.certificate_sha256));
    }
    expect(summary).toContain("Ali");
    expect(summary).toContain("Bala");
    expect(strFromU8(zip["Collection summary.pdf"].subarray(0, 5))).toBe("%PDF-");
    // one downloaded event for each document
    expect(w.events("downloaded").map((e) => e.args.p_document).sort()).toEqual([...ids].sort());
  }, 60_000);

  it("leaves out a document that is not complete, says so in the note, and still zips the rest; refuses when none has a signed file", async () => {
    const { envelope, ids } = await sealingCollection();
    await runSealing(base(), 4);
    Object.assign(docOf(w, ids[1]), { status: "in_progress", final_path: null, final_sha256: null, certificate_path: null, certificate_sha256: null });
    const { plan, extras } = await planEnvelopeZip(w.ctx, envelope.id);
    const zip = await unzip(zipStream(w.ctx, plan, { extras }));
    expect(Object.keys(zip).filter((n) => n.endsWith(".pdf") && n !== "Collection summary.pdf")).toHaveLength(2);
    expect(strFromU8(zip["NOT-INCLUDED.txt"])).toContain(String(docOf(w, ids[1]).reference));
    Object.assign(docOf(w, ids[0]), { status: "in_progress", final_path: null, final_sha256: null });
    await expect(planEnvelopeZip(w.ctx, envelope.id)).rejects.toMatchObject({ code: "nothing_to_download", status: 409 });
  }, 60_000);

  it("is not offered to a person who may not see a private collection, as if it were not there", async () => {
    const { envelope } = await sealingCollection();
    await runSealing(base(), 4);
    Object.assign(w.db.rows("sign_envelopes")[0], { is_private: true, created_by: OTHER_USER });
    for (const d of w.docRows()) d.is_private = true;
    await expect(planEnvelopeZip(w.ctx, envelope.id)).rejects.toMatchObject({ code: "envelope_not_found", status: 404 });
    // an administrator or the system can
    await expect(planEnvelopeZip({ ...w.ctx, userId: null }, envelope.id)).resolves.toBeDefined();
  }, 60_000);

  it("gives a signer a zip of THEIR documents only, with a summary of those, and never a document they are not on", async () => {
    // a real send: Ali is on both documents, Bala on the first only
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY)] });
    await updateDraft(w.ctx, ids[1], { fields: [sig("a2", ALI_KEY)] });
    await sendEnvelope(w.ctx, envelope.id);
    w.seedCertificate();
    const anchor = (email: string) => w.signerRows().find((s) => s.email === email && s.id === s.party_id)!;
    const look = async (email: string) => (await lookupByToken(w.ctx.admin, w.tokens.get(anchor(email).id)))!;
    const meta = { ip: "203.0.113.9", device: "Chrome", locale: "en" as const };
    const sign = async (email: string, keys: Record<string, string[]>) => {
      await recordConsent(w.ctx, await look(email), "en", null, null);
      for (const [id, list] of Object.entries(keys)) for (const k of list) await saveAnswers(w.ctx, pickDocument(await look(email), id)!, { [k]: { typed: "X" } });
      return finishEnvelope(w.ctx, await look(email), {}, meta);
    };
    await sign("ali@kedai.example", { [ids[0]]: ["a1"], [ids[1]]: ["a2"] });
    await sign("bala@kedai.example", { [ids[0]]: ["b1"] });
    expect(await runSealing(base(), 4)).toEqual({ claimed: 2, completed: 2, retry: 0 });

    const bala = await look("bala@kedai.example");
    expect(bala.party?.members.map((m) => m.doc.id)).toEqual([ids[0]]);
    const zip = await zipForSigner(w.ctx, bala, true);
    expect(zip).not.toBeNull();
    expect(zip!.filename).toBe(`${envelope.reference}.zip`);
    const files = await unzip(zip!.stream);
    expect(Object.keys(files)).toHaveLength(3); // the summary, and the signed file and certificate of the first document
    const summary = (await pages(files["Collection summary.pdf"])).join(" ");
    expect(summary).toContain(String(docOf(w, ids[0]).reference));
    expect(summary).not.toContain(String(docOf(w, ids[1]).reference));
    expect(summary).not.toContain(String(docOf(w, ids[1]).final_sha256).slice(0, 20));
    // Ali is on both: all five files
    expect(Object.keys(await unzip((await zipForSigner(w.ctx, await look("ali@kedai.example"), true))!.stream))).toHaveLength(5);
    // not recorded as a person's download (the signed copy on a signer's page never was)
    expect(w.events("downloaded")).toHaveLength(0);
    // and the people's own per-document pages show a certificate for each completed document of theirs
    const view = await buildView(w.ctx, pickDocument(bala, ids[0])!, true);
    expect(view.envelope?.documents.map((d) => d.hasCertificate)).toEqual([true]);
  }, 90_000);
});

describe("downloads and the page that checks a document", () => {
  async function completedDocument() {
    const doc = await sealingDocument();
    await runSealing(base(), 4);
    return docOf(w, doc.id);
  }
  const lookupOf = async (documentId: string) => {
    const signer = w.signerRows().find((s) => s.document_id === documentId && s.email === "ali@kedai.example")!;
    w.tokens.set(signer.id, w.tokens.get(signer.id) ?? "a".repeat(64));
    // this document was made without a send, so its links were never issued: give Ali one
    const { hashToken } = await import("../tokens");
    w.db.seed("sign_signer_secrets", [{ signer_id: signer.id, account_id: w.ctx.accountId, token_hash: hashToken("a".repeat(64)), code_hash: null, code_expires_at: null, code_attempts: 0 }]);
    return (await lookupByToken(w.ctx.admin, "a".repeat(64)))!;
  };

  it("is one zip for a document: the signed document and its certificate, recorded as a download", async () => {
    const d = await completedDocument();
    const plan = await planZip(w.ctx, [d.id]);
    expect(plan.names?.get(d.id)).toEqual({ signed: expect.stringContaining(String(d.reference)), certificate: expect.stringContaining("certificate") });
    const zip = await unzip(zipStream(w.ctx, plan));
    expect(Object.keys(zip)).toHaveLength(2);
    expect(Object.values(zip).map(sha).sort()).toEqual([String(d.final_sha256), String(d.certificate_sha256)].sort());
    // the zip made from the list of documents carries the certificates too, and its size limit counts them
    expect(w.events("downloaded")).toHaveLength(1);
  }, 30_000);

  it("is the signed file only for a document sealed before the migration: its certificate is inside the signed PDF, and nothing more is offered", async () => {
    const d = await completedDocument();
    Object.assign(d, { certificate_path: null, certificate_sha256: null });
    const plan = await planZip(w.ctx, [d.id]);
    const zip = await unzip(zipStream(w.ctx, plan));
    expect(Object.keys(zip)).toHaveLength(1);
    await expect(fileForApi(w.ctx, d.id, "certificate")).rejects.toMatchObject({ code: "no_separate_certificate", status: 404 });
    const lookup = await lookupOf(d.id);
    expect(await certificateForSigner(w.ctx, lookup, true)).toBeNull();
    expect((await buildView(w.ctx, lookup, true)).document.hasCertificate).toBeUndefined();
    // the verify page says what it always said
    expect((await loadVerification(w.ctx.admin, d.id))?.certificate).toBeUndefined();
  }, 30_000);

  it("gives the API the certificate's bytes and fingerprint, refuses it before completion and for a private document, and logs the download", async () => {
    const d = await completedDocument();
    const file = await fileForApi(w.ctx, d.id, "certificate");
    expect(file).toMatchObject({ mime: "application/pdf", sha256: d.certificate_sha256 });
    expect(file.filename).toMatch(/-certificate\.pdf$/);
    expect(sha(file.bytes)).toBe(d.certificate_sha256);
    expect(w.events("downloaded").at(-1)?.args.p_detail).toMatchObject({ kind: "certificate" });
    // a key never sees a private document, whatever file it asks for
    d.is_private = true;
    await expect(fileForApi({ ...w.ctx, userId: null, via: "api_key:k1" }, d.id, "certificate")).rejects.toMatchObject({ status: 404 });
    d.is_private = false;
    d.status = "sealing";
    await expect(fileForApi(w.ctx, d.id, "certificate")).rejects.toMatchObject({ code: "not_completed", status: 409 });
  }, 30_000);

  it("gives the signer the certificate and the zip on their page, under the same rules as the signed copy (a code first, never a delegate)", async () => {
    const d = await completedDocument();
    const lookup = await lookupOf(d.id);
    const view = await buildView(w.ctx, lookup, true);
    expect(view.document.hasCertificate).toBe(true);
    const certificate = await certificateForSigner(w.ctx, lookup, true);
    expect(sha(certificate!.bytes)).toBe(d.certificate_sha256);
    expect(certificate!.filename).toBe(`${d.reference}-certificate.pdf`);
    expect(sha((await fileForSigner(w.ctx, lookup, true))!.bytes)).toBe(d.final_sha256);
    const zip = await unzip((await zipForSigner(w.ctx, lookup, true))!.stream);
    expect(Object.keys(zip)).toHaveLength(2);
    // a code is asked for first
    const coded = { ...lookup, doc: { ...lookup.doc, code_required: true } };
    expect(await certificateForSigner(w.ctx, coded, false)).toBeNull();
    expect(await zipForSigner(w.ctx, coded, false)).toBeNull();
    expect(await fileForSigner(w.ctx, coded, false)).toBeNull();
    expect(await certificateForSigner(w.ctx, coded, true)).not.toBeNull();
    // a person handed only a part of someone's form is given neither
    const delegate = { ...lookup, signer: { ...lookup.signer, part_keys: ["company"], delegated_by: "someone" } };
    expect(await certificateForSigner(w.ctx, delegate, true)).toBeNull();
    expect(await zipForSigner(w.ctx, delegate, true)).toBeNull();
    // nothing before the document is complete
    const sealing = { ...lookup, doc: { ...lookup.doc, status: "sealing" as const } };
    expect(await certificateForSigner(w.ctx, sealing, true)).toBeNull();
    expect(await zipForSigner(w.ctx, sealing, true)).toBeNull();
    // a link that is not an envelope's names no other document
    expect(pickDocument(lookup, d.id)).toBeNull();
  }, 30_000);

  it("tells the verify page the certificate's fingerprint and the name of the signed file it covers, and tells a document with an embedded certificate nothing new", async () => {
    const d = await completedDocument();
    w.db.tables["sign_documents"] = w.db.rows("sign_documents").map((r) => ({ ...r, completed_at: r.completed_at ?? "2026-10-06T08:00:00Z" }));
    w.db.rpcHandlers.sign_verify_chain = async () => ({ data: { ok: true, events: 3, head: "x" }, error: null });
    const view = await loadVerification(w.ctx.admin, d.id);
    expect(view?.sha256).toBe(d.final_sha256);
    expect(view?.certificate).toEqual({ sha256: d.certificate_sha256, signedFileName: `${d.reference}-signed.pdf` });
    // the verify page of a form names the record
    docOf(w, d.id).mode = "form";
    expect((await loadVerification(w.ctx.admin, d.id))?.certificate?.signedFileName).toBe(`${d.reference}-record.pdf`);
  }, 30_000);
});

describe("deletion and retention", () => {
  it("removes the certificate file with the document once its retention date has passed, even when only the document row names it", async () => {
    const doc = await sealingDocument();
    await runSealing(base(), 4);
    const d = docOf(w, doc.id);
    const certificatePath = String(d.certificate_path);
    const finalPath = String(d.final_path);
    expect(w.db.files.has(certificatePath)).toBe(true);
    // a file row that was lost: the document's own columns still name both files
    w.db.tables["sign_document_files"] = [];
    d.retain_until = "2020-01-01T00:00:00Z";
    await deleteDocument(w.ctx, d.id);
    expect(w.db.files.has(certificatePath)).toBe(false);
    expect(w.db.files.has(finalPath)).toBe(false);
    expect([...w.db.files.keys()].filter((p) => p.includes(`/${doc.id}/`))).toEqual([]);
  }, 30_000);

  it("keeps both files while the document is retained, and removes nothing when the database refuses", async () => {
    const doc = await sealingDocument();
    await runSealing(base(), 4);
    const d = docOf(w, doc.id);
    d.retain_until = "2099-01-01T00:00:00Z";
    await expect(deleteDocument(w.ctx, d.id)).rejects.toMatchObject({ code: "document_retained" });
    expect(w.db.files.has(String(d.certificate_path))).toBe(true);
    expect(w.db.files.has(String(d.final_path))).toBe(true);
    expect(w.db.rows("sign_document_files").filter((f) => f.kind === "certificate")).toHaveLength(1);
    void loadEnvelope;
    void loadEnvelopeDocuments;
  }, 30_000);
});
