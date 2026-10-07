import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignRole } from "../types";
import { createDraftFromTemplate, createDraftFromUpload, updateDraft } from "./drafts";
import { setDocumentPeople } from "./document-people";
import { ALI_KEY, BALA_KEY, CARA_KEY, TPL_A, docOf, makeWorld, sig, signerIn, type World } from "./people-world";
import { readinessProblems } from "./send";
import { createEnvelopeDraft } from "./envelopes";

// The people of a document on its own, saved the way a collection's are (the one workflow of the sending screens): the people come BEFORE any
// signature block, so an uploaded file takes a role from each person who must sign and the rows of the signing list name a role it has. A
// document from a template keeps its own roles. Through the real services; the database's functions are stood in by envelope-fake.ts.

vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const upload = async () => (await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Lease.pdf" })).document.id;
const rolesOf = (id: string) => docOf(w, id).roles_snapshot as SignRole[];
const rowsOn = (id: string) => w.signerRows().filter((s) => s.document_id === id);

describe("setDocumentPeople on an uploaded file", () => {
  it("makes each person who must sign a role of the document (key, name, colour, source people) and a signing row for it, before any block is placed", async () => {
    const id = await upload();
    expect(rolesOf(id)).toEqual([]);
    const saved = await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    expect(saved.map((s) => [s.email, s.role_key])).toEqual([["ali@kedai.example", ALI_KEY], ["bala@kedai.example", BALA_KEY]]);
    expect(rolesOf(id)).toEqual([
      { key: ALI_KEY, label: "Ali", kind: "signer", color: 0, source: "people" },
      { key: BALA_KEY, label: "Bala", kind: "signer", color: 1, source: "people" },
    ]);
    // a row always names a role the document has
    for (const r of rowsOn(id)) expect(rolesOf(id).some((x) => x.key === r.role_key)).toBe(true);
  });

  it("keeps the key and the blocks when a person is renamed, and takes a removed person's role and blocks away", async () => {
    const id = await upload();
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY), signerIn("Cara", "cara@kedai.example", CARA_KEY)]);
    await updateDraft(w.ctx, id, { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY), sig("c1", CARA_KEY), sig("fee", "sender", { type: "static_text", text: "RM 1", required: false })] });

    await setDocumentPeople(w.ctx, id, [signerIn("Ali bin Ahmad", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY), signerIn("Cara", "cara@kedai.example", CARA_KEY)]);
    expect(rolesOf(id)[0]).toMatchObject({ key: ALI_KEY, label: "Ali bin Ahmad" });
    expect(docOf(w, id).fields_snapshot.map((f) => f.key)).toEqual(["a1", "b1", "c1", "fee"]);

    await setDocumentPeople(w.ctx, id, [signerIn("Ali bin Ahmad", "ali@kedai.example", ALI_KEY), signerIn("Cara", "cara@kedai.example", CARA_KEY)]);
    expect(rolesOf(id).map((r) => r.key)).toEqual([ALI_KEY, CARA_KEY]);
    // the colour is the person's place in the list, so no two share one
    expect(rolesOf(id).map((r) => r.color)).toEqual([0, 1]);
    expect(docOf(w, id).fields_snapshot.map((f) => f.key)).toEqual(["a1", "c1", "fee"]);
    expect(rowsOn(id).map((r) => r.email)).toEqual(["ali@kedai.example", "cara@kedai.example"]);
  });

  it("keeps the role (and the blocks assigned to it) of a person still being filled in, and saves nothing else of them", async () => {
    const id = await upload();
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, id, { fields: [sig("b1", BALA_KEY)] });
    // Bala's address is being retyped: not saved as a signer now, but the role and the block stay
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@", BALA_KEY, { incomplete: true })]);
    expect(rolesOf(id).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
    expect(docOf(w, id).fields_snapshot.map((f) => f.key)).toEqual(["b1"]);
    expect(rowsOn(id).map((r) => r.email)).toEqual(["ali@kedai.example"]);
    // a new blank person with no role yet is ignored altogether
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("", "", "pp_newperson1", { incomplete: true })]);
    expect(rolesOf(id).map((r) => r.key)).toEqual([ALI_KEY]);
  });

  it("refuses a list that is not sound with the people it is about, and changes nothing", async () => {
    const id = await upload();
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
    await expect(setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Ali again", "ALI@kedai.example", BALA_KEY)])).rejects.toMatchObject({ code: "bad_signers" });
    await expect(setDocumentPeople(w.ctx, id, [signerIn("Ali", "not an email", ALI_KEY)])).rejects.toMatchObject({ code: "bad_signers" });
    const seven = Array.from({ length: 7 }, (_, i) => signerIn(`P${i}`, `p${i}@kedai.example`));
    await expect(setDocumentPeople(w.ctx, id, seven)).rejects.toMatchObject({ code: "bad_signers" });
    expect(rolesOf(id).map((r) => r.key)).toEqual([ALI_KEY]);
    expect(rowsOn(id)).toHaveLength(1);
  });

  it("uses the order the screen has (without waiting for the document's own setting) and carries a Halo user", async () => {
    const id = await upload();
    const saved = await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { step: 2 }), signerIn("Bala", "bala@kedai.example", BALA_KEY, { step: 1 })], { ordered: true });
    expect(saved.map((s) => [s.email, s.order_no]).sort()).toEqual([["ali@kedai.example", 2], ["bala@kedai.example", 1]]);
    const unordered = await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { step: 2 }), signerIn("Bala", "bala@kedai.example", BALA_KEY, { step: 1 })], { ordered: false });
    expect(unordered.map((s) => s.order_no)).toEqual([1, 2]);
  });

  it("is what makes the document sendable: a person with a block has nothing wrong, a person with none is named", async () => {
    const id = await upload();
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, id, { fields: [sig("a1", ALI_KEY)] });
    const problems = (readinessProblems(docOf(w, id), rowsOn(id)) ?? []).map((p) => p.code);
    expect(problems).toContain("signer_without_signature");
    await updateDraft(w.ctx, id, { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY)] });
    expect(readinessProblems(docOf(w, id), rowsOn(id))).toEqual([]);
  });

  it("locks the people's roles against the editor once there are any, and still takes a document with none as it always did", async () => {
    const id = await upload();
    // no people yet: the layout is taken as sent (the sending screens never send a role; the editor shows none to add)
    await updateDraft(w.ctx, id, { roles: [{ key: "signer1", label: "Signer", kind: "signer", color: 4 }], fields: [sig("s1", "signer1")] });
    expect(rolesOf(id).map((r) => r.key)).toEqual(["signer1"]);
    // the person takes over a role the document already had (the key is the same): the role is then the person's, its blocks stay
    await setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example", "signer1")]);
    expect(rolesOf(id)).toEqual([{ key: "signer1", label: "Ali", kind: "signer", color: 0, source: "people" }]);
    expect(docOf(w, id).fields_snapshot.map((f) => f.key)).toEqual(["s1"]);
    // from here a role the editor invents is not taken, and a person's role cannot be renamed from there
    await updateDraft(w.ctx, id, { roles: [{ key: "signer1", label: "Renamed", kind: "signer", color: 3 }, { key: "extra", label: "Extra", kind: "signer", color: 2 }], fields: [sig("s1", "signer1")] });
    expect(rolesOf(id)).toEqual([{ key: "signer1", label: "Ali", kind: "signer", color: 0, source: "people" }]);
  });
});

