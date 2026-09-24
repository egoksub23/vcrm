import { createClient } from "@/lib/supabase/client";
import { buildMediaPath } from "@/lib/storage/upload-media";

/**
 * Client-side upload helper for Sembang's private `sembang-files` bucket
 * (migration 098) — a private-bucket sibling of `upload-media.ts`'s
 * `uploadAccountMedia()`. Same account-scoped path convention
 * (`account-<id>/sembang/<channelId>/<ts>-<basename>.<ext>`, built via the
 * shared `buildMediaPath` helper with `subfolder = "sembang/<channelId>"`)
 * but the bucket is PRIVATE, so there is no public URL to hand back —
 * callers get the storage path only. Reading an attachment back (e.g.
 * rendering it in the thread) resolves a short-lived signed URL
 * SERVER-SIDE, in the GET messages route, not here.
 *
 * Runs entirely client-side: the browser already holds an authenticated
 * Supabase session, and migration 098's storage RLS policies (account-id
 * path prefix + `menu.sembang`) authorize the upload directly — no API
 * round trip needed before the object lands in Storage. The composer
 * calls this BEFORE `POST /api/sembang/channels/[id]/messages`, then
 * passes the result's `path`/`filename`/etc. in that request's
 * `attachments` array.
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
  const supabase = createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new Error("Not signed in.");
  }

  // Resolve account_id so the path is account-scoped (matches the
  // bucket's RLS write policy from migration 098). User-scoped paths
  // would be rejected.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profileErr || !profile?.account_id) {
    throw new Error("Could not resolve your account.");
  }

  const path = buildMediaPath(
    profile.account_id as string,
    file.name,
    Date.now(),
    `sembang/${channelId}`,
  );
  const { error: upErr } = await supabase.storage.from("sembang-files").upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    // Some files (.pptx from certain browsers, unknown extensions) arrive
    // with an empty type; the bucket's allow-list accepts the generic one.
    contentType: file.type || "application/octet-stream",
  });
  if (upErr) throw new Error(upErr.message);

  return {
    path,
    filename: file.name,
    sizeBytes: file.size,
    mimeType: file.type || "application/octet-stream",
  };
}
