import { beforeEach, describe, expect, it } from "vitest";

import { createDraftFromUpload, setSigners } from "./drafts";
import { addCopyRecipient, listCopyRecipients, removeCopyRecipient, setCopyRecipients, type CopyTarget } from "./copy-recipients";
import { setEnvelopeSigners } from "./envelopes";
import { ACCT, ALI_KEY, OTHER, OTHER_USER, makeWorld, signerIn, uploadedCollection, type World } from "./people-world";

// People who receive a copy (migration 175), through the service. The database's own guards (one row per address, at most ten, open targets only,
// fixed rows) are proved by supabase/ci/verify-175-sign-copy-recipients.sql; FakeDb has none, so what is tested here are the service's own checks,
// the scoping to the workspace, and what is written to the history.

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const input = (n: number, email = `copy${n}@kedai.example`) => ({ fullName: `Copy ${n}`, email });

/** A draft document on its own with one signer (ali@kedai.example). */
async function document() {
  const { document: doc } = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Agreement.pdf" });
  await setSigners(w.ctx, doc.id, [{ roleKey: "signer", kind: "signer", fullName: "Ali", email: "Ali@Kedai.example", channel: "email", orderNo: 1 }]);
  return { target: { documentId: doc.id } as CopyTarget, id: doc.id, reference: w.docRows().find((d) => d.id === doc.id)!.reference };
}

async function collection() {
  const { envelope, ids } = await uploadedCollection(w, 2);
  await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Ali", "ali@kedai.example", ALI_KEY)]);
  return { target: { envelopeId: envelope.id } as CopyTarget, id: envelope.id, ids, reference: envelope.reference };
}

const emails = async (target: CopyTarget) => (await listCopyRecipients(w.ctx, target)).map((c) => c.email);
const logged = (type: string) => w.events(type).map((c) => c.args);

