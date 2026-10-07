import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlacedField } from "../pdf/types";
import { createDraftFromUpload, setSigners, updateDraft } from "./drafts";
import { finishEnvelope } from "./envelope-signing";
import { envelopeData, sendEnvelope, setEnvelopeSigners } from "./envelopes";
import { readinessProblems } from "./send";
import { ALI_KEY, BALA_KEY, docOf, makeWorld, signerIn, sig, uploadedCollection, type World } from "./people-world";
import { buildView, completeSigning, envelopeState, lookupByToken, pickDocument, recordConsent, saveAnswers, type Lookup } from "./signing";

// A signer's link must only ever sign THAT signer's blocks (the owner's real test of a collection of three PDFs and two people, Gokula and
// Gopala, said one link signed for both). These tests run the whole path through the real services: how send builds each person's rows and
// their role on each document, what each link is shown, and that the server refuses a field of another role whatever the browser sends.
// The database's own functions are stood in by envelope-fake.ts; the guard on the answers table is proved by verify-177.

vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

const GOKULA = "gokula@kedai.example";
const GOPALA = "gopala@kedai.example";
const meta = { ip: "203.0.113.9", device: "Chrome", locale: "en" as const };

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const anchorOf = (email: string) => w.signerRows().find((s) => s.email === email && s.id === s.party_id)!;
const look = async (email: string): Promise<Lookup> => {
  const token = w.tokens.get(anchorOf(email).id);
  expect(token).toBeTruthy();
  const found = await lookupByToken(w.ctx.admin, token);
  expect(found).not.toBeNull();
  return found!;
};
const status = (id: string) => w.docRows().find((d) => d.id === id)!.status;

/**
 * Three uploaded documents and two people who must sign:
 *   document 1: Gokula has two blocks (page 1 and page 2), Gopala one
 *   document 2: Gokula only
 *   document 3: Gopala only
 */
async function sentCollection() {
  const { envelope, ids } = await uploadedCollection(w, 3);
  await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Gokula Krishnan", GOKULA, ALI_KEY), signerIn("Gopala Krishnan", GOPALA, BALA_KEY)]);
  await updateDraft(w.ctx, ids[0], { fields: [sig("g1", ALI_KEY), sig("g1b", ALI_KEY, { page: 0, y: 0.5 }), sig("p1", BALA_KEY)] });
  await updateDraft(w.ctx, ids[1], { fields: [sig("g2", ALI_KEY)] });
  await updateDraft(w.ctx, ids[2], { fields: [sig("p3", BALA_KEY)] });
  await sendEnvelope(w.ctx, envelope.id);
  return { envelope, ids };
}

describe("how send builds each person's rows", () => {
  it("gives each person the role of their own key on every document they are on, and leaves them off a document with no block of theirs", async () => {
    const { ids } = await sentCollection();
    const rows = w.signerRows();
    const on = (email: string) => rows.filter((r) => r.email === email).map((r) => [ids.indexOf(r.document_id), r.role_key]).sort();
    expect(on(GOKULA)).toEqual([[0, ALI_KEY], [1, ALI_KEY]]);
    expect(on(GOPALA)).toEqual([[0, BALA_KEY], [2, BALA_KEY]]);
    // every row of a person carries the party of their own anchor, and no two people share one
    for (const email of [GOKULA, GOPALA]) {
      const a = anchorOf(email);
      expect(rows.filter((r) => r.email === email).every((r) => r.party_id === a.id)).toBe(true);
    }
    expect(anchorOf(GOKULA).party_id).not.toBe(anchorOf(GOPALA).party_id);
  });
});

describe("what a link is shown", () => {
  it("shows a person the blocks of their own role, the sender's text, and other people's blocks only once those people have answered them", async () => {
    const { ids } = await sentCollection();
    const view = await buildView(w.ctx, pickDocument(await look(GOKULA), ids[0])!, true);
    const keys = (view.content?.fields ?? []).map((f: PlacedField) => f.key).sort();
    // Gopala's block on this document is not part of what Gokula's page was given (it is not his, and nobody has signed it)
    expect(keys).toEqual(["g1", "g1b"]);
    expect(JSON.stringify(view)).not.toContain("p1");
  });

  it("shows the answers of a person who has signed, read only, on the next person's page", async () => {
    const { ids } = await sentCollection();
    await recordConsent(w.ctx, await look(GOKULA), "en", null, null);
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[0])!, { g1: { typed: "Gokula" }, g1b: { typed: "Gokula" } });
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[1])!, { g2: { typed: "Gokula" } });
    await finishEnvelope(w.ctx, await look(GOKULA), {}, meta);
    const view = await buildView(w.ctx, pickDocument(await look(GOPALA), ids[0])!, true);
    expect((view.content?.fields ?? []).map((f: PlacedField) => f.key).sort()).toEqual(["g1", "g1b", "p1"]);
    expect(Object.keys(view.content?.othersAnswers ?? {}).sort()).toEqual(["g1", "g1b"]);
    expect(Object.keys(view.content?.answers ?? {})).toEqual([]);
  });
});

