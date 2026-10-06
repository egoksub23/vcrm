// ============================================================
// Files a signer attaches to a form (an ID card, a company extract). One file at a time, through its own
// route, because a file is not an autosaved value. Everything is decided here, on the server, from the bytes:
//
//   the field    must be a `file` field of a part of the signer's own role, shown, and not locked
//   the session  the link's code (when the document asks for one) is checked by the route, consent here
//   the bytes    PDF, JPEG or PNG by their first bytes, never by the name or the type the browser claims;
//                within the field's `accept`, its `maxMb` (default 5, at most 10), its `maxFiles` (default 1)
//                and 50 MB for the whole document
//
// The file is stored privately under the document's own folder, fingerprinted with SHA-256, recorded as a
// sign_document_files row and as the field's answer `{ files }`. The path is the server's own and is never
// sent to a browser. Each upload and removal is an audit event (name, size and the start of the fingerprint;
// never the contents), and the certificate lists the uploads.
// ============================================================

import { randomUUID } from "node:crypto";

import { fieldVisible, FILE_KINDS, MAX_UPLOAD_MB, type DataField, type FileKind, type FormDefinition, type StoredFile } from "../forms";
import type { RemoveUploadResult, UploadResult } from "../forms/api-types";
import { sha256Hex } from "../pdf/load";
import { documentPath, getFile, putFile, removeFiles, safeFileName } from "../storage";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf, loadFormState, ownDataFields, recordPartChanges, standing, type FormState } from "./form-state";
import { assertConsented, assertOpen, type Lookup } from "./signing";

export const MAX_DOCUMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_MB = 5;
export const DEFAULT_MAX_FILES = 1;

const MIME: Record<FileKind, string> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };

/** What the bytes are, from their first bytes: a PDF, a JPEG or a PNG; null for anything else. */
export function detectKind(bytes: Uint8Array): FileKind | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "png";
  return null;
}

interface Target {
  doc: SignDocumentRow;
  signer: SignSignerRow;
  form: FormDefinition;
  field: DataField;
  state: FormState;
}

/** The file field a signer may touch, with the document's answers as they stand. Throws a SignError otherwise. */
async function ownFileField(ctx: SignCtx, lookup: Lookup, fieldKey: string, opts: { shown: boolean }): Promise<Target> {
  assertOpen(lookup);
  assertConsented(lookup);
  const { doc, signer } = lookup;
  const form = formOf(doc);
  const field = form?.fields.find((f) => f.key === fieldKey);
  if (!form || !field) throw new SignError("not_your_field", "That field is not yours to fill in.", 403);
  if (!ownDataFields(form, signer.role_key).has(field.key)) throw new SignError("not_your_field", "That field is not yours to fill in.", 403);
  if (field.type !== "file") throw new SignError("not_a_file_field", "That field does not take a file.", 400);
  if (field.locked) throw new SignError("locked", "That field cannot be changed.", 403);
  const { state } = await loadFormState(ctx, doc, form);
  if (opts.shown && !fieldVisible(form, field, state.map)) throw new SignError("not_shown", "That field is not shown.", 409);
  return { doc, signer, form, field, state };
}

const filesOf = (state: FormState, key: string): StoredFile[] => {
  const v = state.map[key];
  return v && "files" in v ? v.files : [];
};

/** Write the field's answer: the list of files, or no answer at all when the list is empty. */
async function writeFiles(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, key: string, files: StoredFile[]): Promise<void> {
  if (files.length === 0) {
    const { error } = await ctx.admin.from("sign_answers").delete().eq("document_id", doc.id).eq("signer_id", signer.id).eq("field_key", key);
    if (error) raiseDatabaseError(error, "clear files");
    return;
  }
  const { error } = await ctx.admin
    .from("sign_answers")
    .upsert({ account_id: ctx.accountId, document_id: doc.id, signer_id: signer.id, field_key: key, value: { files }, source: "signer", saved_at: ctx.now().toISOString() }, { onConflict: "document_id,signer_id,field_key" });
  if (error) raiseDatabaseError(error, "save files");
}

async function currentFiles(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, key: string): Promise<StoredFile[]> {
  const { data, error } = await ctx.admin.from("sign_answers").select("value").eq("document_id", doc.id).eq("signer_id", signer.id).eq("field_key", key).maybeSingle();
  if (error) raiseDatabaseError(error, "read files");
  const v = (data as { value?: { files?: StoredFile[] } } | null)?.value;
  return Array.isArray(v?.files) ? v.files : [];
}

