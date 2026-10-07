import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignRole } from "../types";
import { updateDraft } from "./drafts";
import { addEnvelopeDocuments, removeEnvelopeDocument, reorderEnvelopeDocuments } from "./envelope-documents";
import { createEnvelopeDraft, envelopeData, sendEnvelope, setEnvelopeSigners, updateEnvelope } from "./envelopes";
import { createDraftFromUpload } from "./drafts";
import { ALI_KEY, BALA_KEY, CARA_KEY, TPL_A, copyIn, docOf, makeWorld, signerIn, sig, uploadedCollection, type World } from "./people-world";

// The people model through the real services (migration 175): a person is a name, an email and a type; the roles of an uploaded document are the
// people's; at send a person signs only the documents they have a field on. The database's functions are stood in by envelope-fake.ts and its
// guards are proved by supabase/ci/verify-175-sign-copy-recipients.sql.

// the automation engine and the webhook delivery are recorders, as in envelope-flow.test.ts
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const rolesOf = (id: string) => docOf(w, id).roles_snapshot as SignRole[];
const rowsOn = (documentId: string) => w.signerRows().filter((s) => s.document_id === documentId);
const anchors = () => w.signerRows().filter((s) => s.id === s.party_id);

describe("setEnvelopeSigners on uploaded documents", () => {
  it("makes each person a role of every uploaded document (key = their key, label = their name, source people), with rows on each and the anchor on the first", async () => {
    const { envelope, ids } = await uploadedCollection(w, 3);
    const saved = await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    expect(saved).toHaveLength(6);
    for (const id of ids) {
      expect(rolesOf(id)).toEqual([
        { key: ALI_KEY, label: "Ali", kind: "signer", color: 0, source: "people" },
        { key: BALA_KEY, label: "Bala", kind: "signer", color: 1, source: "people" },
      ]);
      expect(rowsOn(id).map((r) => [r.email, r.role_key]).sort()).toEqual([["ali@kedai.example", ALI_KEY], ["bala@kedai.example", BALA_KEY]]);
    }
    // each person has one anchor, on the first document, whose id is the party id every other row of theirs carries
    expect(anchors().map((s) => [s.email, s.document_id]).sort()).toEqual([["ali@kedai.example", ids[0]], ["bala@kedai.example", ids[0]]]);
    for (const a of anchors()) expect(w.signerRows().filter((s) => s.email === a.email).every((s) => s.party_id === a.id)).toBe(true);
  });

  it("keeps the key and the fields assigned when a person is renamed, adds a role for a new person, and takes a removed person's role AND fields away", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY), sig("fee", "sender", { type: "static_text", text: "RM 1", required: false })] });
    await updateDraft(w.ctx, ids[1], { fields: [sig("a2", ALI_KEY)] });

    // rename: same key, the label moves, nothing is lost
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali bin Ahmad", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    expect(rolesOf(ids[0])[0]).toMatchObject({ key: ALI_KEY, label: "Ali bin Ahmad" });
    expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1", "b1", "fee"]);

    // a new person is a new role on every uploaded document, in their place
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali bin Ahmad", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY), signerIn("Cara", "cara@kedai.example", CARA_KEY)]);
    for (const id of ids) expect(rolesOf(id).map((r) => [r.key, r.color])).toEqual([[ALI_KEY, 0], [BALA_KEY, 1], [CARA_KEY, 2]]);
    expect(w.signerRows()).toHaveLength(6);

    // a removed person takes their role and the fields assigned to them off every uploaded document; the sender's static text stays
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali bin Ahmad", "ali@kedai.example", ALI_KEY), signerIn("Cara", "cara@kedai.example", CARA_KEY)]);
    for (const id of ids) expect(rolesOf(id).map((r) => r.key)).toEqual([ALI_KEY, CARA_KEY]);
    expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1", "fee"]);
    expect(docOf(w, ids[1]).fields_snapshot.map((f) => f.key)).toEqual(["a2"]);
    expect(w.signerRows().some((s) => s.email === "bala@kedai.example")).toBe(false);
  });

  it("gives a person who is sent with no key a key of their own, and two people who share a key different ones", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", ALI_KEY), signerIn("Cara", "cara@kedai.example"), signerIn("Dev", "dev@kedai.example", "not a key")]);
    const keys = rolesOf(ids[0]).map((r) => r.key);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe(ALI_KEY);
    for (const k of keys) expect(k).toMatch(/^pp_[a-z0-9]{4,36}$/);
  });

  it("keeps a template document's own roles and uses the mapping (`roles` by document id); an uploaded document's id in the mapping is ignored", async () => {
    const { envelope, ids } = await uploadedCollection(w, 1, [TPL_A]);
    const [upload, template] = ids;
    await setEnvelopeSigners(w.ctx, envelope.id, [
      signerIn("Ali", "ali@kedai.example", ALI_KEY, { roles: { [template]: "merchant", [upload]: "garbage" } }),
      signerIn("Bala", "bala@kedai.example", BALA_KEY, { roles: { [template]: "director" } }),
      signerIn("Cara", "cara@kedai.example", CARA_KEY),
    ]);
    expect(rolesOf(template).map((r) => r.key)).toEqual(["merchant", "director"]);
    expect(rolesOf(upload).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY, CARA_KEY]);
    expect(rowsOn(template).map((r) => [r.email, r.role_key]).sort()).toEqual([["ali@kedai.example", "merchant"], ["bala@kedai.example", "director"]]);
    expect(rowsOn(upload)).toHaveLength(3);
    // Cara has no role on the template: she is only on the uploaded file, and her anchor is there
    expect(w.signerRows().filter((s) => s.email === "cara@kedai.example")).toHaveLength(1);
    // the position of the upload is first, so every anchor is on it
    expect(anchors().every((s) => s.document_id === upload)).toBe(true);
  });

  it("refuses a template role that the document does not have, and two people in one template role, with the people and documents named", async () => {
    const { envelope, ids } = await uploadedCollection(w, 1, [TPL_A]);
    const err = await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { roles: { [ids[1]]: "ghost" } })]).catch((e) => e);
    expect(err).toMatchObject({ code: "bad_signers", status: 400 });
    expect(err.issues).toContainEqual({ code: "signer_role", detail: "0", document: ids[1], role: "ghost" });
    const twice = await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { roles: { [ids[1]]: "merchant" } }), signerIn("Bala", "bala@kedai.example", BALA_KEY, { roles: { [ids[1]]: "merchant" } })]).catch((e) => e);
    expect(twice.issues).toContainEqual({ code: "role_two_people", document: ids[1], role: "merchant" });
    expect(w.signerRows()).toHaveLength(0);
  });

  it("ignores a person of type copy: no role, no row, and the copy table is not touched", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    w.db.seed("sign_copy_recipients", [{ id: "cp1", account_id: "11111111-1111-4111-8111-111111111111", envelope_id: envelope.id, document_id: null, full_name: "Existing", email: "x@kedai.example", notified_at: null }]);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), copyIn("Cara", "cara@kedai.example", CARA_KEY)]);
    expect(rolesOf(ids[0]).map((r) => r.key)).toEqual([ALI_KEY]);
    expect(w.signerRows().some((s) => s.email === "cara@kedai.example")).toBe(false);
    expect(w.copyRows()).toHaveLength(1);
  });

  it("answers bad_signers for a list that is not sound (name, address, the same address twice), and writes nothing", async () => {
    const { envelope } = await uploadedCollection(w, 2);
    const bad = await setEnvelopeSigners(w.ctx, envelope.id, [signerIn(" ", "ali@kedai.example", ALI_KEY), signerIn("Bala", "nope", BALA_KEY), signerIn("Cara", "ali@kedai.example", CARA_KEY)]).catch((e) => e);
    expect(bad).toMatchObject({ code: "bad_signers", status: 400 });
    expect(bad.issues.map((i: { code: string; detail?: string }) => `${i.code}:${i.detail}`)).toEqual(expect.arrayContaining(["signer_name:0", "signer_email:1", "duplicate_person:2"]));
    expect(w.signerRows()).toHaveLength(0);
    const unwritten = w.db.rpcCalls.length;
    expect(unwritten).toBeGreaterThan(0);
  });

  it("refuses more than six people who must sign when the collection has an uploaded file (too_many_roles), but allows them when every document is a template's", async () => {
    const { envelope } = await uploadedCollection(w, 2);
    const seven = Array.from({ length: 7 }, (_, i) => signerIn(`Person ${i + 1}`, `p${i + 1}@kedai.example`, `pp_person0${i}`));
    const err = await setEnvelopeSigners(w.ctx, envelope.id, seven).catch((e) => e);
    expect(err).toMatchObject({ code: "bad_signers", issues: [{ code: "too_many_roles", detail: "6" }] });
    expect(w.signerRows()).toHaveLength(0);
    // six are fine, and a copy beside them is not a seventh
    await setEnvelopeSigners(w.ctx, envelope.id, [...seven.slice(0, 6), copyIn("Copy", "copy@kedai.example")]);
    expect(w.signerRows()).toHaveLength(12);
    // templates only: roles are the template's, so the people of a collection are not held to six
    const templates = await createEnvelopeDraft(w.ctx, { templateIds: [TPL_A, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] });
    const many = seven.map((p, i) => ({ ...p, roles: i === 0 ? { [templates.documents[0].id]: "merchant" } : {} }));
    await expect(setEnvelopeSigners(w.ctx, templates.envelope.id, many)).resolves.toBeDefined();
  });

  describe("a person still being filled in (incomplete)", () => {
    it("keeps their role and the fields assigned to it, saves no row for them, and completing them makes the row; leaving them out takes role and fields away", async () => {
      const { envelope, ids } = await uploadedCollection(w, 2);
      await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
      await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY)] });

      // Bala's address is being retyped: empty, flagged incomplete
      await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "", BALA_KEY, { incomplete: true })]);
      expect(rolesOf(ids[0]).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
      expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1", "b1"]);
      expect(w.signerRows().filter((s) => s.role_key === BALA_KEY)).toHaveLength(0);
      expect(w.signerRows().filter((s) => s.role_key === ALI_KEY)).toHaveLength(2);

      // finished: the row is back, on every document, with the anchor on the first
      await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
      expect(w.signerRows().filter((s) => s.role_key === BALA_KEY)).toHaveLength(2);
      expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1", "b1"]);

      // left out altogether: the role and the fields go
      await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
      expect(rolesOf(ids[0]).map((r) => r.key)).toEqual([ALI_KEY]);
      expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1"]);
    });

    it("does not check an incomplete person (a bad address is not an error yet) and ignores a new one with no name and no role", async () => {
      const { envelope, ids } = await uploadedCollection(w, 2);
      await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("", "", "pp_newperson", { incomplete: true }), signerIn("Bala", "not an address", BALA_KEY, { incomplete: true })]);
      // the nameless new person made no role; the half-typed Bala is a role (she has a name) but no row
      expect(rolesOf(ids[0]).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
      expect(w.signerRows().map((s) => s.email)).toEqual(["ali@kedai.example", "ali@kedai.example"]);
    });

    it("keeps the role of a nameless person when an uploaded document already holds it", async () => {
      const { envelope, ids } = await uploadedCollection(w, 2);
      await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
      await updateDraft(w.ctx, ids[0], { fields: [sig("b1", BALA_KEY)] });
      await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("", "", BALA_KEY, { incomplete: true })]);
      expect(rolesOf(ids[0]).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
      expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["b1"]);
    });

    it("counts the incomplete people toward the six roles", async () => {
      const { envelope } = await uploadedCollection(w, 2);
      const six = Array.from({ length: 6 }, (_, i) => signerIn(`Person ${i + 1}`, `p${i + 1}@kedai.example`, `pp_person0${i}`));
      const err = await setEnvelopeSigners(w.ctx, envelope.id, [...six, signerIn("Seven", "", "pp_person07", { incomplete: true })]).catch((e) => e);
      expect(err).toMatchObject({ code: "bad_signers", issues: [{ code: "too_many_roles", detail: "6" }] });
    });
  });
});