describe("the server refuses a field that is not the caller's, whatever the browser sends", () => {
  it("rejects another person's key on a save, with not_your_field, and stores nothing for it", async () => {
    const { ids } = await sentCollection();
    await recordConsent(w.ctx, await look(GOKULA), "en", null, null);
    const lookup = pickDocument(await look(GOKULA), ids[0])!;
    const saved = await saveAnswers(w.ctx, lookup, { g1: { typed: "Gokula" }, p1: { typed: "Gokula pretending" } });
    expect(saved.saved).toEqual(["g1"]);
    expect(saved.rejected).toEqual([{ field: "p1", code: "not_your_field" }]);
    expect(w.db.rows("sign_answers").map((a) => a.field_key)).toEqual(["g1"]);
  });

  it("rejects another person's key sent with Finish (the answers of the finish call), signs nothing, and names the document", async () => {
    const { ids } = await sentCollection();
    await recordConsent(w.ctx, await look(GOKULA), "en", null, null);
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[0])!, { g1: { typed: "Gokula" }, g1b: { typed: "Gokula" } });
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[1])!, { g2: { typed: "Gokula" } });
    const err = await finishEnvelope(w.ctx, await look(GOKULA), { [ids[0]]: { p1: { typed: "Gokula pretending" } } }, meta).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid_answers", status: 400 });
    expect(err.issues).toContainEqual({ code: "not_your_field", field: "p1", document: ids[0] });
    expect(w.signerRows().filter((r) => r.status === "signed")).toHaveLength(0);
    expect(w.db.rows("sign_answers").some((a) => a.field_key === "p1")).toBe(false);
  });

  it("never lets a link reach a document its person is not on, or any answer keyed there", async () => {
    const { ids } = await sentCollection();
    const gokula = await look(GOKULA);
    // document 3 is Gopala's alone: Gokula's link finds nothing there, so there is no row to save an answer on
    expect(pickDocument(gokula, ids[2])).toBeNull();
    // an answer for document 3 sent with Finish is ignored (the call only walks the person's own documents)
    await recordConsent(w.ctx, gokula, "en", null, null);
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[0])!, { g1: { typed: "Gokula" }, g1b: { typed: "Gokula" } });
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[1])!, { g2: { typed: "Gokula" } });
    const done = await finishEnvelope(w.ctx, await look(GOKULA), { [ids[2]]: { p3: { typed: "Gokula pretending" } } }, meta);
    expect(done.completed).toEqual([ids[0], ids[1]]);
    expect(w.db.rows("sign_answers").some((a) => a.field_key === "p3")).toBe(false);
    expect(w.signerRows().filter((r) => r.email === GOPALA).every((r) => r.status === "sent")).toBe(true);
  });

  it("does not let a person finish with a block of their own role missing, even when another person's block is answered", async () => {
    const { ids } = await sentCollection();
    await recordConsent(w.ctx, await look(GOKULA), "en", null, null);
    // Gokula answers one of his two blocks on document 1; the second is required
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[0])!, { g1: { typed: "Gokula" } });
    const err = await completeSigning(w.ctx, pickDocument(await look(GOKULA), ids[0])!, {}, meta).catch((e) => e);
    expect(err).toMatchObject({ code: "missing_required" });
    expect(err.issues).toEqual([{ code: "missing_required", field: "g1b" }]);
  });
});

