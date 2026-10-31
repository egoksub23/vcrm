import type { SupabaseClient } from "@supabase/supabase-js";

import { StorageError } from "@/lib/sign/storage";
import { appStorage } from "@/lib/storage/provider";
import { SHARE_BUCKET } from "./types";

export { StorageError } from "@/lib/sign/storage";

/** A name safe to keep in a storage path (same rules as sign storage). */
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

export function sharePath(accountId: string, shareId: string, name: string): string {
  return `account-${accountId}/share/${shareId}/${name}`;
}

export function belongsToAccount(path: string, accountId: string): boolean {
  return path.startsWith(`account-${accountId}/`) && !path.includes("..");
}

export async function putFile(_admin: SupabaseClient, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await appStorage().from(SHARE_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new StorageError("storage_write_failed", `Could not store the file: ${error.message}`);
}

export async function getFile(_admin: SupabaseClient, path: string, accountId: string): Promise<Uint8Array> {
  if (!belongsToAccount(path, accountId)) throw new StorageError("storage_forbidden_path", "That file is not in this workspace.");
  const { data, error } = await appStorage().from(SHARE_BUCKET).download(path);
  if (error || !data) throw new StorageError("storage_read_failed", `Could not read the file: ${error?.message ?? "not found"}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeFiles(_admin: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await appStorage().from(SHARE_BUCKET).remove(paths);
  } catch {
    // ignore
  }
}