describe.each([
  ["a document on its own", document],
  ["a document collection", collection],
] as const)("%s", (_name, make) => {
  it("adds a person, lists them in the order they were added, and says so in the history with the name and the MASKED address only", async () => {
    const { target, reference } = await make();
    const first = await addCopyRecipient(w.ctx, target, { fullName: "  Cara Lim ", email: " cara@kedai.example " });
    await addCopyRecipient(w.ctx, target, input(2, "dev@kedai.example"));
    expect(first).toMatchObject({ full_name: "Cara Lim", email: "cara@kedai.example", notified_at: null, created_by: w.ctx.userId });
    expect(await emails(target)).toEqual(["cara@kedai.example", "dev@kedai.example"]);
    const events = logged("copy_recipient_added");
    // on every document of the target: one for a document, two for the collection
    expect(events.length).toBe("envelopeId" in target ? 4 : 2);
    expect(events[0]).toMatchObject({ p_type: "copy_recipient_added", p_actor_type: "user", p_user: w.ctx.userId, p_detail: { name: "Cara Lim", email: "c***@kedai.example", reference } });
    // the full address is never written to the history
    expect(JSON.stringify(w.rpcs("sign_log"))).not.toContain("cara@kedai.example");
    expect(JSON.stringify(w.rpcs("sign_log"))).not.toContain("dev@kedai.example");
  });

  it("refuses an address that is on the list already (letter case ignored), the address of a signer, a bad name, a bad address and an eleventh person", async () => {
    const { target } = await make();
    await addCopyRecipient(w.ctx, target, input(1));
    await expect(addCopyRecipient(w.ctx, target, input(9, "COPY1@kedai.example"))).rejects.toMatchObject({ code: "copy_duplicate", status: 400 });
    await expect(addCopyRecipient(w.ctx, target, { fullName: "Ali again", email: "ali@kedai.example" })).rejects.toMatchObject({ code: "copy_is_signer", status: 400 });
    await expect(addCopyRecipient(w.ctx, target, { fullName: " ", email: "x@kedai.example" })).rejects.toMatchObject({ code: "copy_name", status: 400 });
    await expect(addCopyRecipient(w.ctx, target, { fullName: "x".repeat(161), email: "x@kedai.example" })).rejects.toMatchObject({ code: "copy_name" });
    await expect(addCopyRecipient(w.ctx, target, { fullName: "X", email: "nope" })).rejects.toMatchObject({ code: "copy_email", status: 400 });
    await expect(addCopyRecipient(w.ctx, target, { fullName: "X", email: `${"a".repeat(250)}@kedai.example` })).rejects.toMatchObject({ code: "copy_email" });
    for (let n = 2; n <= 10; n++) await addCopyRecipient(w.ctx, target, input(n));
    await expect(addCopyRecipient(w.ctx, target, input(11))).rejects.toMatchObject({ code: "copy_limit", status: 400 });
    expect((await emails(target)).length).toBe(10);
  });

  it("is refused once the target is not draft, sent or in progress (copy_not_open, 409), for add, remove and a changed list; an unchanged list is returned as it is", async () => {
    const { target } = await make();
    const kept = await addCopyRecipient(w.ctx, target, input(1));
    const setStatus = (status: string) => {
      for (const d of w.docRows()) d.status = status as never;
      for (const e of w.db.rows("sign_envelopes")) e.status = status;
    };
    for (const status of ["sealing", "completed", "declined", "expired", "voided", "failed"]) {
      setStatus(status);
      await expect(addCopyRecipient(w.ctx, target, input(2))).rejects.toMatchObject({ code: "copy_not_open", status: 409 });
      await expect(removeCopyRecipient(w.ctx, target, kept.id)).rejects.toMatchObject({ code: "copy_not_open", status: 409 });
      await expect(setCopyRecipients(w.ctx, target, [input(1), input(2)])).rejects.toMatchObject({ code: "copy_not_open", status: 409 });
      expect((await setCopyRecipients(w.ctx, target, [input(1)])).map((c) => c.id)).toEqual([kept.id]);
    }
    for (const status of ["sent", "in_progress"]) {
      setStatus(status);
      await expect(addCopyRecipient(w.ctx, target, input(3))).resolves.toBeDefined();
      await removeCopyRecipient(w.ctx, target, (await listCopyRecipients(w.ctx, target)).find((c) => c.email === "copy3@kedai.example")!.id);
    }
  });

  it("removes a person, logs it with the masked address, and says a person who is not on this target is not found", async () => {
    const { target } = await make();
    const a = await addCopyRecipient(w.ctx, target, input(1));
    await addCopyRecipient(w.ctx, target, input(2));
    await removeCopyRecipient(w.ctx, target, a.id);
    expect(await emails(target)).toEqual(["copy2@kedai.example"]);
    expect(logged("copy_recipient_removed")[0]).toMatchObject({ p_detail: { name: "Copy 1", email: "c***@kedai.example" } });
    await expect(removeCopyRecipient(w.ctx, target, a.id)).rejects.toMatchObject({ code: "copy_recipient_not_found", status: 404 });
    await expect(removeCopyRecipient(w.ctx, target, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "copy_recipient_not_found" });
    expect(JSON.stringify(w.rpcs("sign_log"))).not.toContain("copy1@kedai.example");
  });

  it("makes the list exactly what is asked: adds the new, removes the gone, replaces a renamed person, keeps order, and writes nothing for an unchanged list", async () => {
    const { target } = await make();
    await setCopyRecipients(w.ctx, target, [input(1), input(2)]);
    expect(await emails(target)).toEqual(["copy1@kedai.example", "copy2@kedai.example"]);
    const before = await listCopyRecipients(w.ctx, target);
    const calls = w.db.rpcCalls.length;
    // nothing changes: the same rows, no history
    const same = await setCopyRecipients(w.ctx, target, [input(2), input(1)]);
    expect(same.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(w.db.rpcCalls.length).toBe(calls);
    // 1 goes, 3 comes, 2 is renamed (same address): replaced under the new name
    const out = await setCopyRecipients(w.ctx, target, [{ fullName: "Copy Two (renamed)", email: "COPY2@kedai.example" }, input(3)]);
    expect(out.map((c) => [c.full_name, c.email])).toEqual([["Copy Two (renamed)", "COPY2@kedai.example"], ["Copy 3", "copy3@kedai.example"]]);
    expect(out[0].id).not.toBe(before[1].id);
    // the history: 1 removed, 2 added again under its new name (a rename is not a removal), 3 added
    const per = "envelopeId" in target ? 2 : 1;
    expect(logged("copy_recipient_removed")).toHaveLength(per);
    expect(logged("copy_recipient_added")).toHaveLength(per * (2 + 2));
    expect(await setCopyRecipients(w.ctx, target, [])).toEqual([]);
    expect(w.copyRows()).toHaveLength(0);
  });

  it("checks a whole list before it writes anything: twice on the list, a signer, more than ten, a bad row", async () => {
    const { target } = await make();
    await setCopyRecipients(w.ctx, target, [input(1)]);
    const snapshot = JSON.stringify(w.copyRows());
    await expect(setCopyRecipients(w.ctx, target, [input(2), input(3, "COPY2@kedai.example")])).rejects.toMatchObject({ code: "copy_duplicate" });
    await expect(setCopyRecipients(w.ctx, target, [input(2), { fullName: "Ali", email: "ali@kedai.example" }])).rejects.toMatchObject({ code: "copy_is_signer" });
    const eleven = Array.from({ length: 11 }, (_, i) => input(i + 20));
    await expect(setCopyRecipients(w.ctx, target, eleven)).rejects.toMatchObject({ code: "copy_limit", issues: [{ code: "too_many_copies", detail: "10" }] });
    const bad = await setCopyRecipients(w.ctx, target, [input(2), { fullName: "", email: "x@kedai.example" }]).catch((e) => e);
    expect(bad).toMatchObject({ code: "copy_name", issues: [{ code: "signer_name", detail: "1" }] });
    const worse = await setCopyRecipients(w.ctx, target, [input(2), { fullName: "X", email: "nope" }]).catch((e) => e);
    expect(worse).toMatchObject({ code: "copy_email", issues: [{ code: "signer_email", detail: "1" }] });
    expect(JSON.stringify(w.copyRows())).toBe(snapshot);
  });

  it("never reaches a target of another workspace: not found for add, remove and set, and a person of another workspace cannot be removed through this target", async () => {
    const { target } = await make();
    const mine = await addCopyRecipient(w.ctx, target, input(1));
    const other = { ...w.ctx, accountId: OTHER, userId: OTHER_USER };
    const notFound = "envelopeId" in target ? "envelope_not_found" : "document_not_found";
    await expect(addCopyRecipient(other, target, input(2))).rejects.toMatchObject({ code: notFound, status: 404 });
    await expect(removeCopyRecipient(other, target, mine.id)).rejects.toMatchObject({ code: notFound, status: 404 });
    await expect(setCopyRecipients(other, target, [input(3)])).rejects.toMatchObject({ code: notFound, status: 404 });
    // the list of another workspace's target shows nothing (and not that it exists)
    expect(await listCopyRecipients(other, target)).toEqual([]);
    expect(await emails(target)).toEqual(["copy1@kedai.example"]);
    // the other workspace's own person is not found through this workspace's target either
    w.db.seed("sign_copy_recipients", [{ id: "99999999-0000-4000-8000-000000000001", account_id: OTHER, document_id: "11111111-0000-4000-8000-000000000001", envelope_id: null, full_name: "Theirs", email: "t@other.example", notified_at: null }]);
    await expect(removeCopyRecipient(w.ctx, target, "99999999-0000-4000-8000-000000000001")).rejects.toMatchObject({ code: "copy_recipient_not_found" });
    expect(w.copyRows()).toHaveLength(2);
    expect(ACCT).toBeTruthy();
  });
});

describe("a document of a collection", () => {
  it("takes no person of its own: add, remove and set are refused (document_in_envelope, 409), and the document's copies are empty", async () => {
    const { ids, target } = await collection();
    await addCopyRecipient(w.ctx, target, input(1));
    const own: CopyTarget = { documentId: ids[0] };
    await expect(addCopyRecipient(w.ctx, own, input(2))).rejects.toMatchObject({ code: "document_in_envelope", status: 409 });
    await expect(removeCopyRecipient(w.ctx, own, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "document_in_envelope", status: 409 });
    await expect(setCopyRecipients(w.ctx, own, [input(2)])).rejects.toMatchObject({ code: "document_in_envelope", status: 409 });
    expect(await listCopyRecipients(w.ctx, own)).toEqual([]);
    expect(w.copyRows()).toHaveLength(1);
  });
});

describe("a collection: who counts as a signer", () => {
  it("compares an address with the signers of every document of the collection, whatever the letter case", async () => {
    const { target } = await collection();
    await expect(addCopyRecipient(w.ctx, target, { fullName: "Ali", email: "ALI@KEDAI.EXAMPLE" })).rejects.toMatchObject({ code: "copy_is_signer" });
  });
});
