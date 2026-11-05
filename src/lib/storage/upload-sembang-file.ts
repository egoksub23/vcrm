/**
 * Client-side upload helper for Sembang's private `sembang-files` bucket
 * (migration 098) — a private-bucket sibling of `upload-media.ts`'s
 * `uploadAccountMedia()`. Same account-scoped path convention
 * (`account-<id>/sembang/<channelId>/<ts>-<basename>.<ext>`) but the
 * bucket is PRIVATE, so there is no public URL to hand back — callers get
 * the storage path only. Reading an attachment resolves a short-lived signed
 * URL server-side, in the GET messages route.
 *
 * Upload goes through POST /api/media/upload (server-side), which resolves
 * the account and writes to the active storage provider. The composer calls
 * this BEFORE `POST /api/sembang/channels/[id]/messages`, then passes the
 * result's `path`/`filename`/etc. in that request's `attachments` array.
 */

/** 16 MB — matches the `sembang-files` bucket's `file_size_limit` (migration 098). */
export const SEMBANG_MAX_BYTES = 16 * 1024 * 1024;

/**
 * TTL for a signed URL into `sembang-files`. Short-lived by design (the
 * bucket is private); the GET messages route re-resolves a fresh one on
 * every read rather than persisting a long-lived link anywhere.
 */
export const SEMBANG_SIGNED_URL_TTL_SECONDS = 60 * 60;

export interface UploadSembangFileResult {
  /** Storage object path (account- and channel-scoped). */
  path: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * Upload a file to the `sembang-files` bucket under the given channel and
 * return its storage path. Throws with a user-facing message on auth /
 * account-resolution / upload failure — callers surface it via a toast.
 *
 * Size validation is the caller's responsibility (`SEMBANG_MAX_BYTES` is
 * exported for the common case); the bucket's own `file_size_limit` /
 * `allowed_mime_types` are the last line of defense either way.
 */
export async function uploadSembangFile(
  channelId: string,
  file: File,
): Promise<UploadSembangFileResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("bucket", "sembang-files");
  formData.append("subfolder", `sembang/${channelId}`);

  const res = await fetch("/api/media/upload", { method: "POST", body: formData });
  if (!res.ok) {
    const msg = await res.text().catch(() => "Upload failed");
    throw new Error(msg || "Upload failed");
  }
  const { path } = (await res.json()) as { path: string };
  return {
    path,
    filename: file.name,
    sizeBytes: file.size,
    mimeType: file.type || "application/octet-stream",
  };
}