export async function uploadFile(ctx: SignCtx, lookup: Lookup, args: { field: string; file: { bytes: Uint8Array; name: string } | null }): Promise<UploadResult> {
  const { doc, signer, form, field, state } = await ownFileField(ctx, lookup, args.field, { shown: true });
  if (!args.file || args.file.bytes.byteLength === 0) throw new SignError("no_file", "Choose a file to upload.", 400);
  const bytes = args.file.bytes;

  const kind = detectKind(bytes);
  if (!kind) throw new SignError("unsupported_file", "Only PDF, JPG and PNG files can be uploaded.", 400);
  const accept = field.accept && field.accept.length ? field.accept.filter((k) => FILE_KINDS.includes(k)) : [...FILE_KINDS];
  if (!accept.includes(kind)) throw new SignError("file_type_not_allowed", "This kind of file is not accepted here.", 400, [{ code: "file_type_not_allowed", field: field.key, detail: accept.join(",") }]);

  const maxMb = Math.min(field.maxMb && field.maxMb > 0 ? field.maxMb : DEFAULT_MAX_MB, MAX_UPLOAD_MB);
  if (bytes.byteLength > maxMb * 1024 * 1024) throw new SignError("file_too_large", `This file is larger than ${maxMb} MB.`, 413, [{ code: "file_too_large", field: field.key, detail: String(maxMb) }]);

  const maxFiles = field.maxFiles && field.maxFiles > 0 ? field.maxFiles : DEFAULT_MAX_FILES;
  if (filesOf(state, field.key).length >= maxFiles) throw new SignError("too_many_files", `This field takes up to ${maxFiles} file${maxFiles === 1 ? "" : "s"}.`, 400, [{ code: "too_many_files", field: field.key, detail: String(maxFiles) }]);

  const used = await ctx.admin.from("sign_document_files").select("size_bytes").eq("document_id", doc.id).eq("account_id", ctx.accountId).eq("kind", "signer_upload");
  if (used.error) raiseDatabaseError(used.error, "measure uploads");
  const total = ((used.data ?? []) as { size_bytes: number }[]).reduce((n, r) => n + Number(r.size_bytes || 0), 0);
  if (total + bytes.byteLength > MAX_DOCUMENT_UPLOAD_BYTES) throw new SignError("document_upload_limit", "This document has reached its limit for uploaded files.", 413);

  const id = randomUUID();
  const name = safeFileName(args.file.name, "file");
  const path = documentPath(ctx.accountId, doc.id, "upload", `${id}-${name}`);
  const sha256 = sha256Hex(bytes);
  await putFile(ctx.admin, path, bytes, MIME[kind]);
  const ins = await ctx.admin.from("sign_document_files").insert({ id, account_id: ctx.accountId, document_id: doc.id, kind: "signer_upload", signer_id: signer.id, path, name, mime: MIME[kind], size_bytes: bytes.byteLength, sha256 });
  if (ins.error) {
    await removeFiles(ctx.admin, [path]);
    raiseDatabaseError(ins.error, "record upload");
  }
  const stored: StoredFile = { id, name, mime: MIME[kind], size: bytes.byteLength, sha256, path };

  // Two uploads arriving together each read the list and write it back: read again and add ours if the other won.
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const files = (await currentFiles(ctx, doc, signer, field.key)).filter((f) => f.id !== id);
      await writeFiles(ctx, doc, signer, field.key, [...files, stored]);
      if ((await currentFiles(ctx, doc, signer, field.key)).some((f) => f.id === id)) break;
    }
  } catch (err) {
    // the answer could not be written: leave no file behind that nothing refers to
    await ctx.admin.from("sign_document_files").delete().eq("id", id).eq("account_id", ctx.accountId);
    await removeFiles(ctx.admin, [path]);
    throw err;
  }

  await logEvent(ctx, doc.id, "uploaded", { actor: "signer", signerId: signer.id, detail: { field: field.key, name, size: bytes.byteLength, hash: sha256.slice(0, 16) } });
  const after = (await loadFormState(ctx, doc, form)).state;
  await recordPartChanges(ctx, doc, signer, form, state, after);
  const { progress, ready } = standing(form, signer.role_key, after);
  return { file: { id, name, mime: stored.mime, size: stored.size, sha256 }, progress, ready };
}

export async function removeUpload(ctx: SignCtx, lookup: Lookup, args: { field: string; id: string }): Promise<RemoveUploadResult> {
  const { doc, signer, form, field, state } = await ownFileField(ctx, lookup, args.field, { shown: false });
  const files = await currentFiles(ctx, doc, signer, field.key);
  const gone = files.find((f) => f.id === args.id);
  if (!gone) throw new SignError("file_not_found", "That file was not found.", 404);

  await writeFiles(ctx, doc, signer, field.key, files.filter((f) => f.id !== gone.id));
  const del = await ctx.admin.from("sign_document_files").delete().eq("id", gone.id).eq("document_id", doc.id).eq("account_id", ctx.accountId).eq("signer_id", signer.id);
  if (del.error) raiseDatabaseError(del.error, "remove upload");
  await removeFiles(ctx.admin, [gone.path]);

  await logEvent(ctx, doc.id, "upload_removed", { actor: "signer", signerId: signer.id, detail: { field: field.key, name: gone.name, hash: gone.sha256.slice(0, 16) } });
  const after = (await loadFormState(ctx, doc, form)).state;
  await recordPartChanges(ctx, doc, signer, form, state, after);
  const { progress, ready } = standing(form, signer.role_key, after);
  return { progress, ready };
}

/** One of the signer's own files, for a preview. Only a file in their own answer; never another person's. */
export async function readOwnUpload(ctx: SignCtx, lookup: Lookup, args: { field: string; id: string }): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
  const { doc, signer } = lookup;
  const form = formOf(doc);
  const field = form?.fields.find((f) => f.key === args.field);
  if (!form || !field || field.type !== "file" || !ownDataFields(form, signer.role_key).has(field.key)) throw new SignError("not_your_field", "That field is not yours to fill in.", 403);
  const file = (await currentFiles(ctx, doc, signer, field.key)).find((f) => f.id === args.id);
  if (!file || !file.path.startsWith(`account-${ctx.accountId}/${doc.id}/upload/`)) throw new SignError("file_not_found", "That file was not found.", 404);
  return { bytes: await getFile(ctx.admin, file.path, ctx.accountId), mime: file.mime, name: file.name };
}