describe("updateDraft and the roles of a document of a collection", () => {
  it("does not take the roles for an uploaded document of a collection (they are the people's) and checks the fields against them", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
    const roles: SignRole[] = [{ key: "hacker", label: "Hacker", kind: "signer", color: 3 }];
    // roles alone: nothing changes
    await updateDraft(w.ctx, ids[0], { roles });
    expect(rolesOf(ids[0]).map((r) => r.key)).toEqual([ALI_KEY]);
    // roles and fields: the roles are ignored, the fields are valid against the people's
    const saved = await updateDraft(w.ctx, ids[0], { roles, fields: [sig("a1", ALI_KEY)] });
    expect(saved.roles_snapshot.map((r) => r.key)).toEqual([ALI_KEY]);
    expect(saved.fields_snapshot.map((f) => f.key)).toEqual(["a1"]);
    // a field on the role the editor sent is not valid: that role does not exist on this document
    await expect(updateDraft(w.ctx, ids[0], { roles, fields: [sig("h1", "hacker")] })).rejects.toMatchObject({ code: "invalid_layout", issues: [{ code: "unknown_role", role: "hacker" }] });
    expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1"]);
  });

  it("lets a role from before collections made roles from people be edited or deleted, but not added, and never the people's", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
    // a role made in the editor before this change (no `source`), held on the stored document
    const older: SignRole = { key: "role_1", label: "Old role", kind: "signer", color: 4 };
    const stored = docOf(w, ids[0]);
    stored.roles_snapshot = [...stored.roles_snapshot, older];
    // renaming it is taken; renaming the person's role is not; a role the document does not have is not added
    const renamed = await updateDraft(w.ctx, ids[0], {
      roles: [{ ...rolesOf(ids[0])[0], label: "Renamed by the editor" }, { ...older, label: "Renamed old" }, { key: "extra", label: "Extra", kind: "signer", color: 1 }],
    });
    expect(renamed.roles_snapshot.map((r) => [r.key, r.label, r.source])).toEqual([[ALI_KEY, "Ali", "people"], ["role_1", "Renamed old", undefined]]);
    // deleting it is taken
    const deleted = await updateDraft(w.ctx, ids[0], { roles: rolesOf(ids[0]).filter((r) => r.key !== "role_1") });
    expect(deleted.roles_snapshot.map((r) => r.key)).toEqual([ALI_KEY]);
  });

  it("still takes the roles of a template document of a collection and of a document on its own", async () => {
    const { ids } = await uploadedCollection(w, 1, [TPL_A]);
    const roles: SignRole[] = [{ key: "buyer", label: "Buyer", kind: "signer", color: 0 }];
    const templateDoc = await updateDraft(w.ctx, ids[1], { roles, fields: [sig("s", "buyer")] });
    expect(templateDoc.roles_snapshot.map((r) => r.key)).toEqual(["buyer"]);
    const alone = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Alone.pdf" });
    const updated = await updateDraft(w.ctx, alone.document.id, { roles, fields: [sig("s", "buyer")] });
    expect(updated.roles_snapshot.map((r) => r.key)).toEqual(["buyer"]);
  });
});