describe("one person finishing does not finish the other", () => {
  it("leaves the other person's rows open, and says the collection is waiting for them rather than that everyone has signed", async () => {
    const { ids } = await sentCollection();
    await recordConsent(w.ctx, await look(GOKULA), "en", null, null);
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[0])!, { g1: { typed: "Gokula" }, g1b: { typed: "Gokula" } });
    await saveAnswers(w.ctx, pickDocument(await look(GOKULA), ids[1])!, { g2: { typed: "Gokula" } });
    const done = await finishEnvelope(w.ctx, await look(GOKULA), {}, meta);
    expect(done).toEqual({ completed: [ids[0], ids[1]], remaining: [], sealing: true });
    // document 2 has only Gokula on it, so it is sealing; document 1 still waits for Gopala; document 3 is Gopala's
    expect([status(ids[0]), status(ids[1]), status(ids[2])]).toEqual(["in_progress", "sealing", "sent"]);
    expect(w.signerRows().filter((r) => r.email === GOPALA).map((r) => r.status)).toEqual(["sent", "sent"]);

    const view = await buildView(w.ctx, pickDocument(await look(GOKULA), ids[0])!, true);
    // Gokula's sitting is over, and the page must not read "everyone has signed" while Gopala still has to sign the first document
    expect(view.envelope?.documents.map((d) => d.state)).toEqual(["signed", "sealing"]);
    expect(view.envelope?.state).toBe("signed");
  });
});

describe("the state of a person's sitting", () => {
  it("is waiting (signed) while any document still waits for somebody else, sealing only when every document is being sealed or done", () => {
    expect(envelopeState(["signed", "sealing"])).toBe("signed");
    expect(envelopeState(["sealing", "completed", "signed"])).toBe("signed");
    expect(envelopeState(["sealing", "sealing"])).toBe("sealing");
    expect(envelopeState(["sealing", "completed"])).toBe("sealing");
    expect(envelopeState(["completed", "completed"])).toBe("completed");
    expect(envelopeState(["active", "sealing"])).toBe("active");
    expect(envelopeState(["failed", "signed"])).toBe("failed");
  });
});

describe("what the sender is told before sending", () => {
  it("refuses to send when a person has no block on any document (both blocks given to one person, the other never placed)", async () => {
    const { envelope, ids } = await uploadedCollection(w, 3);
    await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Gokula Krishnan", GOKULA, ALI_KEY), signerIn("Gopala Krishnan", GOPALA, BALA_KEY)]);
    // both signature blocks went to Gokula by accident
    await updateDraft(w.ctx, ids[0], { fields: [sig("g1", ALI_KEY), sig("g1b", ALI_KEY, { y: 0.5 })] });
    await updateDraft(w.ctx, ids[1], { fields: [sig("g2", ALI_KEY)] });
    const data = await envelopeData(w.ctx, envelope.id);
    // person index 1 (Gopala) has nothing to do on any document
    expect(data.problems).toContainEqual({ code: "person_without_work", detail: "1" });
    await expect(sendEnvelope(w.ctx, envelope.id)).rejects.toMatchObject({ code: "envelope_not_ready" });
    expect(w.docRows().every((d) => d.status === "draft")).toBe(true);
  });

  it("refuses a list where two people share an address, the same Halo user is not accepted as two people, and one person's role is never shared", async () => {
    const { envelope } = await uploadedCollection(w, 2);
    const twice = await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Gokula Krishnan", GOKULA, ALI_KEY), signerIn("Gopala Krishnan", "GOKULA@kedai.example", BALA_KEY)]).catch((e) => e);
    expect(twice).toMatchObject({ code: "bad_signers" });
    expect(twice.issues).toContainEqual({ code: "duplicate_person", detail: "1" });
    expect(w.signerRows()).toHaveLength(0);
  });
});

describe("two people on one role of a document", () => {
  it("is a problem before sending: both would be asked for the same places, and the sealed file would carry only the first one's answers", async () => {
    const alone = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Alone.pdf" });
    const id = alone.document.id;
    await updateDraft(w.ctx, id, { roles: [{ key: "buyer", label: "Buyer", kind: "signer", color: 0 }], fields: [sig("s", "buyer")] });
    const person = (name: string, email: string) => ({ fullName: name, email, channel: "email" as const, roleKey: "buyer", kind: "signer" as const, orderNo: 1 });
    await setSigners(w.ctx, id, [person("Gokula Krishnan", GOKULA), person("Gopala Krishnan", GOPALA)]);
    const problems = readinessProblems(docOf(w, id), w.signerRows().filter((r) => r.document_id === id));
    expect(problems).toContainEqual({ code: "role_shared", role: "buyer" });
    // one person on the role is fine
    await setSigners(w.ctx, id, [person("Gokula Krishnan", GOKULA)]);
    expect(readinessProblems(docOf(w, id), w.signerRows().filter((r) => r.document_id === id)).map((i) => i.code)).not.toContain("role_shared");
  });
});
