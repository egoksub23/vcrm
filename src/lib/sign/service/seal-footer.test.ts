import { getDocumentProxy } from "unpdf";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDraftFromUpload, setSigners } from "./drafts";
import { docOf, makeWorld, type World } from "./people-world";
import { runSealing } from "./seal";

// The ID line is the one thing in sealing that may be left off: when stamping it makes the answers' step fail, sealing carries on without the line;
// when the answers' step fails for its own reason, the seal fails and is retried as it always was (the line never hides a real failure).
const stampControl = vi.hoisted(() => ({ failWithFooter: false, failAlways: false, calls: [] as { idFooter?: string }[] }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: async () => undefined }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => undefined }));
vi.mock("../pdf/stamp", async (original) => {
  const real = await original<typeof import("../pdf/stamp")>();
  return {
    ...real,
    stampFields: async (...args: Parameters<typeof real.stampFields>) => {
      stampControl.calls.push({ idFooter: args[3]?.idFooter });
      if (stampControl.failAlways) throw new Error("the answers could not be written");
      if (stampControl.failWithFooter && args[3]?.idFooter) throw new Error("odd page");
      return real.stampFields(...args);
    },
  };
});

let w: World;
beforeEach(async () => {
  stampControl.failWithFooter = false;
  stampControl.failAlways = false;
  stampControl.calls = [];
  w = await makeWorld();
});

const base = () => ({ admin: w.ctx.admin, origin: w.ctx.origin, deps: w.ctx.deps, now: w.ctx.now });

async function sealing() {
  const { document } = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Agreement.pdf", title: "Merchant Agreement" });
  await setSigners(w.ctx, document.id, [{ roleKey: "signer", kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 }]);
  Object.assign(docOf(w, document.id), { status: "sealing", sent_at: "2026-10-06T02:00:00Z", base_sha256: "f".repeat(64) });
  for (const s of w.signerRows()) Object.assign(s, { status: "signed", signed_at: "2026-10-06T07:00:00Z" });
  w.seedCertificate();
  return document.id;
}

const text = async (bytes: Uint8Array) => {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" "));
  return out;
};

describe("the ID line can never fail a seal", () => {
  it("asks for the line (the document's id) in the same pass that writes the answers", async () => {
    const id = await sealing();
    expect(await runSealing(base(), 4)).toEqual({ claimed: 1, completed: 1, retry: 0 });
    expect(stampControl.calls).toEqual([{ idFooter: `Vircle Secure Sign · ID ${id}` }]);
    expect((await text(w.db.files.get(String(docOf(w, id).final_path))!)).every((p) => p.includes(`ID ${id}`))).toBe(true);
  }, 30_000);

  it("seals without the line, and says so in the log, when stamping it makes the step fail; the seal, the certificate and the completion all go on", async () => {
    const id = await sealing();
    stampControl.failWithFooter = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runSealing(base(), 4)).toEqual({ claimed: 1, completed: 1, retry: 0 });
    // asked with the line, then again without it
    expect(stampControl.calls.map((c) => Boolean(c.idFooter))).toEqual([true, false]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("the ID line could not be stamped") && String(c[1]) === id)).toBe(true);
    const d = docOf(w, id);
    expect(d.status).toBe("completed");
    expect(d.certificate_path).toBeTruthy();
    expect((await text(w.db.files.get(String(d.final_path))!)).join(" ")).not.toContain("Vircle Secure Sign");
    errors.mockRestore();
  }, 30_000);

  it("does not hide a real failure: when the answers cannot be written even without the line, the seal fails and is retried, and nothing is stored", async () => {
    const id = await sealing();
    stampControl.failAlways = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = await runSealing(base(), 4);
    expect(run).toMatchObject({ claimed: 1, completed: 0, retry: 1 });
    expect(run.errors?.[0]).toContain("the answers could not be written");
    expect(docOf(w, id).status).toBe("sealing");
    expect(w.rpcs("sign_finish_sealing")).toHaveLength(0);
    expect([...w.db.files.keys()].filter((p) => p.includes("/final/") || p.includes("/certificate/"))).toEqual([]);
    vi.restoreAllMocks();
  }, 30_000);
});
