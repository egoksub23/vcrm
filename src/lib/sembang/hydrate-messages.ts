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

import type { SembangAttachment, SembangLinkPreview, SembangMessage, SembangReactionSummary } from '@/types'
import { resolveAttachmentUrls } from './resolve-attachment-urls'

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
  // Migration 101. Selected with `select('*')` so it comes through once
  // 101 is applied; typed as possibly-absent for the same pre-migration
  // compile reason as the 099 columns above.
  also_in_channel?: boolean
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

/** Migration 107. */
interface LinkPreviewRow {
  message_id: string
  url: string
  title: string | null
  description: string | null
  image_url: string | null
  domain: string | null
}

/** Migration 101. The `{id, body, author_id}` of a reply's parent, for
 *  building `SembangMessage.parentPreview`. */
interface ParentRow {
  id: string
  body: string
  author_id: string
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
  // Migration 101. Every DISTINCT parent a row in this batch replies to
  // (regardless of whether that parent is itself in `rows`) — fetched in
  // one query below to build `parentPreview`.
  const parentIds = Array.from(
    new Set(rows.filter((r) => r.parent_message_id).map((r) => r.parent_message_id as string)),
  )

  const [
    { data: profileRows },
    { data: attachmentRows },
    { data: reactionRows },
    { data: linkPreviewRows },
    { data: replyRows },
    { data: starRows },
    { data: parentRows },
  ] = await Promise.all([
    supabase.from('profiles').select('user_id, full_name, avatar_url').in('user_id', authorIds),
    supabase.from('sembang_attachments').select('*').in('message_id', messageIds),
    supabase.from('sembang_reactions').select('message_id, user_id, emoji').in('message_id', messageIds),
    supabase
      .from('sembang_link_previews')
      .select('message_id, url, title, description, image_url, domain')
      .in('message_id', messageIds),
    topLevelIds.length > 0
      ? supabase
          .from('sembang_messages')
          .select('parent_message_id, created_at')
          .in('parent_message_id', topLevelIds)
          .is('deleted_at', null)
      : Promise.resolve({ data: [] as { parent_message_id: string; created_at: string }[] }),
    // Migration 100. Personal — only the caller's own stars, turned into a
    // Set below (same pattern as `reactedByMe`, just pre-filtered to one
    // user rather than grouped across all of them).
    supabase.from('sembang_stars').select('message_id').eq('user_id', callerUserId).in('message_id', messageIds),
    // Migration 101. Defensive: a parent id can come back empty if the
    // row was somehow removed outright (normally `ON DELETE SET NULL`
    // means this never happens, see the caller-facing comment on
    // `SembangMessage.parentPreview`) — handled below by just leaving
    // `parentPreview` null for that row rather than throwing.
    parentIds.length > 0
      ? supabase.from('sembang_messages').select('id, body, author_id').in('id', parentIds)
      : Promise.resolve({ data: [] as ParentRow[] }),
  ])

  const profileByUser = new Map<string, { full_name: string | null; avatar_url: string | null }>()
  for (const p of profileRows ?? []) profileByUser.set(p.user_id, p)

  // Migration 101. Parents by id, for `parentPreview` below. A parent
  // whose id isn't in this map (row not found — deleted, or the FK went
  // `SET NULL` already) just leaves `parentPreview` null for its children
  // rather than throwing (see the ParentRow query's comment above).
  const parentById = new Map<string, ParentRow>()
  for (const p of (parentRows ?? []) as ParentRow[]) parentById.set(p.id, p)

  // Batch the parents' authors' names too, one query — reusing
  // `profileByUser` where a parent's author already appears in `rows`
  // (the common case: replying inside the same page of messages), and
  // only querying for the rest.
  const parentAuthorIds = Array.from(
    new Set(Array.from(parentById.values()).map((p) => p.author_id).filter((id) => !profileByUser.has(id))),
  )
  if (parentAuthorIds.length > 0) {
    const { data: parentProfileRows } = await supabase
      .from('profiles')
      .select('user_id, full_name, avatar_url')
      .in('user_id', parentAuthorIds)
    for (const p of parentProfileRows ?? []) profileByUser.set(p.user_id, p)
  }

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
  await resolveAttachmentUrls(supabase, allAttachments, pathById)

  const reactionsByMessage = new Map<string, ReactionRow[]>()
  for (const r of (reactionRows ?? []) as ReactionRow[]) {
    const list = reactionsByMessage.get(r.message_id) ?? []
    list.push(r)
    reactionsByMessage.set(r.message_id, list)
  }

  const starredIds = new Set<string>((starRows ?? []).map((s) => s.message_id as string))

  const linkPreviewByMessage = new Map<string, SembangLinkPreview>()
  for (const p of (linkPreviewRows ?? []) as LinkPreviewRow[]) {
    linkPreviewByMessage.set(p.message_id, {
      url: p.url,
      title: p.title,
      description: p.description,
      imageUrl: p.image_url,
      domain: p.domain,
    })
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
    const parent = row.parent_message_id ? parentById.get(row.parent_message_id) : undefined
    const parentAuthorProfile = parent ? profileByUser.get(parent.author_id) : undefined
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
      starredByMe: starredIds.has(row.id),
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      createdAt: row.created_at,
      author: profile
        ? { id: row.author_id, fullName: profile.full_name ?? '', avatarUrl: profile.avatar_url }
        : null,
      attachments: attachmentsByMessage.get(row.id) ?? [],
      linkPreview: linkPreviewByMessage.get(row.id) ?? null,
      ...(isTopLevel ? { replyCount: summary?.count ?? 0, lastReplyAt: summary?.lastReplyAt ?? null } : {}),
      // Migration 101. Plain passthrough — defaulted to `false` for a
      // pre-101 row shape (see `also_in_channel?` above).
      alsoInChannel: row.also_in_channel ?? false,
      // Null for a top-level message, and also null if the parent
      // couldn't be resolved (defensive — see the ParentRow query above).
      parentPreview: parent
        ? { id: parent.id, body: parent.body, authorName: parentAuthorProfile?.full_name ?? '' }
        : null,
    }
  })
}
