import { beforeEach, describe, expect, it, vi } from "vitest";

import { peopleFromSigners } from "../client/envelope-form";
import { hashToken } from "../tokens";
import type { SignSignerRow } from "../types";
import { createDraftFromUpload, updateDraft } from "./drafts";
import { setDocumentPeople } from "./document-people";
import { setEnvelopeSigners } from "./envelopes";
import { ALI_KEY, BALA_KEY, docOf, makeWorld, sig, signerIn, uploadedCollection, type World } from "./people-world";
import { readinessProblems, remindSigner, sendDocument, sharedRoles, voidDocument } from "./send";
import { buildView, completeSigning, lookupByToken, otherPlaces, pageState, recordConsent, saveAnswers } from "./signing";
import { valuesFor } from "./seal";

// Someone who can sign instead of a person (migration 187), through the real services with the database's functions stood in by envelope-fake.ts
// (the functions themselves are proved by supabase/ci/verify-187-sign-alternate-signers.sql): the pair is saved as two rows of one role, both are
// invited, the first to complete the role signs, the other is told it was already done, and the document does not wait for them.

vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

let w: World;
let tokens: Map<string, string>;

const SITI = { fullName: "Siti Finance", email: "siti@kedai.example" };

beforeEach(async () => {
  w = await makeWorld();
  tokens = new Map();
  const secrets = (w.db.tables.sign_signer_secrets ??= []);
  w.db.rpcHandlers.sign_send_document = async (args) => {
    const doc = w.docRows().find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: "sent", base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at, sent_at: "2026-10-06T08:00:00Z" });
    const people = w.signerRows().filter((s) => s.document_id === args.p_document);
    const invited = people.map((s, i) => {
      const token = `${i + 1}`.repeat(64).slice(0, 64);
      tokens.set(s.id, token);
      Object.assign(s, { status: "sent", invited_at: "2026-10-06T08:00:00Z" });
      secrets.push({ signer_id: s.id, account_id: s.account_id, token_hash: hashToken(token), code_hash: null, code_expires_at: null, code_attempts: 0 });
      return { signer_id: s.id, token, name: s.full_name, email: s.email, phone: null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no };
    });
    return { data: { reference: doc.reference, invited }, error: null };
  };
  w.db.rpcHandlers.sign_record_consent = async (a) => {
    Object.assign(w.signerRows().find((s) => s.id === a.p_signer)!, { consented_at: "2026-10-06T08:01:00Z", consent_version: a.p_version });
    return { data: true, error: null };
  };
  w.db.rpcHandlers.sign_void_document = async (a) => {
    const doc = w.docRows().find((d) => d.id === a.p_document)!;
    doc.status = "voided";
    return { data: {}, error: null };
  };
});

const upload = async () => (await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Lease.pdf" })).document.id;
const rowsOn = (id: string) => w.signerRows().filter((s) => s.document_id === id);
const byEmail = (id: string, email: string) => rowsOn(id).find((s) => s.email === email)!;

/** A sent document: Ali (with Siti who can sign instead) and Bala, each with a signature to place. */
async function sentWithAlternate() {
  const id = await upload();
  await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { alternate: SITI }), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
  await updateDraft(w.ctx, id, { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY)] });
  await sendDocument(w.ctx, id);
  return id;
}

const look = async (signerId: string) => (await lookupByToken(w.ctx.admin, tokens.get(signerId)))!;
const meta = { ip: null, device: null, locale: "en" };

async function complete(id: string, email: string) {
  const row = byEmail(id, email);
  const lookup = await look(row.id);
  await recordConsent(w.ctx, lookup, "en", null, null);
  const fresh = await look(row.id);
  const key = row.role_key === ALI_KEY ? "a1" : "b1";
  return completeSigning(w.ctx, fresh, { [key]: { typed: row.full_name } }, meta);
}

