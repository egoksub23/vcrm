// Deleting documents under retention: a draft goes, a signed document stays until its date, and in every case the
// database row is removed first and the stored files only after that succeeded, so a refusal can never leave a
// retained document without its files. (The database's own refusal, which holds for everyone, is proved by
// supabase/ci/verify-165-sign-retention.sql; here the services are checked to ask first and to cope with it.)

import { beforeEach, describe, expect, it } from "vitest";

import type { NotifyDeps } from "../notify";
import { A4, makePdf } from "../pdf/fixtures";
import type { SignCtx } from "./context";
import { createDraftFromUpload, deleteDocument, deleteDraft } from "./drafts";
import { SignError, fromDatabaseError } from "./errors";
import { FakeDb } from "./fake-db";

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-06T08:00:00Z");

let db: FakeDb;
let ctx: SignCtx;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  db = new FakeDb();
  const deps: NotifyDeps = { emailConfigured: () => false, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "x" }), sendWhatsApp: async () => {} };
  ctx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => NOW };
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
});

/** A draft made the real way (its files stored), then moved to the state a test needs. */
async function documentIn(status: string, over: Record<string, unknown> = {}) {
  const { document } = await createDraftFromUpload(ctx, { bytes: await makePdf([{ ...A4 }]), filename: "Agreement.pdf", title: "Agreement" });
  const row = db.rows("sign_documents").find((d) => d.id === document.id)!;
  const finalPath = `account-${ACCT}/${document.id}/final/${"c".repeat(64)}.pdf`;
  const uploadPath = `account-${ACCT}/${document.id}/upload/u1-id.jpg`;
  if (status !== "draft") {
    Object.assign(row, { status, final_path: status === "completed" ? finalPath : null }, over);
    if (status === "completed") {
      db.files.set(finalPath, new Uint8Array([1]));
      db.files.set(uploadPath, new Uint8Array([2]));
      db.seed("sign_document_files", [
        { account_id: ACCT, document_id: document.id, kind: "signed", path: finalPath, name: "signed.pdf" },
        { account_id: ACCT, document_id: document.id, kind: "signer_upload", path: uploadPath, name: "id.jpg" },
      ]);
      db.seed("sign_answers", [{ account_id: ACCT, document_id: document.id, signer_id: "s1", field_key: "id", value: null, file_path: uploadPath }]);
    }
  }
  return { id: document.id, row, finalPath, uploadPath, basePath: document.base_path as string };
}

const filesOf = (id: string) => [...db.files.keys()].filter((p) => p.includes(`/${id}/`));
const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  return e instanceof SignError ? e : e;
};

describe("deleting a draft", () => {
  it("removes the row, then every file of the draft", async () => {
    const d = await documentIn("draft");
    expect(filesOf(d.id).length).toBeGreaterThan(0);
    await deleteDraft(ctx, d.id);
    expect(db.rows("sign_documents")).toHaveLength(0);
    expect(filesOf(d.id)).toHaveLength(0);
  });

  it("removes nothing when the row did not go (the document was sent while the delete was on its way)", async () => {
    const d = await documentIn("draft");
    // the draft is sent at the moment the delete reaches the database
    const real = db.client();
    const admin = new Proxy(real, {
      get(target, prop) {
        if (prop !== "from") return (target as never)[prop];
        return (table: string) => {
          const q = target.from(table);
          if (table === "sign_documents") {
            const del = q.delete.bind(q);
            q.delete = () => {
              d.row.status = "sent";
              return del();
            };
          }
          return q;
        };
      },
    });
    const err = await codeOf(deleteDraft({ ...ctx, admin }, d.id));
    expect(err).toMatchObject({ code: "document_not_draft", status: 409 });
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(filesOf(d.id).length).toBeGreaterThan(0);
  });

  it("leaves the files alone when the database refuses", async () => {
    const d = await documentIn("draft");
    db.failNext.sign_documents = "sign_document_cannot_be_deleted";
    expect(await codeOf(deleteDraft(ctx, d.id))).toMatchObject({ code: "document_cannot_be_deleted", status: 409 });
    expect(filesOf(d.id).length).toBeGreaterThan(0);
  });

  it("refuses a document that was sent", async () => {
    const d = await documentIn("sent");
    expect(await codeOf(deleteDraft(ctx, d.id))).toMatchObject({ code: "document_not_draft" });
    expect(filesOf(d.id).length).toBeGreaterThan(0);
  });
});