describe("changing the documents of a collection that has people", () => {
  it("gives a document added to the collection the people's roles and rows, and keeps every anchor on the first document", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY)] });
    const { added } = await addEnvelopeDocuments(w.ctx, envelope.id, { files: [w.file("Third.pdf")] });
    const third = added[0].id;
    expect(rolesOf(third).map((r) => [r.key, r.label, r.source])).toEqual([[ALI_KEY, "Ali", "people"], [BALA_KEY, "Bala", "people"]]);
    expect(rowsOn(third).map((r) => r.email).sort()).toEqual(["ali@kedai.example", "bala@kedai.example"]);
    expect(anchors().every((s) => s.document_id === ids[0])).toBe(true);
    // the fields already placed stay
    expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1"]);
  });

  it("gives a template added to the collection no row (nobody is matched to it yet) and keeps its own roles", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
    const { added } = await addEnvelopeDocuments(w.ctx, envelope.id, { templateIds: [TPL_A] });
    expect(rolesOf(added[0].id).map((r) => r.key)).toEqual(["merchant", "director"]);
    expect(rowsOn(added[0].id)).toHaveLength(0);
    expect(rowsOn(ids[0])).toHaveLength(1);
  });

  it("keeps the anchors right when a document is removed or the documents are reordered", async () => {
    const { envelope, ids } = await uploadedCollection(w, 3);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await reorderEnvelopeDocuments(w.ctx, envelope.id, [ids[2], ids[0], ids[1]]);
    expect(anchors().every((s) => s.document_id === ids[2])).toBe(true);
    expect(w.signerRows()).toHaveLength(6);
    await removeEnvelopeDocument(w.ctx, envelope.id, ids[2]);
    // (the fake database has no cascade, so the rows of the deleted document are looked past)
    const live = w.signerRows().filter((s) => [ids[0], ids[1]].includes(s.document_id));
    expect(live.filter((s) => s.id === s.party_id).map((s) => s.document_id)).toEqual([ids[0], ids[0]]);
    expect(live).toHaveLength(4);
    for (const id of [ids[0], ids[1]]) expect(rolesOf(id).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
  });

  it("does not lose a person who is still being filled in (and the fields assigned to them) when a document is added", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY), sig("b1", BALA_KEY)] });
    // Bala's address is being retyped: the screen saves her flagged incomplete (her role and fields stay, her rows do not)
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "", BALA_KEY, { incomplete: true })]);
    const { added } = await addEnvelopeDocuments(w.ctx, envelope.id, { files: [w.file("Third.pdf")] });
    expect(rolesOf(ids[0]).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
    expect(rolesOf(added[0].id).map((r) => r.key)).toEqual([ALI_KEY, BALA_KEY]);
    expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1", "b1"]);
    // and the same when a document is removed or the order changes
    await reorderEnvelopeDocuments(w.ctx, envelope.id, [added[0].id, ids[0], ids[1]]);
    await removeEnvelopeDocument(w.ctx, envelope.id, ids[1]);
    expect(docOf(w, ids[0]).fields_snapshot.map((f) => f.key)).toEqual(["a1", "b1"]);
  });
});