describe("naming someone who can sign instead", () => {
  it("saves two rows of one role, the second pointing at the first in the same step, and gives them back as one person", async () => {
    const id = await upload();
    const saved = await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { alternate: SITI }), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    expect(saved).toHaveLength(3);
    const ali = byEmail(id, "ali@kedai.example");
    const siti = byEmail(id, "siti@kedai.example");
    expect(siti).toMatchObject({ role_key: ALI_KEY, kind: "signer", alternate_of: ali.id, order_no: ali.order_no, channel: "email" });
    expect(ali.alternate_of ?? null).toBeNull();
    // the role is the first person's: the alternate is not a role of their own, and there is one role for each person
    expect(docOf(w, id).roles_snapshot.map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
    // read back for the People step: one person with someone who can sign instead
    const people = peopleFromSigners(rowsOn(id));
    expect(people.map((p) => [p.fullName, p.alternate?.email ?? null])).toEqual([["Ali", "siti@kedai.example"], ["Bala", null]]);
    // saving again without the alternate removes the row
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    expect(rowsOn(id).map((s) => s.email)).toEqual(["ali@kedai.example", "bala@kedai.example"]);
  });

  it("is sendable as it is, and two people on one role that are not an alternate and their first person still are not", async () => {
    const id = await upload();
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { alternate: SITI }), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, id, { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY)] });
    expect(readinessProblems(docOf(w, id), rowsOn(id))).toEqual([]);
    expect(sharedRoles(rowsOn(id))).toEqual([]);

    const siti = byEmail(id, "siti@kedai.example");
    // not an alternate (what the public API could make): refused as before
    expect(readinessProblems(docOf(w, id), rowsOn(id).map((s) => (s.id === siti.id ? { ...s, alternate_of: null } : s))).map((p) => p.code)).toContain("role_shared");
    // a third person on the role, an alternate of nobody, the same address, a Halo user, another step: all refused
    const extra = { ...siti, id: "x1", email: "third@kedai.example", alternate_of: null } as SignSignerRow;
    expect(sharedRoles([...rowsOn(id), extra])).toEqual([ALI_KEY]);
    expect(sharedRoles(rowsOn(id).map((s) => (s.id === siti.id ? { ...s, email: "ALI@kedai.example" } : s)))).toEqual([ALI_KEY]);
    expect(sharedRoles(rowsOn(id).map((s) => (s.id === siti.id ? { ...s, internal_user_id: "u1" } : s)))).toEqual([ALI_KEY]);
    expect(sharedRoles(rowsOn(id).map((s) => (s.id === siti.id ? { ...s, order_no: 9 } : s)))).toEqual([ALI_KEY]);
  });

  it("refuses a list whose alternate is half typed, repeats an address, or belongs to a Halo user, and changes nothing", async () => {
    const id = await upload();
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
    const bad = (alternate: { fullName: string; email: string }, over = {}) => setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { alternate, ...over }), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await expect(bad({ fullName: "", email: "siti@kedai.example" })).rejects.toMatchObject({ code: "bad_signers", issues: [{ code: "alternate_name", detail: "0" }] });
    await expect(bad({ fullName: "Siti", email: "siti@" })).rejects.toMatchObject({ code: "bad_signers", issues: [{ code: "alternate_email", detail: "0" }] });
    await expect(bad({ fullName: "Siti", email: "BALA@kedai.example" })).rejects.toMatchObject({ code: "bad_signers", issues: expect.arrayContaining([expect.objectContaining({ code: "duplicate_person" })]) });
    await expect(bad({ fullName: "Siti", email: "ALI@kedai.example" })).rejects.toMatchObject({ code: "bad_signers", issues: [{ code: "alternate_duplicate", detail: "0" }] });
    await expect(bad({ fullName: "Siti", email: "siti@kedai.example" }, { internalUserId: "33333333-3333-4333-8333-333333333333" })).rejects.toMatchObject({ code: "bad_signers" });
    expect(rowsOn(id).map((s) => s.email)).toEqual(["ali@kedai.example"]);
  });

  it("is for a document on its own: a document collection refuses it", async () => {
    const { envelope } = await uploadedCollection(w);
    await expect(setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { alternate: SITI })])).rejects.toMatchObject({ code: "bad_signers", issues: [{ code: "alternate_not_here" }] });
    expect(w.signerRows()).toHaveLength(0);
  });
});

