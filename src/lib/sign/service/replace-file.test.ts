import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import type { NotifyDeps } from "../notify";
import { A4, LETTER, makePdf, scribblePng } from "../pdf/fixtures";
import { inspectPdf } from "../pdf/load";
import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import type { SignCtx } from "./context";
import { createDraftFromUpload, setSigners, updateDraft } from "./drafts";
import { FakeDb } from "./fake-db";
import { replaceDraftFile } from "./replace-file";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const roles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];
const fields: PlacedField[] = [
  { key: "biz", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.2, w: 0.5, h: 0.04, required: true },
  { key: "msig", type: "signature", role: "merchant", page: 1, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "mdate", type: "date", role: "merchant", page: 2, x: 0.1, y: 0.6, w: 0.3, h: 0.04, required: false },
];

let db: FakeDb;
let ctx: SignCtx;

beforeEach(() => {
  db = new FakeDb();
  const deps: NotifyDeps = { emailConfigured: () => true, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "Vircle" }), sendWhatsApp: async () => {} };
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-08T08:00:00Z") };
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
});

/** A three page A4 draft with a field on each page and a person on the list. */
async function draft() {
  const { document } = await createDraftFromUpload(ctx, { bytes: await makePdf([{ ...A4 }, { ...A4 }, { ...A4 }]), filename: "Agreement.pdf", title: "Agreement" });
  await updateDraft(ctx, document.id, { roles, fields });
  await setSigners(ctx, document.id, [{ roleKey: "merchant", kind: "signer", fullName: "Ali", email: "ali@kedai.example", channel: "email", orderNo: 1 }]);
  return db.rows("sign_documents")[0];
}
const events = (type: string) => db.rpcCalls.filter((c) => c.name === "sign_log" && c.args.p_type === type);