describe("what stands between a collection and Send (envelopeProblems, envelopeData)", () => {
  const codes = (problems: { code: string; detail?: string; document?: string }[]) => problems.map((p) => `${p.code}${p.detail !== undefined ? `:${p.detail}` : ""}${p.document ? `@${p.document.slice(0, 4)}` : ""}`);

  it("names a person with nothing assigned to them anywhere (person_without_work, by index) and a document nobody has anything to do on (document_nobody, tagged), and no no_signer for it", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    const bare = (await envelopeData(w.ctx, envelope.id)).problems;
    expect(bare.filter((p) => p.code === "document_nobody").map((p) => p.document)).toEqual(ids);
    expect(bare.filter((p) => p.code === "person_without_work").map((p) => p.detail)).toEqual(["0", "1"]);
    expect(bare.map((p) => p.code)).not.toContain("no_signer");

    // Ali has a signature on the first document: the first document is fine, the second still has nobody, and Bala has nothing
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY)] });
    const half = (await envelopeData(w.ctx, envelope.id)).problems;
    expect(half.filter((p) => p.code === "document_nobody").map((p) => p.document)).toEqual([ids[1]]);
    expect(half.filter((p) => p.code === "person_without_work").map((p) => p.detail)).toEqual(["1"]);
    expect(half.map((p) => p.code)).not.toContain("no_signer");
  });

  it("is happy when each person has work on some documents only", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY)] });
    await updateDraft(w.ctx, ids[1], { fields: [sig("b2", BALA_KEY)] });
    expect(codes((await envelopeData(w.ctx, envelope.id)).problems)).toEqual([]);
  });

  it("reports the copy recipients, which documents came from a template, and the fields each role completes", async () => {
    const { envelope, ids } = await uploadedCollection(w, 1, [TPL_A]);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY, { roles: { [ids[1]]: "merchant" } })]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY), sig("a2", ALI_KEY, { type: "text" }), sig("n", ALI_KEY, { type: "name", required: false })] });
    w.db.seed("sign_copy_recipients", [{ id: "cp1", account_id: "11111111-1111-4111-8111-111111111111", envelope_id: envelope.id, document_id: null, full_name: "Cara", email: "cara@kedai.example", notified_at: null }]);
    const data = await envelopeData(w.ctx, envelope.id);
    expect(data.copies.map((c) => c.email)).toEqual(["cara@kedai.example"]);
    expect(data.documents.map((d) => d.fromTemplate)).toEqual([false, true]);
    // a name field is written by the engine: it is not a field a person completes
    expect(data.documents[0].fieldCounts).toEqual({ [ALI_KEY]: 2 });
    expect(data.documents[1].fieldCounts).toEqual({ merchant: 1, director: 1 });
    expect(data.documents[0].rolesNeeded).toEqual([ALI_KEY]);
    expect(data.documents[1].rolesNeeded).toEqual(["merchant", "director"]);
    expect(codes(data.problems.filter((p) => p.code !== "role_without_person" && p.code !== "document_nobody"))).toEqual([]);
  });

  it("checks the copy recipients: the same address as a signer, and more than ten", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY)] });
    await updateDraft(w.ctx, ids[1], { fields: [sig("a2", ALI_KEY)] });
    const copy = (n: number, email: string) => ({ id: `cp${n}`, account_id: "11111111-1111-4111-8111-111111111111", envelope_id: envelope.id, document_id: null, full_name: `Copy ${n}`, email, notified_at: null, created_at: `2026-10-06T08:00:0${n % 10}Z` });
    w.db.seed("sign_copy_recipients", [copy(1, "ALI@kedai.example")]);
    expect(codes((await envelopeData(w.ctx, envelope.id)).problems)).toEqual(["duplicate_person:1"]);
    w.db.tables.sign_copy_recipients = Array.from({ length: 11 }, (_, i) => copy(i, `c${i}@kedai.example`));
    expect(codes((await envelopeData(w.ctx, envelope.id)).problems)).toEqual(["too_many_copies:10"]);
  });
});

