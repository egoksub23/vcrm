// ============================================================
// Doc Sign files. Everything lives in the private `sign-documents` bucket, under the workspace's own
// folder (`account-<id>/`, which the usage meter and the workspace export already understand). Only the
// server (service role) reads or writes; a browser is only ever handed a short-lived signed link, or
// the bytes through a route that checks who is asking.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { SIGN_BUCKET } from "./types";

export type FileKind = "source" | "base" | "annex" | "upload" | "final" | "certificate";

/** A name safe to keep in a storage path. */
export function safeFileName(name: string, fallback = "file"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function documentPath(accountId: string, documentId: string, kind: FileKind, name: string): string {
  return `account-${accountId}/${documentId}/${kind}/${name}`;
}

export function templatePath(accountId: string, templateId: string, name: string): string {
  return `account-${accountId}/templates/${templateId}/${name}`;
}

/** The workspace folder a path must sit in; used to refuse a stored path that points somewhere else. */
export function belongsToAccount(path: string, accountId: string): boolean {
  return path.startsWith(`account-${accountId}/`) && !path.includes("..");
}

export class StorageError extends Error {
  readonly code: "storage_write_failed" | "storage_read_failed" | "storage_forbidden_path";
  constructor(code: StorageError["code"], message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export async function putFile(admin: SupabaseClient, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await admin.storage.from(SIGN_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new StorageError("storage_write_failed", `Could not store the file: ${error.message}`);
}

export async function getFile(admin: SupabaseClient, path: string, accountId: string): Promise<Uint8Array> {
  if (!belongsToAccount(path, accountId)) throw new StorageError("storage_forbidden_path", "That file is not in this workspace.");
  const { data, error } = await admin.storage.from(SIGN_BUCKET).download(path);
  if (error || !data) throw new StorageError("storage_read_failed", `Could not read the file: ${error?.message ?? "not found"}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function copyFile(admin: SupabaseClient, from: string, to: string, accountId: string): Promise<void> {
  if (!belongsToAccount(from, accountId) || !belongsToAccount(to, accountId)) throw new StorageError("storage_forbidden_path", "That file is not in this workspace.");
  const { error } = await admin.storage.from(SIGN_BUCKET).copy(from, to);
  if (error) throw new StorageError("storage_write_failed", `Could not copy the file: ${error.message}`);
}

/** Remove files, best effort: a leftover file is harmless, a failed delete must not fail the request. */
export async function removeFiles(admin: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await admin.storage.from(SIGN_BUCKET).remove(paths);
  } catch {
    // ignore
  }
}
