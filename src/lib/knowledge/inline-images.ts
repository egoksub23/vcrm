import { kbImageUrlForPath, listKbImages, type KbImagePolicy } from '@/lib/knowledge-format'
import type { StagedKnowledgeAttachment } from '@/lib/knowledge-types'

// ============================================================
// Inline images of a knowledge article: where they may live, and how the
// article's HTML and its attachment list are kept consistent.
//
// An inline image is one `<img>` in `content_html` AND one attachment row with
// `inline = true`, so the per-file "send with AI answers" switch, the size and
// count caps and the cleanup on removal all apply to it. These rules are pure
// so the routes stay thin and the editor and the server agree.
// ============================================================

/** The images policy for an account, from the project's public Supabase URL.
 *  Null when the URL is not configured (then no article image is accepted). */
export function kbImagePolicy(accountId: string): KbImagePolicy | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  return { accountId, publicBaseUrl: base }
}

/**
 * The sending order of an article's files: its inline images in the order they
 * appear in the document, then every other file in the order given. An inline
 * image that appears twice counts at its first place; one that no longer
 * appears goes after the others that do (it keeps its relative order).
 *
 * `srcs` are the image URLs of the document in order; `urlOf` is the URL of an
 * item (the editor's rows carry it, the server derives it from the object path).
 */
export function orderForDocument<T extends object>(
  items: T[],
  srcs: string[],
  urlOf: (item: T) => string | null,
): T[] {
  const first = new Map<string, number>()
  srcs.forEach((s, i) => {
    if (!first.has(s)) first.set(s, i)
  })
  const rank = (item: T): number => {
    if (!(item as { inline?: boolean }).inline) return Number.MAX_SAFE_INTEGER
    const url = urlOf(item)
    return url !== null && first.has(url) ? first.get(url)! : Number.MAX_SAFE_INTEGER - 1
  }
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item)
}

export type InlineCheck =
  | { ok: true; items: StagedKnowledgeAttachment[] }
  | { ok: false; error: string }

/**
 * Make the attachment list agree with the article's (already sanitised) HTML.
 *
 *  - Every image in the HTML must be a file in the list marked inline (or, for
 *    a translation, one of the base article's images, given as `extraUrls`);
 *    otherwise the save is refused, because the image could never be sent
 *    with the answer or cleaned up.
 *  - A file marked inline that is no longer in the HTML is kept as a plain
 *    attachment (nothing is deleted behind the person's back), and only an
 *    image can be inline.
 *  - The list is put in document order (see `orderForDocument`).
 */
export function reconcileInlineImages(input: {
  html: string
  items: StagedKnowledgeAttachment[]
  policy: KbImagePolicy | null
  extraUrls?: string[]
}): InlineCheck {
  const { html, items, policy } = input
  // Images the sanitiser kept are, by construction, this account's own files.
  const srcs = listKbImages(html, { images: policy }).map((i) => i.src)
  const urlOf = (item: StagedKnowledgeAttachment) => kbImageUrlForPath(policy, item.storage_path)

  const known = new Map<string, StagedKnowledgeAttachment>()
  for (const item of items) {
    const url = urlOf(item)
    if (url !== null) known.set(url, item)
  }
  const extra = new Set(input.extraUrls ?? [])
  for (const src of srcs) {
    if (extra.has(src)) continue
    const item = known.get(src)
    if (!item || !item.inline) {
      return {
        ok: false,
        error: 'An image in the article is not in its attachments list. Remove it and add it again.',
      }
    }
  }

  const used = new Set(srcs)
  const reconciled = items.map((item) => {
    if (!item.inline) return item
    const url = urlOf(item)
    const isImage = item.mime_type.toLowerCase().startsWith('image/')
    return url !== null && used.has(url) && isImage ? item : { ...item, inline: false }
  })
  return { ok: true, items: orderForDocument(reconciled, srcs, urlOf) }
}
