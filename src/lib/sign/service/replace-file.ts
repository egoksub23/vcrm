// ============================================================
// Replace the file of a draft (F-77). On a draft only: a document that was sent is immutable (its file is fingerprinted and the
// signers have seen it), and the database refuses to change one anyway (sign_documents_guard).
//
// Two steps for the person, one function for both. `dryRun` reads and checks the new file and answers what WOULD happen, which fields
// keep their place and which are flagged (replace-file.ts decides, so the answer and the result cannot differ), without storing
// anything. The real call does the same, then stores the new file, points the draft at it, swaps its file records, removes the old
// files and logs `file_replaced`.
//
// Fields, roles, the form, the signers and every option of the draft stay as they are; only the file, the page count and the fields
// that sat on a page that is gone (they are moved to the last page, flagged) change. A file with the same fingerprint as the one in
// place is refused with `same_file` rather than stored twice.
// ============================================================

import type { ConvertOptions } from "../convert";
import { inspectPdf } from "../pdf/load";
import { planReplace, type ReplacePlan } from "../replace-file";
import { documentPath, getFile, putFile, removeFiles, safeFileName } from "../storage";
import type { SignDocumentRow } from "../types";
import { loadDocument, logEvent, type SignCtx } from "./context";
import { prepareOrThrow } from "./drafts";
import { SignError, raiseDatabaseError } from "./errors";

export interface ReplaceResult extends ReplacePlan {
  /** True when nothing was stored (a dry run). */
  dryRun: boolean;
  document: Pick<SignDocumentRow, "id" | "page_count" | "base_sha256">;
  /** The upload was a Word file or an image, converted to the PDF that is signed. */
  converted: boolean;
}

const stripExt = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();

export async function replaceDraftFile(
  ctx: SignCtx,
  documentId: string,
  args: { bytes: Uint8Array; filename: string; dryRun?: boolean; converter?: ConvertOptions },
): Promise<ReplaceResult> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "The file of a document that was sent cannot be replaced. Void it and send a new one.", 409);
  if (!doc.base_path) throw new SignError("document_has_no_file", "This document has no file to replace.", 409);

  const prepared = await prepareOrThrow(args.bytes, args.filename, args.converter);
  if (prepared.pdfSha256 === doc.base_sha256) throw new SignError("same_file", "This is the file the document already has.", 409);

  const oldInfo = await inspectPdf(await getFile(ctx.admin, doc.base_path, ctx.accountId));
  const plan = planReplace(doc.fields_snapshot, oldInfo.pages, prepared.info.pages);
  const outcome = (document: ReplaceResult["document"], dryRun: boolean): ReplaceResult => ({ ...plan, dryRun, document, converted: prepared.converted });
  if (args.dryRun) return outcome({ id: doc.id, page_count: doc.page_count, base_sha256: doc.base_sha256 }, true);

  const name = safeFileName(args.filename, "document");
  const basePath = documentPath(ctx.accountId, documentId, "base", `${prepared.pdfSha256}.pdf`);
  const created = [basePath];
  await putFile(ctx.admin, basePath, prepared.pdf, "application/pdf");
  let originalPath = basePath;
  const files: Record<string, unknown>[] = [];
  if (prepared.converted) {
    originalPath = documentPath(ctx.accountId, documentId, "source", `${prepared.original.sha256.slice(0, 16)}-${name}`);
    created.push(originalPath);
    await putFile(ctx.admin, originalPath, prepared.original.bytes, prepared.original.mime);
    files.push({ kind: "source", path: originalPath, name, mime: prepared.original.mime, size_bytes: prepared.original.bytes.byteLength, sha256: prepared.original.sha256 });
    files.push({ kind: "converted", path: basePath, name: `${stripExt(name)}.pdf`, mime: "application/pdf", size_bytes: prepared.pdf.byteLength, sha256: prepared.pdfSha256 });
  } else {
    files.push({ kind: "source", path: basePath, name, mime: "application/pdf", size_bytes: prepared.pdf.byteLength, sha256: prepared.pdfSha256 });
  }

  // `eq("status", "draft")` makes a send that happened in the meantime win: nothing is replaced and what was stored is removed
  const updated = await ctx.admin
    .from("sign_documents")
    .update({
      base_path: basePath,
      base_sha256: prepared.pdfSha256,
      page_count: prepared.info.pageCount,
      original_path: originalPath,
      original_type: prepared.original.mime,
      original_sha256: prepared.original.sha256,
      fields_snapshot: plan.fields,
    })
    .eq("id", documentId)
    .eq("account_id", ctx.accountId)
    .eq("status", "draft")
    .select("id, page_count, base_sha256")
    .maybeSingle();
  if (updated.error || !updated.data) {
    await removeFiles(ctx.admin, created.filter((p) => p !== doc.base_path && p !== doc.original_path));
    if (updated.error) raiseDatabaseError(updated.error, "replace the file of a draft");
    throw new SignError("document_not_draft", "This document was sent while its file was being replaced, so nothing was changed.", 409);
  }

  // the records of the old file go, the new ones come; then the old files themselves, from this document's own folder only
  const old = await ctx.admin.from("sign_document_files").select("id, path, kind").eq("document_id", documentId).eq("account_id", ctx.accountId).in("kind", ["source", "converted"]);
  const oldRows = (old.data ?? []) as { id: string; path: string; kind: string }[];
  if (oldRows.length > 0) await ctx.admin.from("sign_document_files").delete().eq("document_id", documentId).eq("account_id", ctx.accountId).in("kind", ["source", "converted"]);
  const ins = await ctx.admin.from("sign_document_files").insert(files.map((f) => ({ ...f, account_id: ctx.accountId, document_id: documentId })));
  if (ins.error) console.error("[sign] could not record the replacement files:", ins.error.message);
  const mine = `account-${ctx.accountId}/${documentId}/`;
  const keep = new Set(created);
  await removeFiles(
    ctx.admin,
    [...new Set([doc.base_path, doc.original_path, ...oldRows.map((r) => r.path)].filter((p): p is string => !!p && p.startsWith(mine) && !keep.has(p)))],
  );

  await logEvent(ctx, documentId, "file_replaced", {
    actor: "user",
    userId: ctx.userId,
    detail: { name, type: prepared.original.mime, converted: prepared.converted, old_pages: plan.oldPageCount, new_pages: plan.newPageCount, flagged: plan.flagged.length, moved: plan.flagged.filter((f) => f.reason === "page_missing").length },
  });
  return outcome(updated.data as ReplaceResult["document"], false);
}
