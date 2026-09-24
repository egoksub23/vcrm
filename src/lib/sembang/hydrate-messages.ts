// ============================================================
// Shared Sembang message hydration.
//
// Joins `profiles` (author), `sembang_attachments`, `sembang_reactions`,
// and — for top-level messages only — a reply-count/last-reply-at
// summary onto raw `sembang_messages` rows. Used by every route that
// returns a `SembangMessage` (or something containing one): the channel
// message list/search, the thread-replies route, and the pins route.
// Extracted here (rather than duplicated) per SPEC-P1's own suggestion.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import type { SembangAttachment, SembangMessage, SembangReactionSummary } from '@/types'

/** Matches `SEMBANG_SIGNED_URL_TTL_SECONDS` in `@/lib/storage/upload-sembang-file`
 *  (kept as a plain literal here rather than imported — that module pulls
 *  in the browser Supabase client and must stay client-only). */
const SIGNED_URL_TTL_SECONDS = 60 * 60

export interface SembangMessageRow {
  id: string
  channel_id: string
  account_id: string
  author_id: string
  body: string
  mentions: string[] | null
  // Migration 099 columns. Selected with `select('*')` so they come
  // through once 099 is applied; typed here as possibly-absent so this
  // file still compiles against a pre-099 database too.
  parent_message_id?: string | null
  edited_at?: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
}

interface AttachmentRow {
  id: string
  message_id: string
  storage_path: string
  filename: string
  size_bytes: number
  mime_type: string | null
  created_at: string
}

interface ReactionRow {
  message_id: string
  user_id: string
  emoji: string
}

/** Groups raw `sembang_reactions` rows (all for one message) into the
 *  `SembangReactionSummary[]` shape the API returns. Exported so the
 *  reaction-toggle route can reuse it for its own single-message
 *  response without going through the whole message hydration path. */
export function groupReactions(
  rows: { emoji: string; user_id: string }[],
  callerUserId: string,
): SembangReactionSummary[] {
  const userIdsByEmoji = new Map<string, string[]>()
  for (const r of rows) {
    const list = userIdsByEmoji.get(r.emoji) ?? []
    list.push(r.user_id)
    userIdsByEmoji.set(r.emoji, list)
  }
  return Array.from(userIdsByEmoji.entries()).map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
    reactedByMe: userIds.includes(callerUserId),
  }))
}

export async function hydrateMessages(
  supabase: SupabaseClient,
  rows: SembangMessageRow[],
  callerUserId: string,
): Promise<SembangMessage[]> {
  if (rows.length === 0) return []

  const authorIds = Array.from(new Set(rows.map((r) => r.author_id)))
  const messageIds = rows.map((r) => r.id)
  const topLevelIds = rows.filter((r) => !r.parent_message_id).map((r) => r.id)

  const [
    { data: profileRows },
    { data: attachmentRows },
    { data: reactionRows },
    { data: replyRows },
  ] = await Promise.all([
    supabase.from('profiles').select('user_id, full_name, avatar_url').in('user_id', authorIds),
    supabase.from('sembang_attachments').select('*').in('message_id', messageIds),
    supabase.from('sembang_reactions').select('message_id, user_id, emoji').in('message_id', messageIds),
    topLevelIds.length > 0
      ? supabase
          .from('sembang_messages')
          .select('parent_message_id, created_at')
          .in('parent_message_id', topLevelIds)
          .is('deleted_at', null)
      : Promise.resolve({ data: [] as { parent_message_id: string; created_at: string }[] }),
  ])

  const profileByUser = new Map<string, { full_name: string | null; avatar_url: string | null }>()
  for (const p of profileRows ?? []) profileByUser.set(p.user_id, p)

  const attachmentsByMessage = new Map<string, SembangAttachment[]>()
  const pathById = new Map<string, string>()
  for (const a of (attachmentRows ?? []) as AttachmentRow[]) {
    pathById.set(a.id, a.storage_path)
    const attachment: SembangAttachment = {
      id: a.id,
      messageId: a.message_id,
      filename: a.filename,
      sizeBytes: a.size_bytes,
      mimeType: a.mime_type,
      // Resolved below, in parallel, then patched back in.
      url: '',
      createdAt: a.created_at,
    }
    const list = attachmentsByMessage.get(a.message_id) ?? []
    list.push(attachment)
    attachmentsByMessage.set(a.message_id, list)
  }

  // Resolve a signed URL per attachment, in parallel. A failed signed-URL
  // fetch (object went missing, etc.) does not fail the whole request —
  // the attachment just renders with an empty url.
  const allAttachments = Array.from(attachmentsByMessage.values()).flat()
  await Promise.all(
    allAttachments.map(async (a) => {
      const path = pathById.get(a.id)
      if (!path) return
      const { data, error } = await supabase.storage
        .from('sembang-files')
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
      if (error) {
        console.error('[hydrateMessages] createSignedUrl error:', error)
        return
      }
      a.url = data?.signedUrl ?? ''
    }),
  )

  const reactionsByMessage = new Map<string, ReactionRow[]>()
  for (const r of (reactionRows ?? []) as ReactionRow[]) {
    const list = reactionsByMessage.get(r.message_id) ?? []
    list.push(r)
    reactionsByMessage.set(r.message_id, list)
  }

  // Grouped in application code, not SQL — one flat query, then
  // aggregated the same way reactions are, above.
  const threadSummaryByParent = new Map<string, { count: number; lastReplyAt: string }>()
  for (const r of replyRows ?? []) {
    const existing = threadSummaryByParent.get(r.parent_message_id)
    if (!existing) {
      threadSummaryByParent.set(r.parent_message_id, { count: 1, lastReplyAt: r.created_at })
    } else {
      existing.count += 1
      if (r.created_at > existing.lastReplyAt) existing.lastReplyAt = r.created_at
    }
  }

  return rows.map((row) => {
    const profile = profileByUser.get(row.author_id)
    const isTopLevel = !row.parent_message_id
    const summary = isTopLevel ? threadSummaryByParent.get(row.id) : undefined
    return {
      id: row.id,
      channelId: row.channel_id,
      accountId: row.account_id,
      authorId: row.author_id,
      body: row.body,
      mentions: row.mentions ?? [],
      parentMessageId: row.parent_message_id ?? null,
      editedAt: row.edited_at ?? null,
      reactions: groupReactions(reactionsByMessage.get(row.id) ?? [], callerUserId),
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      createdAt: row.created_at,
      author: profile
        ? { id: row.author_id, fullName: profile.full_name ?? '', avatarUrl: profile.avatar_url }
        : null,
      attachments: attachmentsByMessage.get(row.id) ?? [],
      ...(isTopLevel ? { replyCount: summary?.count ?? 0, lastReplyAt: summary?.lastReplyAt ?? null } : {}),
    }
  })
}