describe("sendEnvelope: a person signs only the documents they have a field on", () => {
  async function threeDocuments(opts: { ordered?: boolean } = {}) {
    const { envelope, ids } = await uploadedCollection(w, 3);
    if (opts.ordered) await updateEnvelope(w.ctx, envelope.id, { signInOrder: true });
    await setEnvelopeSigners(w.ctx, envelope.id, [
      signerIn("Ali", "ali@kedai.example", ALI_KEY, { step: 1 }),
      signerIn("Bala", "bala@kedai.example", BALA_KEY, { step: opts.ordered ? 2 : 2 }),
      signerIn("Cara", "cara@kedai.example", CARA_KEY, { step: opts.ordered ? 3 : 3 }),
    ]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY)] });
    await updateDraft(w.ctx, ids[1], { fields: [sig("a2", ALI_KEY), sig("b2", BALA_KEY), sig("c2", CARA_KEY)] });
    await updateDraft(w.ctx, ids[2], { fields: [sig("a3", ALI_KEY), sig("c3", CARA_KEY)] });
    return { envelope, ids };
  }
  const shape = () => w.signerRows().map((s) => `${s.email}|${s.document_id.slice(0, 4)}|${s.role_key}|${s.order_no}|${s.id === s.party_id ? "anchor" : "row"}`).sort();

  it("drops a person's row from the documents with nothing for them, moves the anchor to their first remaining document, and sends one invitation and one link each", async () => {
    const { envelope, ids } = await threeDocuments();
    const result = await sendEnvelope(w.ctx, envelope.id);
    const rows = w.signerRows();
    expect(rows.filter((s) => s.email === "ali@kedai.example").map((s) => s.document_id).sort()).toEqual([...ids].sort());
    expect(rows.filter((s) => s.email === "bala@kedai.example").map((s) => s.document_id)).toEqual([ids[1]]);
    expect(rows.filter((s) => s.email === "cara@kedai.example").map((s) => s.document_id).sort()).toEqual([ids[1], ids[2]].sort());
    // an anchor each, on the person's first remaining document, and every row of a person carries their party id
    expect(anchors().map((s) => [s.email, s.document_id]).sort()).toEqual([["ali@kedai.example", ids[0]], ["bala@kedai.example", ids[1]], ["cara@kedai.example", ids[1]]]);
    for (const a of anchors()) expect(rows.filter((s) => s.email === a.email).every((s) => s.party_id === a.id)).toBe(true);
    // the database accepted it: every document is sent, and the people were told once each, with one link each
    expect(w.docRows().map((d) => d.status)).toEqual(["sent", "sent", "sent"]);
    expect(result.invited).toHaveLength(3);
    expect(w.mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example", "cara@kedai.example"]);
    expect(w.db.rows("sign_signer_secrets")).toHaveLength(3);
    // Bala's message names only the document she is on
    const bala = w.mail.find((m) => m.to === "bala@kedai.example")!;
    expect(bala.text).toContain("1. File 2");
    expect(bala.text).not.toContain("2. File");
  });

  it("keeps each person's step when a row is dropped", async () => {
    const { envelope } = await threeDocuments({ ordered: true });
    await sendEnvelope(w.ctx, envelope.id);
    const stepOf = (email: string) => [...new Set(w.signerRows().filter((s) => s.email === email).map((s) => s.order_no))];
    expect(stepOf("ali@kedai.example")).toEqual([1]);
    expect(stepOf("bala@kedai.example")).toEqual([2]);
    expect(stepOf("cara@kedai.example")).toEqual([3]);
    // only the first step was invited
    expect(w.mail.map((m) => m.to)).toEqual(["ali@kedai.example"]);
  });

  it("writes the original list back unchanged when the database refuses the send, and the next send then works", async () => {
    const { envelope } = await threeDocuments();
    const before = shape();
    const filesBefore = w.db.files.size;
    const real = w.db.rpcHandlers.sign_send_envelope;
    let refusals = 1;
    w.db.rpcHandlers.sign_send_envelope = async (a) => (refusals-- > 0 ? { data: null, error: { message: "database said no" } } : real(a));
    await expect(sendEnvelope(w.ctx, envelope.id)).rejects.toBeDefined();
    // the same people, on the same documents, in the same roles and steps, anchors on the first documents again
    expect(shape()).toEqual(before);
    expect(w.signerRows()).toHaveLength(9);
    expect(w.docRows().every((d) => d.status === "draft")).toBe(true);
    expect(w.db.files.size).toBe(filesBefore);
    expect(w.mail).toHaveLength(0);
    await sendEnvelope(w.ctx, envelope.id);
    expect(w.signerRows()).toHaveLength(6);
    expect(w.docRows().every((d) => d.status === "sent")).toBe(true);
  });

  it("refuses with plain envelope_not_ready issues before anything is written when a person or a document has nothing to do", async () => {
    const { envelope, ids } = await uploadedCollection(w, 2);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY), signerIn("Bala", "bala@kedai.example", BALA_KEY)]);
    await updateDraft(w.ctx, ids[0], { fields: [sig("a1", ALI_KEY)] });
    const before = shape();
    const filesBefore = w.db.files.size;
    const err = await sendEnvelope(w.ctx, envelope.id).catch((e) => e);
    expect(err).toMatchObject({ code: "envelope_not_ready", status: 400 });
    expect(err.issues).toEqual(expect.arrayContaining([{ code: "document_nobody", document: ids[1] }, { code: "person_without_work", detail: "1" }]));
    expect(w.rpcs("sign_send_envelope")).toHaveLength(0);
    expect(shape()).toEqual(before);
    expect(w.db.files.size).toBe(filesBefore);
    expect(w.mail).toHaveLength(0);
  });
});