describe("whoever completes the role first signs", () => {
  it("invites both people with a link each, and the page of each says there is another", async () => {
    const id = await sentWithAlternate();
    const ali = byEmail(id, "ali@kedai.example");
    const siti = byEmail(id, "siti@kedai.example");
    expect([ali.status, siti.status]).toEqual(["sent", "sent"]);
    expect(tokens.get(ali.id)).not.toBe(tokens.get(siti.id));
    expect(w.mail.filter((m) => /siti@|ali@/.test(m.to)).map((m) => m.to).sort()).toEqual(["ali@kedai.example", "siti@kedai.example"]);
    const view = await buildView(w.ctx, await look(ali.id), true);
    expect(view.alternate).toEqual({ name: "Siti Finance" });
    // the twin is the same place on the document, never "somebody else we are waiting for"
    expect(view.content?.others.map((o) => o.name)).toEqual(["Bala"]);
  });

  it("marks the other person not needed, gives them the friendly page and no files, and refuses everything they try", async () => {
    const id = await sentWithAlternate();
    const ali = byEmail(id, "ali@kedai.example");
    const siti = byEmail(id, "siti@kedai.example");
    const aliLookup = await look(ali.id);
    await recordConsent(w.ctx, aliLookup, "en", null, null);
    await saveAnswers(w.ctx, await look(ali.id), { a1: { typed: "Ali" } });

    const out = await complete(id, "siti@kedai.example");
    expect(out.sealing).toBe(false);
    expect(siti.status).toBe("signed");
    expect(ali.status).toBe("not_needed");
    expect(w.events("alternate_not_needed")).toHaveLength(1);
    expect(w.events("alternate_not_needed")[0].args).toMatchObject({ p_detail: { completed_by: siti.id, completed_by_name: "Siti Finance" } });

    // the friendly page: not a decline, not an error; nothing of the document, not even a code
    const gone = await look(ali.id);
    expect(pageState(gone.doc, gone.signer)).toBe("completed_by_other");
    const view = await buildView(w.ctx, gone, false);
    expect(view).toMatchObject({ state: "completed_by_other", needsCode: false, needsConsent: false, content: null, signer: { status: "not_needed" } });
    // what they try is refused as "completed by someone else"
    await expect(saveAnswers(w.ctx, gone, { a1: { typed: "Ali" } })).rejects.toMatchObject({ code: "completed_by_other", status: 409 });
    await expect(completeSigning(w.ctx, gone, { a1: { typed: "Ali" } }, meta)).rejects.toMatchObject({ code: "completed_by_other", status: 409 });
    // the answer they typed is still there, and it is not what is sealed (the signature on the place is the one who completed it)
    const answers = w.db.rows("sign_answers") as unknown as { signer_id: string; field_key: string; value: unknown }[];
    expect(answers.find((a) => a.signer_id === ali.id && a.field_key === "a1")).toBeTruthy();
    const values = valuesFor(docOf(w, id).fields_snapshot, rowsOn(id), answers as never);
    expect(values.a1).toEqual({ typed: "Siti Finance" });
  });

  it("does not wait for them: the document seals when the other roles are done, and a void or an expiry does not write to them", async () => {
    const id = await sentWithAlternate();
    await complete(id, "siti@kedai.example");
    const mailBefore = w.mail.length;
    // nobody is "waited for" among the people who are not needed: a reminder to them is refused by the database (stood in here by the status rule)
    const ali = byEmail(id, "ali@kedai.example");
    w.db.rpcHandlers.sign_rotate_token = async (a) => {
      const s = w.signerRows().find((x) => x.id === a.p_signer)!;
      return s.status === "sent" || s.status === "viewed" ? { data: { signer_id: s.id, token: "f".repeat(64), name: s.full_name, email: s.email, phone: null, channel: "email", role_key: s.role_key, kind: s.kind, order_no: s.order_no }, error: null } : { data: null, error: { message: "signer_not_open" } };
    };
    await expect(remindSigner(w.ctx, id, ali.id)).rejects.toMatchObject({ code: "signer_not_open" });
    expect(w.mail.length).toBe(mailBefore);

    // the sender cancels while Bala is still to sign: Bala is told, the person who was not needed is not
    await voidDocument(w.ctx, id, "changed our minds");
    const told = w.mail.slice(mailBefore).map((m) => m.to);
    expect(told).toContain("bala@kedai.example");
    expect(told).not.toContain("ali@kedai.example");
    expect(told).not.toContain("siti@kedai.example");
  });

  it("seals when the last other person is done, and the signer lists name who signed and who did not need to", async () => {
    const id = await sentWithAlternate();
    await complete(id, "siti@kedai.example");
    const done = await complete(id, "bala@kedai.example");
    expect(done.sealing).toBe(true);
    expect(docOf(w, id).status).toBe("sealing");
    expect(rowsOn(id).map((s) => `${s.email}:${s.status}`).sort()).toEqual(["ali@kedai.example:not_needed", "bala@kedai.example:signed", "siti@kedai.example:signed"]);
  });

  it("lets only one of two people who submit in the same moment complete it", async () => {
    const id = await sentWithAlternate();
    for (const email of ["ali@kedai.example", "siti@kedai.example"]) {
      const row = byEmail(id, email);
      await recordConsent(w.ctx, await look(row.id), "en", null, null);
    }
    const ali = await look(byEmail(id, "ali@kedai.example").id);
    const siti = await look(byEmail(id, "siti@kedai.example").id);
    const results = await Promise.allSettled([completeSigning(w.ctx, ali, { a1: { typed: "Ali" } }, meta), completeSigning(w.ctx, siti, { a1: { typed: "Siti" } }, meta)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "completed_by_other", status: 409 });
    const pair = rowsOn(id).filter((s) => s.role_key === ALI_KEY);
    expect(pair.map((s) => s.status).sort()).toEqual(["not_needed", "signed"]);
    expect(w.rpcs("sign_complete_signer")).toHaveLength(2);
  });
});

