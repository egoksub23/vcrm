// ============================================================
// Doc Sign files. Everything lives in the private `sign-documents` bucket, under the workspace's own
// folder (`account-<id>/`, which the usage meter and the workspace export already understand). Only the
// server (service role) reads or writes; a browser is only ever handed a short-lived signed link, or
// the bytes through a route that checks who is asking.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { appStorage } from "@/lib/storage/provider";
import { SIGN_BUCKET } from "./types";

// Re-exported so existing callers of this module keep working without changes.
export type { FileKind } from "./path-utils";
export { safeFileName, documentPath, templatePath, belongsToAccount } from "./path-utils";

export class StorageError extends Error {
  readonly code: "storage_write_failed" | "storage_read_failed" | "storage_forbidden_path";
  constructor(code: StorageError["code"], message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export async function putFile(_admin: SupabaseClient, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await appStorage().from(SIGN_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new StorageError("storage_write_failed", `Could not store the file: ${error.message}`);
}

export async function getFile(_admin: SupabaseClient, path: string, accountId: string): Promise<Uint8Array> {
  if (!belongsToAccount(path, accountId)) throw new StorageError("storage_forbidden_path", "That file is not in this workspace.");
  const { data, error } = await appStorage().from(SIGN_BUCKET).download(path);
  if (error || !data) throw new StorageError("storage_read_failed", `Could not read the file: ${error?.message ?? "not found"}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function copyFile(_admin: SupabaseClient, from: string, to: string, accountId: string): Promise<void> {
  if (!belongsToAccount(from, accountId) || !belongsToAccount(to, accountId)) throw new StorageError("storage_forbidden_path", "That file is not in this workspace.");
  const { error } = await appStorage().from(SIGN_BUCKET).copy(from, to);
  if (error) throw new StorageError("storage_write_failed", `Could not copy the file: ${error.message}`);
}

/** Remove files, best effort: a leftover file is harmless, a failed delete must not fail the request. */
export async function removeFiles(_admin: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await appStorage().from(SIGN_BUCKET).remove(paths);
  } catch {
    // ignore
  }
}
