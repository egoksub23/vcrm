import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateDraft } from "./drafts";
import { finishEnvelope } from "./envelope-signing";
import { envelopeData, sendEnvelope, setEnvelopeSigners } from "./envelopes";
import { runAll, sealingIsFailing } from "./jobs";
import { ALI_KEY, BALA_KEY, docOf, makeWorld, signerIn, sig, uploadedCollection, type World } from "./people-world";
import { describeFailure, runSealing, runSealingWithin, sealSoon } from "./seal";
import { retryEnvelopeSealing, retrySealing, sealingIsStuck } from "./seal-retry";
import { lookupByToken, pickDocument, recordConsent, saveAnswers } from "./signing";

// Sealing that does not finish must be VISIBLE and RECOVERABLE: the reason is kept on the document and in its history, the job says it is failing,
// the sender can ask for another try, and the signed copy is attempted right after the last signature instead of waiting for the minute job.
// (The owner's real collection sat on "We are finishing your document" with nothing saying why.) The database's claim, lease and attempt
// functions are stood in here the way the service's other tests do; their SQL is proved by verify-158 and verify-171.

vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));

const GOKULA = "gokula@kedai.example";
const GOPALA = "gopala@kedai.example";
const meta = { ip: "203.0.113.9", device: "Chrome", locale: "en" as const };

let w: World;
const base = () => ({ admin: w.ctx.admin, origin: w.ctx.origin, deps: w.ctx.deps, now: () => new Date() });

beforeEach(async () => {
  w = await makeWorld();
});

/** A faithful stand-in for the claim, the failure record and the hold: a lease, the attempts used, `failed` after five. */
function faithfulSealing() {
  const doc = (id: unknown) => w.db.rows("sign_documents").find((d) => d.id === id)!;
  w.db.rpcHandlers.sign_claim_sealing = async (a) => {
    const out: Record<string, unknown>[] = [];
    for (const d of w.db.rows("sign_documents").filter((x) => x.status === "sealing")) {
      if (out.length >= Number(a.p_limit ?? 2)) break;
      const started = d.sealing_started_at ? Date.parse(String(d.sealing_started_at)) : 0;
      if (started && Date.now() - started < Number(a.p_lease_seconds ?? 300) * 1000) continue;
      if (Number(d.sealing_attempts ?? 0) >= Number(a.p_max_attempts ?? 5)) {
        d.status = "failed";
        d.seal_error ??= "Sealing did not finish";
        continue;
      }
      d.sealing_started_at = new Date().toISOString();
      d.sealing_attempts = Number(d.sealing_attempts ?? 0) + 1;
      out.push({ document_id: d.id, account_id: d.account_id });
    }
    return { data: out, error: null };
  };
  w.db.rpcHandlers.sign_fail_sealing = async (a) => {
    const d = doc(a.p_document);
    if (d?.status === "sealing") {
      d.seal_error = String(a.p_error).slice(0, 500);
      d.sealing_started_at = new Date().toISOString();
    }
    w.db.rpcCalls.push({ name: "sign_log", args: { p_document: a.p_document, p_type: "seal_attempt_failed", p_detail: { error: String(a.p_error).slice(0, 200) } } });
    return { data: null, error: null };
  };
}

/** A collection of two uploaded files, both people having signed, so both documents are sealing. */
async function signedCollection() {
  const { envelope, ids } = await uploadedCollection(w, 2);
  await setEnvelopeSigners(w.ctx, envelope.id, [signerIn("Gokula Krishnan", GOKULA, ALI_KEY), signerIn("Gopala Krishnan", GOPALA, BALA_KEY)]);
  await updateDraft(w.ctx, ids[0], { fields: [sig("g1", ALI_KEY), sig("p1", BALA_KEY)] });
  await updateDraft(w.ctx, ids[1], { fields: [sig("g2", ALI_KEY), sig("p2", BALA_KEY)] });
  await sendEnvelope(w.ctx, envelope.id);
  const anchor = (email: string) => w.signerRows().find((s) => s.email === email && s.id === s.party_id)!;
  const look = async (email: string) => (await lookupByToken(w.ctx.admin, w.tokens.get(anchor(email).id)))!;
  const sign = async (email: string, keys: Record<string, string[]>) => {
    await recordConsent(w.ctx, await look(email), "en", null, null);
    for (const [id, list] of Object.entries(keys)) for (const k of list) await saveAnswers(w.ctx, pickDocument(await look(email), id)!, { [k]: { typed: "X" } });
    return finishEnvelope(w.ctx, await look(email), {}, meta);
  };
  await sign(GOKULA, { [ids[0]]: ["g1"], [ids[1]]: ["g2"] });
  const last = await sign(GOPALA, { [ids[0]]: ["p1"], [ids[1]]: ["p2"] });
  return { envelope, ids, last };
}