describe("replacing the file of a draft", () => {
  it("answers what would happen on a dry run and stores nothing", async () => {
    const doc = await draft();
    const files = db.files.size;
    const next = await makePdf([{ ...A4 }, { ...A4 }]);
    const r = await replaceDraftFile(ctx, doc.id as string, { bytes: next, filename: "v2.pdf", dryRun: true });
    expect(r).toMatchObject({ dryRun: true, kept: 2, oldPageCount: 3, newPageCount: 2, pageCountChanged: true, flagged: [{ key: "mdate", reason: "page_missing", page: 2, movedTo: 1 }], converted: false });
    expect(db.files.size).toBe(files);
    expect(db.rows("sign_documents")[0]).toMatchObject({ base_sha256: doc.base_sha256, page_count: 3 });
    expect(db.rows("sign_documents")[0].fields_snapshot).toEqual(fields);
    expect(events("file_replaced")).toHaveLength(0);
  });

  it("replaces the file, keeps the fields that still fit, moves the ones whose page is gone, and leaves the people and options alone", async () => {
    const doc = await draft();
    const oldBase = doc.base_path as string;
    const next = await makePdf([{ ...A4 }, { ...A4 }]);
    const sha = createHash("sha256").update(next).digest("hex");
    const r = await replaceDraftFile(ctx, doc.id as string, { bytes: next, filename: "Agreement v2.pdf" });
    expect(r).toMatchObject({ dryRun: false, kept: 2, flagged: [{ key: "mdate", reason: "page_missing" }], document: { page_count: 2, base_sha256: sha } });

    const now = db.rows("sign_documents")[0];
    expect(now).toMatchObject({ base_sha256: sha, page_count: 2, status: "draft", title: "Agreement", original_sha256: sha });
    expect(now.base_path).toBe(`account-${ACCT}/${doc.id}/base/${sha}.pdf`);
    expect(db.files.get(now.base_path as string)).toEqual(next);
    expect((now.fields_snapshot as PlacedField[]).map((f) => [f.key, f.page])).toEqual([["biz", 0], ["msig", 1], ["mdate", 1]]);
    // everything else is as it was
    expect(now.roles_snapshot).toEqual(roles);
    expect(db.rows("sign_signers")).toHaveLength(1);
    // the old file is gone, the file records are the new file's, and the history says so
    expect(db.files.has(oldBase)).toBe(false);
    expect(db.rows("sign_document_files").map((f) => [f.kind, f.sha256])).toEqual([["source", sha]]);
    expect(events("file_replaced")).toMatchObject([{ args: { p_detail: { name: "Agreement v2.pdf", old_pages: 3, new_pages: 2, flagged: 1, moved: 1, converted: false } } }]);
    expect((await inspectPdf(db.files.get(now.base_path as string)!)).pageCount).toBe(2);
  });

  it("flags the fields of a page whose size changed and keeps them in place", async () => {
    const doc = await draft();
    const r = await replaceDraftFile(ctx, doc.id as string, { bytes: await makePdf([{ ...A4 }, { ...LETTER }, { ...A4 }]), filename: "mixed.pdf" });
    expect(r.flagged).toEqual([{ key: "msig", reason: "size_changed", page: 1 }]);
    expect(db.rows("sign_documents")[0].fields_snapshot).toEqual(fields);
  });

  it("takes an image too: it becomes the page, and both the original and the converted file are recorded", async () => {
    const doc = await draft();
    const r = await replaceDraftFile(ctx, doc.id as string, { bytes: await scribblePng(), filename: "Scan.png" });
    expect(r).toMatchObject({ converted: true, newPageCount: 1, document: { page_count: 1 } });
    // the one page is not an A4 page, so the field that stayed on it is flagged to be checked; two pages are gone: their fields were moved to it
    expect(r.flagged.map((f) => [f.key, f.reason, f.movedTo])).toEqual([["biz", "size_changed", undefined], ["msig", "page_missing", 0], ["mdate", "page_missing", 0]]);
    const rows = db.rows("sign_document_files");
    expect(rows.map((f) => f.kind).sort()).toEqual(["converted", "source"]);
    expect(rows.find((f) => f.kind === "source")).toMatchObject({ mime: "image/png", name: "Scan.png" });
    expect(db.rows("sign_documents")[0].original_type).toBe("image/png");
  });

  it("refuses the file the draft already has, a document that was sent, and a draft with no file", async () => {
    const doc = await draft();
    const same = db.files.get(doc.base_path as string)!;
    await expect(replaceDraftFile(ctx, doc.id as string, { bytes: same, filename: "same.pdf" })).rejects.toMatchObject({ code: "same_file", status: 409 });
    const base = await makePdf([{ ...A4 }]);
    db.rows("sign_documents")[0].status = "sent";
    await expect(replaceDraftFile(ctx, doc.id as string, { bytes: base, filename: "x.pdf" })).rejects.toMatchObject({ code: "document_not_draft", status: 409 });
    expect(db.rows("sign_documents")[0].base_sha256).toBe(doc.base_sha256);
    expect(events("file_replaced")).toHaveLength(0);
    db.rows("sign_documents")[0].status = "draft";
    db.rows("sign_documents")[0].base_path = null;
    await expect(replaceDraftFile(ctx, doc.id as string, { bytes: base, filename: "x.pdf" })).rejects.toMatchObject({ code: "document_has_no_file" });
  });

  it("refuses what is not a PDF, Word or image, and changes nothing", async () => {
    const doc = await draft();
    await expect(replaceDraftFile(ctx, doc.id as string, { bytes: new TextEncoder().encode("hello"), filename: "a.pdf" })).rejects.toMatchObject({ code: "upload_unsupported" });
    expect(db.rows("sign_documents")[0]).toMatchObject({ base_sha256: doc.base_sha256, page_count: 3 });
  });

  it("is for this workspace's documents only, and removes only files in the document's own folder", async () => {
    const doc = await draft();
    await expect(replaceDraftFile({ ...ctx, accountId: "someone-else" }, doc.id as string, { bytes: await makePdf([{ ...A4 }]), filename: "x.pdf" })).rejects.toMatchObject({ code: "document_not_found" });
    // a file record that points outside the document's folder (a template's file) survives a replacement
    const template = `account-${ACCT}/templates/t1/v1.pdf`;
    db.files.set(template, new Uint8Array([1]));
    db.rows("sign_document_files").push({ id: "x", document_id: doc.id, account_id: ACCT, kind: "source", path: template });
    await replaceDraftFile(ctx, doc.id as string, { bytes: await makePdf([{ ...A4 }, { ...A4 }, { ...A4 }, { ...A4 }]), filename: "four.pdf" });
    expect(db.files.has(template)).toBe(true);
  });

  it("removes what it stored when a send got in first and the conditional update matched nothing", async () => {
    const doc = await draft();
    // the draft is sent between the check and the update: the update is conditional on the draft status
    const realFrom = ctx.admin.from.bind(ctx.admin);
    let seen = 0;
    ctx = {
      ...ctx,
      admin: {
        from: (table: string) => {
          if (table === "sign_documents" && ++seen === 2) db.rows("sign_documents")[0].status = "sent";
          return realFrom(table);
        },
        rpc: ctx.admin.rpc.bind(ctx.admin),
        storage: ctx.admin.storage,
      } as unknown as SignCtx["admin"],
    };
    const before = new Set(db.files.keys());
    await expect(replaceDraftFile(ctx, doc.id as string, { bytes: await makePdf([{ ...A4 }]), filename: "late.pdf" })).rejects.toMatchObject({ code: "document_not_draft" });
    expect(new Set(db.files.keys())).toEqual(before);
    expect(db.rows("sign_documents")[0].base_sha256).toBe(doc.base_sha256);
  });
});