describe("deleting a signed document", () => {
  it("is refused before its retention date, with the date, and nothing is touched", async () => {
    const d = await documentIn("completed", { retain_until: "2033-10-06T08:00:00Z" });
    const err = (await codeOf(deleteDocument(ctx, d.id))) as SignError;
    expect(err).toMatchObject({ code: "document_retained", status: 409 });
    expect(err.message).toContain("2033-10-06");
    expect(err.issues).toEqual([{ code: "document_retained", detail: "2033-10-06T08:00:00.000Z" }]);
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(db.rows("sign_document_files")).toHaveLength(3); // the draft's own source file, and the two added
    expect(filesOf(d.id)).toEqual(expect.arrayContaining([d.finalPath, d.uploadPath, d.basePath]));
  });

  it("is refused for a signed document that has no retention date (kept, to be safe)", async () => {
    const d = await documentIn("completed", { retain_until: null });
    expect(await codeOf(deleteDocument(ctx, d.id))).toMatchObject({ code: "document_retained" });
    expect(filesOf(d.id).length).toBeGreaterThan(0);
  });

  it("is refused on the very day, until the date has passed", async () => {
    const d = await documentIn("completed", { retain_until: "2026-10-06T08:00:01Z" });
    expect(await codeOf(deleteDocument(ctx, d.id))).toMatchObject({ code: "document_retained" });
  });

  it("goes after its date: the row first, then its sealed file, the uploads and the files its answers point at, and no one else's", async () => {
    const d = await documentIn("completed", { retain_until: "2026-10-06T08:00:00Z" });
    const other = await documentIn("completed", { retain_until: "2040-01-01T00:00:00Z" });
    // a template's file and a stranger's file are never ours to remove
    db.files.set(`account-${ACCT}/templates/t1/v1.pdf`, new Uint8Array([7]));
    db.files.set(`account-${OTHER}/${d.id}/base/x.pdf`, new Uint8Array([8]));
    db.rows("sign_documents").find((r) => r.id === d.id)!.original_path = `account-${ACCT}/templates/t1/v1.pdf`;
    await deleteDocument(ctx, d.id);
    expect(db.rows("sign_documents").map((r) => r.id)).toEqual([other.id]);
    expect(filesOf(d.id).filter((p) => p.startsWith(`account-${ACCT}/`))).toHaveLength(0);
    expect(db.files.has(`account-${ACCT}/templates/t1/v1.pdf`)).toBe(true);
    expect(db.files.has(`account-${OTHER}/${d.id}/base/x.pdf`)).toBe(true);
    // the other document is untouched
    expect(filesOf(other.id).length).toBeGreaterThan(0);
  });

  it("keeps the files when the database refuses after all (the date moved, or it is the database's rule)", async () => {
    const d = await documentIn("completed", { retain_until: "2026-10-06T08:00:00Z" });
    db.failNext.sign_documents = "sign_document_retained";
    expect(await codeOf(deleteDocument(ctx, d.id))).toMatchObject({ code: "document_retained", status: 409 });
    expect(db.rows("sign_documents")).toHaveLength(1);
    expect(filesOf(d.id)).toEqual(expect.arrayContaining([d.finalPath, d.uploadPath]));
  });

  it("refuses everything else that was sent, and another workspace's document", async () => {
    for (const status of ["sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) {
      const d = await documentIn(status);
      expect(await codeOf(deleteDocument(ctx, d.id)), status).toMatchObject({ code: "document_not_draft" });
    }
    db.rows("sign_documents")[0].account_id = OTHER;
    expect(await codeOf(deleteDocument(ctx, db.rows("sign_documents")[0].id as string))).toMatchObject({ code: "document_not_found", status: 404 });
  });
});

describe("what the database says", () => {
  it("maps the retention errors to codes a caller can word", () => {
    expect(fromDatabaseError({ message: "sign_document_retained", details: "A signed document is kept until 2033-10-06." })).toMatchObject({ code: "document_retained", status: 409 });
    expect(fromDatabaseError({ message: "sign_retention_cannot_shorten" })).toMatchObject({ code: "retention_cannot_shorten", status: 409 });
    expect(fromDatabaseError({ message: "sign_document_cannot_be_deleted" })).toMatchObject({ code: "document_cannot_be_deleted", status: 409 });
  });
});