describe("the reason is kept, not swallowed", () => {
  it("says what kind of error it was, with its code, so a missing file on the server reads as one", () => {
    const missing = Object.assign(new Error("no such file or directory, open '/app/src/lib/sign/pdf/assets/NotoSans_400Regular.ttf'"), { code: "ENOENT" });
    expect(describeFailure(missing)).toBe("ENOENT: no such file or directory, open '/app/src/lib/sign/pdf/assets/NotoSans_400Regular.ttf'");
    expect(describeFailure(new TypeError("x is not a function"))).toBe("TypeError: x is not a function");
    expect(describeFailure(new Error("plain"))).toBe("plain");
    expect(describeFailure("a string")).toBe("a string");
  });

  it("records why on the document and in its history, and tells the run (and so the job) which document failed and why", async () => {
    faithfulSealing();
    const { ids } = await signedCollection();
    // the file that was sent is gone from storage: sealing cannot read it
    for (const id of ids) w.db.files.delete(docOf(w, id).base_path!);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = await runSealing(base(), 4);
    expect(run).toMatchObject({ claimed: 2, completed: 0, retry: 2 });
    expect(run.errors).toHaveLength(2);
    expect(run.errors?.[0]).toContain(ids[0]);
    for (const id of ids) {
      expect(docOf(w, id).status).toBe("sealing");
      expect(String(docOf(w, id).seal_error)).not.toBe("");
    }
    expect(w.events("seal_attempt_failed")).toHaveLength(2);
    expect(String(w.events("seal_attempt_failed")[0].args.p_detail && (w.events("seal_attempt_failed")[0].args.p_detail as { error: string }).error).length).toBeGreaterThan(5);
    // the server's log carries the line too, with the document
    expect(errors.mock.calls.some((c) => String(c[0]).includes("sealing failed") && String(c[1]) === ids[0])).toBe(true);
    errors.mockRestore();
  });

  it("puts the first reason and the count into the job's result, and calls the run failing only when something was tried and nothing sealed", async () => {
    faithfulSealing();
    const { ids } = await signedCollection();
    for (const id of ids) w.db.files.delete(docOf(w, id).base_path!);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    w.db.rpcHandlers.sign_expire_due = async () => ({ data: [], error: null });
    w.db.rpcHandlers.sign_bulk_claim = async () => ({ data: [], error: null });
    const out = await runAll(base());
    expect(out.seal_retry).toBe(2);
    expect(out.sealed).toBe(0);
    expect(String(out.seal_error)).toContain(ids[0]);
    expect(sealingIsFailing(out)).toBe(true);
    expect(sealingIsFailing({ seal_retry: 0, sealed: 0 })).toBe(false);
    expect(sealingIsFailing({ seal_retry: 1, sealed: 1 })).toBe(false);
    vi.restoreAllMocks();
  });

  it("reports a claim that the database refused as the reason, instead of looking like nothing to do", async () => {
    w.db.rpcHandlers.sign_claim_sealing = async () => ({ data: null, error: { message: "permission denied for function sign_claim_sealing" } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = await runSealing(base(), 1);
    expect(run.claimed).toBe(0);
    expect(run.errors?.[0]).toContain("permission denied");
    vi.restoreAllMocks();
  });
});

describe("a document that stopped can be tried again by its sender", () => {
  it("puts a failed document back to being sealed with a fresh lease and no attempts used, and writes who asked in its history", async () => {
    faithfulSealing();
    const { ids } = await signedCollection();
    const d = docOf(w, ids[0]);
    Object.assign(d, { status: "failed", seal_error: "ENOENT: no such file", sealing_attempts: 5, sealing_started_at: new Date().toISOString() });
    expect(sealingIsStuck(d)).toBe(true);
    const out = await retrySealing(w.ctx, ids[0]);
    expect(out).toEqual({ retried: [ids[0]] });
    expect(docOf(w, ids[0])).toMatchObject({ status: "sealing", sealing_attempts: 0, sealing_started_at: null, seal_error: null });
    const logged = w.events("seal_retried");
    expect(logged).toHaveLength(1);
    expect(logged[0].args.p_detail).toMatchObject({ was: "failed", error: "ENOENT: no such file" });
  });

  it("lets a document that is still being tried skip the wait, and refuses one that is not stuck (409 seal_not_stuck)", async () => {
    faithfulSealing();
    const { ids } = await signedCollection();
    // sealing with no error yet: nothing is wrong, nothing to retry
    await expect(retrySealing(w.ctx, ids[0])).rejects.toMatchObject({ code: "seal_not_stuck", status: 409 });
    Object.assign(docOf(w, ids[0]), { seal_error: "boom", sealing_attempts: 2, sealing_started_at: new Date().toISOString() });
    await retrySealing(w.ctx, ids[0]);
    expect(docOf(w, ids[0])).toMatchObject({ status: "sealing", sealing_attempts: 0, sealing_started_at: null, seal_error: null });
    // a document that is still waiting for signatures is not stuck either
    const { ids: more } = await uploadedCollection(w, 2);
    await expect(retrySealing(w.ctx, more[0])).rejects.toMatchObject({ code: "seal_not_stuck" });
  });

  it("does not reach a document of another workspace", async () => {
    const { ids } = await signedCollection();
    Object.assign(docOf(w, ids[0]), { status: "failed", seal_error: "x" });
    const other = { ...w.ctx, accountId: "99999999-9999-4999-8999-999999999999", userId: "88888888-8888-4888-8888-888888888888" };
    await expect(retrySealing(other, ids[0])).rejects.toMatchObject({ code: "document_not_found", status: 404 });
    expect(docOf(w, ids[0]).status).toBe("failed");
  });

  it("asks again for every stuck document of a collection and none of the others, and the collection says which are stuck", async () => {
    faithfulSealing();
    const { envelope, ids } = await signedCollection();
    Object.assign(docOf(w, ids[0]), { status: "failed", seal_error: "ENOENT: font" });
    expect((await envelopeData(w.ctx, envelope.id)).stuck).toEqual([{ id: ids[0], position: 1, title: docOf(w, ids[0]).title, error: "ENOENT: font" }]);
    const out = await retryEnvelopeSealing(w.ctx, envelope.id);
    expect(out.retried).toEqual([ids[0]]);
    expect(docOf(w, ids[0]).status).toBe("sealing");
    expect((await envelopeData(w.ctx, envelope.id)).stuck).toEqual([]);
    await expect(retryEnvelopeSealing(w.ctx, envelope.id)).rejects.toMatchObject({ code: "seal_not_stuck", status: 409 });
  });

  it("seals after it is put right: a retry then a run completes the collection", async () => {
    faithfulSealing();
    w.seedCertificate();
    const { envelope, ids } = await signedCollection();
    const files = ids.map((id) => [id, w.db.files.get(docOf(w, id).base_path!)!] as const);
    for (const [id] of files) w.db.files.delete(docOf(w, id).base_path!);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runSealing(base(), 4);
    Object.assign(docOf(w, ids[0]), { status: "failed" });
    // the cause is put right (the file is back), and the sender asks again
    for (const [id, bytes] of files) w.db.files.set(docOf(w, id).base_path!, bytes);
    await retryEnvelopeSealing(w.ctx, envelope.id);
    const run = await runSealing(base(), 4);
    expect(run.completed).toBe(2);
    expect(ids.map((id) => docOf(w, id).status)).toEqual(["completed", "completed"]);
    vi.restoreAllMocks();
  });
});

describe("sealing right after the last signature", () => {
  it("seals what is waiting in one go, within its budget, and says what it did", async () => {
    faithfulSealing();
    w.seedCertificate();
    const { ids, last } = await signedCollection();
    // the last signature answered that a document is being sealed (the route hands the rest to `after`)
    expect(last.sealing).toBe(true);
    expect(ids.map((id) => docOf(w, id).status)).toEqual(["sealing", "sealing"]);
    const run = await sealSoon(base());
    expect(run).toMatchObject({ claimed: 2, completed: 2, retry: 0 });
    expect(ids.map((id) => docOf(w, id).status)).toEqual(["completed", "completed"]);
  });

  it("claims with the same lease as the job, so a document being sealed by one is not sealed again by the other", async () => {
    faithfulSealing();
    w.seedCertificate();
    await signedCollection();
    const first = await sealSoon(base(), { max: 1 });
    const second = await sealSoon(base());
    expect((first?.claimed ?? 0) + (second?.claimed ?? 0)).toBe(2);
    expect(w.rpcs("sign_finish_sealing")).toHaveLength(2);
  });

  it("never throws: a database that fails gives back nothing, and a failed seal leaves the job to retry", async () => {
    w.db.rpcHandlers.sign_claim_sealing = async () => {
      throw new Error("connection reset");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(sealSoon(base())).resolves.toBeNull();
    expect(errors.mock.calls.some((c) => String(c[0]).includes("right after the last signature failed") && String(c[1]).includes("connection reset"))).toBe(true);
    errors.mockRestore();
  });

  it("stops at its time budget rather than holding the request's process", async () => {
    faithfulSealing();
    w.seedCertificate();
    await signedCollection();
    const run = await runSealingWithin(base(), { budgetMs: 0 });
    expect(run).toEqual({ claimed: 0, completed: 0, retry: 0 });
  });
});
