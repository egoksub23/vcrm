/**
 * Shared media-upload helper.
 *
 * Uploads are routed through POST /api/media/upload (server-side), which
 * resolves the account, picks the active storage provider, and returns the
 * stored path and URL. This keeps storage credentials server-side and lets
 * the provider change (filesystem → S3) without touching client code.
 *
 * Account-scoped path convention (unchanged from the Supabase era):
 *
 *   <bucket>/account-<account_id>/<timestamp>-<basename>.<ext>
 *
 * Both the Flows builder (`node-config-form`) and the inbox composer call
 * this so the logic lives in exactly one place.
 */

/** 16 MB — matches the `file_size_limit` on both buckets (migrations 016/020/023). */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that the bucket would accept (≤16 MB) but Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB bucket limit
 * (Meta allows 100 MB, but the bucket — and shared-hosting upload UX —
 * caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

/**
 * Build the account-scoped object path for an upload. Pure + exported so
 * it can be unit-tested without a Supabase client.
 *
 * - `basename` is stripped of its extension, lower-cased non-safe chars
 *   are collapsed to `_`, and it's capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 *
 * `now = null` omits the timestamp prefix entirely. That's for callers
 * whose name is already unique AND who need the path to be *stable*
 * across repeated calls — the inbound mirror (`@/lib/whatsapp/
 * mirror-inbound-media`) keys on Meta's media id so a redelivered
 * webhook rewrites one object instead of orphaning a second copy.
 *
 * `subfolder` inserts one level below `account-<id>`. The bucket's RLS
 * write policies only match the FIRST path segment (migrations 020/023),
 * so nesting below it is free.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number | null = Date.now(),
  subfolder?: string,
): string {
  // Only treat the trailing segment as an extension when there's a real
  // one — a bare name like "README" has no extension and falls back to
  // "bin" rather than becoming "readme".
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  const dir = subfolder
    ? `account-${accountId}/${subfolder}`
    : `account-${accountId}`;
  const stamp = now === null ? "" : `${now}-`;
  return `${dir}/${stamp}${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /**
   * The `/storage/v1/object/public/<bucket>/<path>` URL `getPublicUrl` returns.
   * For the PUBLIC bucket (`public-assets`) it is a real link anyone can open
   * (Meta fetches it, it goes out in emails). For the PRIVATE bucket
   * (`chat-media`) it serves nothing: it is only the identifier stored on the
   * row, and must be signed (`lib/media/signed-urls`, `lib/storage/sign-media`)
   * before anyone can fetch it. See `lib/storage/media-urls`.
   */
  publicUrl: string;
  /** Storage object path (account-scoped). */
  path: string;
}

/**
 * Upload a file to an account-scoped storage bucket and return its stored
 * URL (a public link for `public-assets`, an identifier for private buckets;
 * see `UploadAccountMediaResult`). Throws with a user-facing message on
 * auth / account-resolution / upload failure — callers surface it via a toast.
 *
 * Size validation is the caller's responsibility (limits can differ per
 * feature); `MEDIA_MAX_BYTES` is exported for the common case.
 *
 * `subfolder` nests the object one level below `account-<id>` (the
 * knowledge base uses `kb`); omit it for the flat legacy layout.
 */
export async function uploadAccountMedia(
  bucket: string,
  file: File,
  subfolder?: string,
): Promise<UploadAccountMediaResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("bucket", bucket);
  if (subfolder) formData.append("subfolder", subfolder);

  const res = await fetch("/api/media/upload", { method: "POST", body: formData });
  if (!res.ok) {
    const msg = await res.text().catch(() => "Upload failed");
    throw new Error(msg || "Upload failed");
  }
  const { path, publicUrl } = (await res.json()) as { path: string; publicUrl: string };
  return { publicUrl, path };
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent — a cancelled draft or a failed Meta send —
 * so abandoned attachments don't accumulate in the bucket.
 *
 * Best-effort: callers fire-and-forget and swallow errors (a missed
 * delete is a storage nit, not something to surface to the user).
 */
export async function deleteAccountMedia(
  bucket: string,
  path: string,
): Promise<void> {
  const res = await fetch("/api/media/upload", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket, path }),
  });
  if (!res.ok) throw new Error(await res.text().catch(() => "Delete failed"));
}

/**
 * Recover the storage object path from a URL `getPublicUrl()`
 * returned (`.../object/public/<bucket>/<path>`) — only that URL (an
 * identifier, for a private bucket) is ever persisted on a `messages` row, not the path itself, so
 * deleting a message's attachment later has to parse it back out.
 * Returns null for a URL that doesn't match the expected shape (a
 * pre-migration row, a non-Supabase URL) rather than guessing.
 */
export function storagePathFromPublicUrl(bucket: string, url: string): string | null {
  const marker = `/object/public/${bucket}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  try {
    return decodeURIComponent(url.slice(i + marker.length));
  } catch {
    return null;
  }
}