describe("the page of a person who was not needed", () => {
  it("is the friendly page whatever the document does next, unless it ended some other way", () => {
    const signer = { status: "not_needed" } as SignSignerRow;
    const state = (status: string) => pageState({ status } as never, signer);
    for (const s of ["sent", "in_progress", "sealing", "completed", "failed"]) expect(state(s)).toBe("completed_by_other");
    for (const s of ["declined", "expired", "voided"]) expect(state(s)).toBe(s);
    // everybody else is as they were
    expect(pageState({ status: "sent" } as never, { status: "sent" } as SignSignerRow)).toBe("active");
    expect(pageState({ status: "sealing" } as never, { status: "signed" } as SignSignerRow)).toBe("sealing");
  });

  it("lists the other places on the document once each, the one who completed a role standing for it", () => {
    const row = (id: string, role: string, status: string, over: Partial<SignSignerRow> = {}) => ({ id, role_key: role, status, full_name: id, part_keys: null, alternate_of: null, ...over }) as SignSignerRow;
    const rows = [row("me", "r1", "sent"), row("twin", "r1", "sent", { alternate_of: "me" }), row("p", "r2", "not_needed"), row("a", "r2", "signed", { alternate_of: "p" }), row("c", "r3", "sent")];
    expect(otherPlaces(rows, rows[0]).map((s) => s.id)).toEqual(["a", "c"]);
    // without an alternate nothing changes
    const plain = [row("me", "r1", "sent"), row("x", "r2", "signed"), row("y", "r3", "sent")];
    expect(otherPlaces(plain, plain[0]).map((s) => s.id)).toEqual(["x", "y"]);
  });
});
