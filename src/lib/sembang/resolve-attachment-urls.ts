// ============================================================
// Shared signed-URL resolution for Sembang attachments — extracted out
// of hydrate-messages.ts so the new channel-wide Files listing
// (GET .../channels/[id]/files) can resolve URLs the same way without
// going through full message hydration (reactions, threads, etc. that
// a Files list doesn't need).
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

/** Matches `SEMBANG_SIGNED_URL_TTL_SECONDS` in `@/lib/storage/upload-sembang-file`
 *  (kept as a plain literal here rather than imported — that module pulls
 *  in the browser Supabase client and must stay client-only). */
export const SEMBANG_SIGNED_URL_TTL_SECONDS = 60 * 60

/** Resolves a signed URL for each attachment, in parallel, mutating
 *  `.url` in place. A failed signed-URL fetch (object went missing,
 *  etc.) does not throw — that attachment is just left with `url: ''`,
 *  same as every existing caller already tolerates. */
export async function resolveAttachmentUrls<T extends { id: string; url: string }>(
  supabase: SupabaseClient,
  attachments: T[],
  pathById: Map<string, string>,
): Promise<void> {
  await Promise.all(
    attachments.map(async (a) => {
      const path = pathById.get(a.id)
      if (!path) return
      const { data, error } = await supabase.storage
        .from('sembang-files')
        .createSignedUrl(path, SEMBANG_SIGNED_URL_TTL_SECONDS)
      if (error) {
        console.error('[resolveAttachmentUrls] createSignedUrl error:', error)
        return
      }
      a.url = data?.signedUrl ?? ''
    }),
  )
}
