// ============================================================
// Compliance requests: evidence files (an authorization letter, proof of a transaction). Server only.
//
// The bytes live in the PRIVATE bucket `compliance-files` under `account-<workspace>/<case>/<file>-<name>`; only the server (service role) reads or
// writes them, a browser is only ever handed bytes through the download route, which checks who is asking, writes a 'view' event and answers
// `no-store`. The rules are Secure Sign's upload rules: PDF, JPEG or PNG by their FIRST BYTES (never the name or the type the browser claims), a size
// cap per file, a count and a total cap per case, a SHA-256 kept with the row. Files cannot be changed or deleted by anyone (the database refuses,
// retention): a wrong upload stays on the record, with a note.
// ============================================================

import { createHash, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { DETECTED_MIME, detectFileKind } from "@/lib/net/file-kind";
import { belongsToAccount, safeFileName } from "@/lib/sign/storage";

import { ComplianceError, complianceError, fromDatabase } from "../errors";
import { logEvent } from "./events";
import { loadRow, loadType } from "./read";
import type { ComplianceCaller } from "./rows";

export const COMPLIANCE_BUCKET = "compliance-files";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 15;
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024;

export function filePath(accountId: string, requestId: string, fileId: string, name: string): string {
  return `account-${accountId}/${requestId}/${fileId}-${name}`;
}

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

/** What an evidence file is, from its first bytes, or a refusal. The name and the type the browser claims decide nothing. */
export function checkEvidence(bytes: Uint8Array): { mime: string } {
  if (bytes.byteLength === 0) throw new ComplianceError("unsupported_file", "Choose a file to upload.", 400);
  const kind = detectFileKind(bytes);
  if (!kind) throw new ComplianceError("unsupported_file", "Only PDF, JPG and PNG files can be uploaded.", 400);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ComplianceError("file_too_large", "That file is larger than 10 MB.", 413);
  return { mime: DETECTED_MIME[kind] };
}

export interface StoredEvidence {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
}

/** Put the bytes in the private bucket under the case's folder. Nothing is recorded yet; `recordEvidence` does that once the case exists. */
export async function putEvidence(admin: SupabaseClient, accountId: string, requestId: string, file: { bytes: Uint8Array; name: string }): Promise<StoredEvidence> {
  const { mime } = checkEvidence(file.bytes);
  const id = randomUUID();
  const name = safeFileName(file.name, "file");
  const path = filePath(accountId, requestId, id, name);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const up = await admin.storage.from(COMPLIANCE_BUCKET).upload(path, file.bytes, { contentType: mime, upsert: false });
  if (up.error) throw complianceError("storage_failed");
  return { id, name, mime, size: file.bytes.byteLength, sha256, path };
}

/** The row for a stored file (its trigger writes the 'attachment' event in the same transaction). Removes the object when the row cannot be written. */
export async function recordEvidence(admin: SupabaseClient, accountId: string, requestId: string, stored: StoredEvidence, fieldKey: string | null, uploadedBy: string | null): Promise<void> {
  const ins = await admin.from("compliance_request_files").insert({
    id: stored.id,
    account_id: accountId,
    request_id: requestId,
    field_key: fieldKey,
    name: stored.name,
    mime: stored.mime,
    size_bytes: stored.size,
    sha256: stored.sha256,
    path: stored.path,
    uploaded_by: uploadedBy,
  });
  if (ins.error) {
    // leave no object behind that nothing refers to
    await admin.storage.from(COMPLIANCE_BUCKET).remove([stored.path]).catch(() => undefined);
    throw fromDatabase(ins.error);
  }
}

export async function uploadFile(
  admin: SupabaseClient,
  caller: ComplianceCaller,
  requestId: string,
  file: { bytes: Uint8Array; name: string },
  fieldKey: string | null,
): Promise<UploadedFile> {
  if (!(caller.viewer.canReview || caller.viewer.canApprove)) throw complianceError("forbidden");
  const row = await loadRow(admin, caller.accountId, requestId);
  if (row.status === "closed") throw complianceError("closed");
  checkEvidence(file.bytes);
  if (fieldKey !== null) {
    const type = await loadType(admin, caller.accountId, row.type_key);
    if (!type?.fields.some((f) => f.key === fieldKey && f.type === "file")) throw complianceError("invalid_request");
  }

  const existing = await admin.from("compliance_request_files").select("size_bytes").eq("request_id", row.id).eq("account_id", caller.accountId);
  if (existing.error) throw complianceError("server_error");
  const rows = (existing.data ?? []) as { size_bytes: number }[];
  if (rows.length >= MAX_FILES_PER_REQUEST) throw new ComplianceError("too_many_files", "This request has reached its limit of files.", 400);
  if (rows.reduce((n, r) => n + Number(r.size_bytes || 0), 0) + file.bytes.byteLength > MAX_REQUEST_BYTES) throw new ComplianceError("file_too_large", "This request has reached its limit for uploaded files.", 413);

  const stored = await putEvidence(admin, caller.accountId, row.id, file);
  await recordEvidence(admin, caller.accountId, row.id, stored, fieldKey, caller.userId);
  return { id: stored.id, name: stored.name, mime: stored.mime, size: stored.size, sha256: stored.sha256 };
}

export interface DownloadedFile {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

/** The bytes of one file of a case. The 'view' event (with the file's id) is written FIRST; when it cannot be written nothing is returned. */
export async function downloadFile(admin: SupabaseClient, caller: ComplianceCaller, requestId: string, fileId: string): Promise<DownloadedFile> {
  if (!(caller.viewer.canReview || caller.viewer.canApprove || caller.viewer.canReveal)) throw complianceError("forbidden");
  const row = await loadRow(admin, caller.accountId, requestId);
  const { data, error } = await admin
    .from("compliance_request_files")
    .select("id, name, mime, path")
    .eq("id", fileId)
    .eq("request_id", row.id)
    .eq("account_id", caller.accountId)
    .maybeSingle();
  if (error) throw complianceError("server_error");
  if (!data) throw complianceError("not_found");
  const f = data as { id: string; name: string; mime: string; path: string };
  if (!belongsToAccount(f.path, caller.accountId)) throw complianceError("not_found");
  if (!(await logEvent(admin, { accountId: caller.accountId, requestId: row.id, actor: caller.userId, kind: "view", detail: { file: f.id, name: f.name } }))) throw complianceError("audit_failed");
  const dl = await admin.storage.from(COMPLIANCE_BUCKET).download(f.path);
  if (dl.error || !dl.data) throw complianceError("storage_failed");
  return { bytes: new Uint8Array(await dl.data.arrayBuffer()), name: f.name, mime: f.mime };
}
