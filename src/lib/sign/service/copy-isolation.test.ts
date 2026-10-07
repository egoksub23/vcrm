import { beforeEach, describe, expect, it, vi } from "vitest";

import { serializeBundle } from "@/lib/api/v1/sign";

import { listDocumentsForApi, loadBundle } from "./api";
import { addCopyRecipient, setCopyRecipients } from "./copy-recipients";
import { createDraftFromUpload, setSigners } from "./drafts";
import { documentsCsvStream } from "./export";
import { runReminders } from "./jobs";
import { emitSignEvent } from "./outbound";
import { loadProgress } from "./progress";
import { docOf, makeWorld, type World } from "./people-world";

// People who receive a copy are not signers (migration 175): nothing that reads the signing list (progress, reminders, webhooks and automations, the
// API's signers, the exports, "x of y signed") ever sees them. They live in their own table; these tests put some on a document that is out for
// signature and look at everything that reads it.
const rec = vi.hoisted(() => ({ automations: vi.fn(), webhooks: vi.fn() }));
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: (...a: unknown[]) => rec.automations(...a) }));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: (...a: unknown[]) => rec.webhooks(...a) }));

let w: World;
let id: string;
const COPIES = [
  { fullName: "Cara Copyperson", email: "cara.copy@kedai.example" },
  { fullName: "Dev Copyperson", email: "dev.copy@kedai.example" },
];
const mentionsCopy = (text: string) => /cara|dev\.copy|copyperson/i.test(text);

beforeEach(async () => {
  w = await makeWorld();
  rec.automations.mockReset().mockResolvedValue(undefined);
  rec.webhooks.mockReset().mockResolvedValue(undefined);
  w.db.seed("automations", [{ id: "a1", account_id: w.ctx.accountId, trigger_type: "sign_document_event", is_active: true }]);
  const { document } = await createDraftFromUpload(w.ctx, { bytes: w.pdf, filename: "Agreement.pdf", title: "Merchant Agreement" });
  id = document.id;
  await setSigners(w.ctx, id, [
    { roleKey: "signer", kind: "signer", fullName: "Ali bin Ahmad", email: "ali@kedai.example", channel: "email", orderNo: 1 },
    { roleKey: "signer2", kind: "signer", fullName: "Bala Krishnan", email: "bala@kedai.example", channel: "email", orderNo: 2 },
  ]);
  await setCopyRecipients(w.ctx, { documentId: id }, COPIES);
  // out for signature: sent, the two signers invited five days ago
  Object.assign(docOf(w, id), { status: "sent", sent_at: "2026-10-01T08:00:00Z", expires_at: "2026-10-20T08:00:00Z", reminder_days: [3], base_sha256: "f".repeat(64) });
  for (const s of w.signerRows()) Object.assign(s, { status: "sent", invited_at: "2026-10-01T08:00:00Z" });
});