describe("setDocumentPeople on a document from a template", () => {
  it("keeps the template's roles and gives each person the role they are matched to, and leaves the fields alone", async () => {
    const doc = await createDraftFromTemplate(w.ctx, { templateId: TPL_A });
    const before = docOf(w, doc.id).fields_snapshot;
    const saved = await setDocumentPeople(w.ctx, doc.id, [signerIn("Ali", "ali@kedai.example", undefined, { roles: { [doc.id]: "merchant" } }), signerIn("Bala", "bala@kedai.example", undefined, { roles: { [doc.id]: "director" } })]);
    expect(saved.map((s) => [s.email, s.role_key])).toEqual([["ali@kedai.example", "merchant"], ["bala@kedai.example", "director"]]);
    expect(rolesOf(doc.id)).toEqual([{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }, { key: "director", label: "Director", kind: "signer", color: 1 }]);
    expect(docOf(w, doc.id).fields_snapshot).toEqual(before);
    // taking a person off the list takes only their row
    await setDocumentPeople(w.ctx, doc.id, [signerIn("Ali", "ali@kedai.example", undefined, { roles: { [doc.id]: "merchant" } })]);
    expect(rowsOn(doc.id).map((r) => r.role_key)).toEqual(["merchant"]);
    expect(docOf(w, doc.id).fields_snapshot).toEqual(before);
  });

  it("refuses two people in one role, and a role the template does not have", async () => {
    const doc = await createDraftFromTemplate(w.ctx, { templateId: TPL_A });
    await expect(setDocumentPeople(w.ctx, doc.id, [signerIn("Ali", "ali@kedai.example", undefined, { roles: { [doc.id]: "merchant" } }), signerIn("Bala", "bala@kedai.example", undefined, { roles: { [doc.id]: "merchant" } })])).rejects.toMatchObject({ code: "bad_signers" });
    await expect(setDocumentPeople(w.ctx, doc.id, [signerIn("Ali", "ali@kedai.example", undefined, { roles: { [doc.id]: "nobody" } })])).rejects.toMatchObject({ code: "bad_signers" });
  });
});

describe("setDocumentPeople refuses what is not a draft on its own", () => {
  it("a document of a collection (409), and an unknown document (404)", async () => {
    const { documents } = await createEnvelopeDraft(w.ctx, { templateIds: [], files: [w.file("a.pdf"), w.file("b.pdf")] });
    await expect(setDocumentPeople(w.ctx, documents[0].id, [signerIn("Ali", "ali@kedai.example")])).rejects.toMatchObject({ code: "document_in_envelope", status: 409 });
    await expect(setDocumentPeople(w.ctx, "00000000-0000-4000-8000-00000000dead", [])).rejects.toMatchObject({ status: 404 });
  });

  it("a document that was sent", async () => {
    const id = await upload();
    const row = w.docRows().find((d) => d.id === id)!;
    row.status = "sent";
    await expect(setDocumentPeople(w.ctx, id, [signerIn("Ali", "ali@kedai.example")])).rejects.toMatchObject({ code: "document_not_draft", status: 409 });
  });
});