describe("people who receive a copy are not on the signing list", () => {
  it("are left out of the payload of a webhook and of an automation run, for each event", async () => {
    for (const event of ["sent", "viewed", "completed", "declined", "expired", "voided"] as const) await emitSignEvent(w.ctx, docOf(w, id), event, { signerId: w.signerRows()[0].id });
    expect(rec.webhooks).toHaveBeenCalledTimes(6);
    for (const call of rec.webhooks.mock.calls) {
      expect(call[3].signers.map((s: { name: string }) => s.name)).toEqual(["Ali bin Ahmad", "Bala Krishnan"]);
      expect(mentionsCopy(JSON.stringify(call[3]))).toBe(false);
    }
    expect(rec.automations).toHaveBeenCalledTimes(6);
    expect(mentionsCopy(JSON.stringify(rec.automations.mock.calls))).toBe(false);
  });

  it("are not reminded: a reminder run mails the signers who are due and nobody else", async () => {
    const real = w.db.client();
    const rows = () => w.signerRows().map((s) => ({ ...s, doc: { id, account_id: w.ctx.accountId, status: "sent", reminder_days: [3], envelope_id: null } }));
    // the reminder query joins the document (which FakeDb does not do), so its answer is what the database would give: the signers' rows
    const chain = (): unknown => {
      const p: unknown = new Proxy({}, { get: (_t, prop) => (prop === "then" ? (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok) : () => p) });
      return p;
    };
    const admin = {
      ...real,
      from: (t: string) => {
        const q = real.from(t) as unknown as { select: (...a: unknown[]) => unknown };
        if (t !== "sign_signers") return q;
        const select = q.select.bind(q);
        q.select = (cols: unknown, ...rest: unknown[]) => (String(cols).includes("doc:") ? chain() : select(cols, ...rest));
        return q;
      },
    } as never;
    w.db.rpcHandlers.sign_rotate_token = async (a) => {
      const s = w.signerRows().find((x) => x.id === a.p_signer)!;
      return { data: { signer_id: s.id, token: "c".repeat(64), name: s.full_name, email: s.email, phone: null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no }, error: null };
    };
    const out = await runReminders({ admin, origin: w.ctx.origin, deps: w.ctx.deps, now: () => new Date("2026-10-06T08:00:00Z") });
    expect(out).toEqual({ checked: 2, reminded: 2 });
    expect(w.mail.map((m) => m.to).sort()).toEqual(["ali@kedai.example", "bala@kedai.example"]);
    expect(w.mail.some((m) => mentionsCopy(m.to + m.subject + m.text))).toBe(false);
  });

  it("are not in how far a form is: the progress lists the roles of the signers only", async () => {
    Object.assign(docOf(w, id), {
      roles_snapshot: [{ key: "signer", label: "Applicant", kind: "signer", color: 0 }],
      form_snapshot: { version: 1, parts: [{ key: "p1", title: { en: "Details" }, role: "signer" }], fields: [] },
    });
    const progress = await loadProgress(w.ctx, id);
    expect(progress.roles.map((r) => r.signer?.name)).toEqual(["Ali bin Ahmad"]);
    expect(mentionsCopy(JSON.stringify(progress))).toBe(false);
  });

  it("are not a row of the export: the list asks for the document and its signers, and nothing of the copies reaches the file", async () => {
    const real = w.db.client();
    const asked: string[] = [];
    const chain = (rows: unknown[]): unknown => {
      const p: unknown = new Proxy({}, { get: (_t, prop) => (prop === "then" ? (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok) : () => p) });
      return p;
    };
    const admin = {
      ...real,
      from: (t: string) => {
        const q = real.from(t) as unknown as { select: (...a: unknown[]) => unknown };
        if (t !== "sign_documents") return q;
        const select = q.select.bind(q);
        q.select = (cols: unknown, ...rest: unknown[]) => {
          if (!String(cols).includes("sign_signers(")) return select(cols, ...rest);
          asked.push(String(cols));
          const d = docOf(w, id);
          return chain([{ reference: d.reference, title: d.title, status: d.status, mode: d.mode, category_id: null, created_at: d.created_at, sent_at: d.sent_at, completed_at: null, expires_at: d.expires_at, contacts: null, sign_signers: w.signerRows().map((s) => ({ full_name: s.full_name, order_no: s.order_no })) }]);
        };
        return q;
      },
    } as never;
    const filters = { group: "all", category: "all", search: "", from: null, to: null, contactId: null } as never;
    const chunks: string[] = [];
    const reader = documentsCsvStream({ ...w.ctx, admin }, filters).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    const csv = chunks.join("");
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toMatch(/copy/i);
    expect(csv).toContain("Ali bin Ahmad");
    expect(csv).toContain("Bala Krishnan");
    expect(mentionsCopy(csv)).toBe(false);
  });
});

describe("the API reads", () => {
  it("serializeBundle: `signers` has no copy recipient, `copy_to` has names only, and no address of a copy is in the JSON at all", async () => {
    const bundle = await loadBundle(w.ctx, id);
    expect(bundle.copies).toHaveLength(2);
    const json = serializeBundle(bundle, w.ctx.origin);
    expect(json.signers.map((s) => s.full_name)).toEqual(["Ali bin Ahmad", "Bala Krishnan"]);
    expect(json.copy_to).toEqual([{ full_name: "Cara Copyperson" }, { full_name: "Dev Copyperson" }]);
    const text = JSON.stringify(json);
    expect(text).not.toContain("cara.copy@kedai.example");
    expect(text).not.toContain("dev.copy@kedai.example");
    expect(JSON.stringify(json.copy_to)).not.toContain("email");
    // a bundle without the field (an older caller) is still valid
    expect(serializeBundle({ ...bundle, copies: undefined }, w.ctx.origin).copy_to).toEqual([]);
  });

  it("the list's counts of signers are unchanged by copy recipients", async () => {
    const filters = { status: null, contactId: null, templateId: null, reference: null, createdAfter: null };
    const params = { limit: 25, cursor: null } as never;
    const before = await listDocumentsForApi(w.ctx, filters, params);
    expect(before.counts.get(id)).toEqual({ total: 2, signed: 0 });
    await addCopyRecipient(w.ctx, { documentId: id }, { fullName: "Eve", email: "eve@kedai.example" });
    const after = await listDocumentsForApi(w.ctx, filters, params);
    expect(after.counts.get(id)).toEqual({ total: 2, signed: 0 });
  });
});
