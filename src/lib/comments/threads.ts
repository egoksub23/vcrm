// ============================================================
// Comments inbox, grouped by post: the pure rules behind the list and the thread.
//
//   * the post row the left column shows (comes from comment_posts_inbox(), migration 180)
//   * turning a post's flat list of comments into a conversation (oldest first, replies under the comment they answer)
//   * folding one author's many OPEN comments into a single block
//   * which comments are new since the person last looked
//   * selection for the bulk bar, and which comments a bulk action applies to
//   * the reply target and the "flat list" preference
//
// No React and no Node modules here: the browser and the routes both import it, and the tests run it directly.
// ============================================================
import type { CommentCapabilities, CommentHandled, CommentPost, CommentProvider, CommentRow } from './types'

// ---- the left column ---------------------------------------------------------------------------------------------------------------------

/** The four views of the list. They filter POSTS (see the migration for the exact rules). */
export const POST_VIEWS = ['open', 'done', 'spam', 'all'] as const
export type PostView = (typeof POST_VIEWS)[number]

/** One row of comment_posts_inbox(): a post with its counts, its newest customer comment and the viewer's unread flag. */
export interface InboxPost {
  post_id: string
  provider: CommentProvider
  source: 'organic' | 'ad'
  external_post_id: string
  message: string | null
  permalink_url: string | null
  media_url: string | null
  media_type: string | null
  posted_at: string | null
  open_count: number
  done_count: number
  spam_count: number
  total_count: number
  last_comment_id: string | null
  last_comment_text: string | null
  last_author_name: string | null
  last_author_username: string | null
  /** When the newest customer comment ARRIVED here (drives unread). */
  last_comment_at: string | null
  /** When the newest customer comment was written on the platform (shown, and the sort key). */
  last_provider_created_at: string | null
  has_test: boolean
  unread: boolean
  seen_at: string | null
}

/** Name to show for whoever wrote a comment, or null when we know nothing about them. */
export function authorLabel(c: { author_name: string | null; author_username: string | null }): string | null {
  const name = c.author_name?.trim()
  const user = c.author_username?.trim()
  return name || user || null
}

/** The viewer is looking at `selectedId`, so that post never shows a dot, whatever the list last said. */
export function showUnread(post: Pick<InboxPost, 'post_id' | 'unread'>, selectedId: string | null): boolean {
  return post.unread && post.post_id !== selectedId
}

/** Collapse whitespace and cut to `max` characters with an ellipsis (for one-line snippets). */
export function snippet(text: string | null | undefined, max = 80): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/**
 * A comment arrived (or was handled) for a post the list already holds: update that ONE row in place, never add a second.
 * Used for the instant local update before the list is refetched. Returns the list in display order (newest comment first).
 */
export function upsertPostRow(rows: InboxPost[], next: InboxPost): InboxPost[] {
  const without = rows.filter((r) => r.post_id !== next.post_id)
  const merged = [...without, next]
  return merged.sort((a, b) => {
    const ta = a.last_provider_created_at ? Date.parse(a.last_provider_created_at) : 0
    const tb = b.last_provider_created_at ? Date.parse(b.last_provider_created_at) : 0
    return tb - ta || (a.post_id < b.post_id ? 1 : -1)
  })
}

// ---- the thread --------------------------------------------------------------------------------------------------------------------------

/** One comment as the thread route returns it: the row, plus what can be done to it right now. */
export interface ThreadComment extends CommentRow {
  parent_external_id: string | null
  created_at: string
  capabilities: CommentCapabilities
}

/** The post as the thread header shows it. */
export type ThreadPost = Pick<
  CommentPost,
  'id' | 'provider' | 'source' | 'external_post_id' | 'message' | 'permalink_url' | 'media_url' | 'media_type' | 'posted_at'
>

export interface ThreadNode {
  comment: ThreadComment
  /** Comments that answer this one, oldest first. */
  replies: ThreadNode[]
  /** A reply whose parent is not in this thread (not fetched yet, or deleted at the source): shown at the top level. */
  orphan: boolean
}

const byTime = (a: ThreadComment, b: ThreadComment) =>
  Date.parse(a.provider_created_at) - Date.parse(b.provider_created_at) || (a.id < b.id ? -1 : 1)

/**
 * The comments of one post as a conversation: top-level comments oldest first, each followed by the comments that answer it, oldest first.
 * A reply finds its parent by `parent_comment_id`, or, when the parent arrived after the reply and was never linked, by
 * `parent_external_id`. A reply whose parent is not here stays visible at the top level, marked as an orphan.
 */
export function buildThread(comments: ThreadComment[]): ThreadNode[] {
  const sorted = [...comments].sort(byTime)
  const nodes = new Map<string, ThreadNode>()
  const byExternal = new Map<string, ThreadNode>()
  for (const c of sorted) {
    const node: ThreadNode = { comment: c, replies: [], orphan: false }
    nodes.set(c.id, node)
    byExternal.set(c.external_comment_id, node)
  }

  const roots: ThreadNode[] = []
  for (const c of sorted) {
    const node = nodes.get(c.id)!
    const parent =
      (c.parent_comment_id ? nodes.get(c.parent_comment_id) : undefined) ??
      (c.parent_external_id ? byExternal.get(c.parent_external_id) : undefined)
    if (parent && parent !== node && !isAncestor(node, parent, nodes, byExternal)) {
      parent.replies.push(node)
    } else {
      node.orphan = !!(c.parent_comment_id || c.parent_external_id)
      roots.push(node)
    }
  }
  return roots
}

/** True when `maybeAncestor` is reachable by following parents up from `start` (guards a bad parent link from looping forever). */
function isAncestor(
  maybeDescendant: ThreadNode,
  start: ThreadNode,
  nodes: Map<string, ThreadNode>,
  byExternal: Map<string, ThreadNode>,
): boolean {
  let cur: ThreadNode | undefined = start
  for (let i = 0; cur && i < 50; i++) {
    if (cur === maybeDescendant) return true
    const c: ThreadComment = cur.comment
    cur =
      (c.parent_comment_id ? nodes.get(c.parent_comment_id) : undefined) ??
      (c.parent_external_id ? byExternal.get(c.parent_external_id) : undefined)
  }
  return false
}

/** Every comment of a node and of the nodes under it. */
export function flattenNode(node: ThreadNode): ThreadComment[] {
  return [node.comment, ...node.replies.flatMap(flattenNode)]
}

/** Is this a customer comment still waiting for a first response, and not deleted at the source? */
export function isOpenCustomerComment(c: Pick<CommentRow, 'direction' | 'handled_status' | 'status'>): boolean {
  return c.direction === 'inbound' && c.handled_status === 'open' && c.status !== 'deleted'
}

// ---- one person, many comments -----------------------------------------------------------------------------------------------------------

/** One author folds into a block once they have this many open comments in a post. */
export const AUTHOR_BLOCK_MIN = 3

/** Who wrote it, as one comparable key: the platform id when there is one, else the username, else the name. */
export function authorKey(c: Pick<CommentRow, 'direction' | 'author_external_id' | 'author_username' | 'author_name'>): string | null {
  if (c.direction !== 'inbound') return null
  const id = c.author_external_id?.trim()
  if (id) return `id:${id}`
  const user = c.author_username?.trim().toLowerCase()
  if (user) return `u:${user}`
  const name = c.author_name?.trim().toLowerCase()
  return name ? `n:${name}` : null
}

export type ThreadEntry =
  | { kind: 'node'; node: ThreadNode }
  | { kind: 'author-block'; key: string; label: string; nodes: ThreadNode[] }

/**
 * Fold one author's OPEN top-level comments into a single block when they have `min` or more of them, placed where the author's first open
 * comment is. Everything else (handled comments, replies, other authors, anyone below the threshold) stays a plain entry, so a block
 * dissolves by itself as its comments are handled.
 */
export function groupAuthorBlocks(roots: ThreadNode[], min: number = AUTHOR_BLOCK_MIN): ThreadEntry[] {
  const open = new Map<string, ThreadNode[]>()
  for (const node of roots) {
    if (!isOpenCustomerComment(node.comment)) continue
    const key = authorKey(node.comment)
    if (!key) continue
    const list = open.get(key)
    if (list) list.push(node)
    else open.set(key, [node])
  }

  const entries: ThreadEntry[] = []
  const placed = new Set<string>()
  for (const node of roots) {
    const key = isOpenCustomerComment(node.comment) ? authorKey(node.comment) : null
    const members = key ? open.get(key) : undefined
    if (key && members && members.length >= min) {
      if (placed.has(key)) continue
      placed.add(key)
      entries.push({ kind: 'author-block', key, label: authorLabel(node.comment) ?? '', nodes: members })
    } else {
      entries.push({ kind: 'node', node })
    }
  }
  return entries
}

/** The comments an entry stands for (a block's members and their replies, or a node and its replies). */
export function entryComments(entry: ThreadEntry): ThreadComment[] {
  return entry.kind === 'node' ? flattenNode(entry.node) : entry.nodes.flatMap(flattenNode)
}

/** The open customer comments of a block, which is what its group actions apply to. */
export function blockOpenIds(entry: Extract<ThreadEntry, { kind: 'author-block' }>): string[] {
  return entry.nodes.map((n) => n.comment).filter(isOpenCustomerComment).map((c) => c.id)
}

// ---- new since you last looked -----------------------------------------------------------------------------------------------------------

/**
 * Which customer comments are new to the person: they arrived after the post was last opened (`seenAt`, null when it never was), or they
 * were not in the thread when it was opened (`knownIds`, the live arrivals). The two sets are added together.
 */
export function newCommentIds(
  comments: Pick<ThreadComment, 'id' | 'direction' | 'created_at'>[],
  opts: { seenAt: string | null; knownIds: ReadonlySet<string> | null },
): Set<string> {
  const out = new Set<string>()
  const seen = opts.seenAt ? Date.parse(opts.seenAt) : null
  for (const c of comments) {
    if (c.direction !== 'inbound') continue
    if (seen !== null && Date.parse(c.created_at) > seen) out.add(c.id)
    else if (opts.knownIds && !opts.knownIds.has(c.id)) out.add(c.id)
  }
  return out
}

/** Index of the first entry that holds a new comment (where the "New" divider goes), or -1. */
export function firstNewEntryIndex(entries: ThreadEntry[], newIds: ReadonlySet<string>): number {
  if (newIds.size === 0) return -1
  return entries.findIndex((e) => entryComments(e).some((c) => newIds.has(c.id)))
}

// ---- selection and bulk ------------------------------------------------------------------------------------------------------------------

export type BulkOp = 'resolve' | 'spam' | 'reopen' | 'hide' | 'unhide'

export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Drop selected ids that are no longer in the thread (a comment was deleted, another post opened). */
export function pruneSelection(selected: ReadonlySet<string>, present: ReadonlySet<string>): Set<string> {
  const next = new Set<string>()
  for (const id of selected) if (present.has(id)) next.add(id)
  return next.size === selected.size ? (selected as Set<string>) : next
}

/** Customer comments that can carry a checkbox: not ours, not deleted. */
export function selectableIds(comments: Pick<ThreadComment, 'id' | 'direction' | 'status'>[]): string[] {
  return comments.filter((c) => c.direction === 'inbound' && c.status !== 'deleted').map((c) => c.id)
}

/**
 * Which of `comments` a bulk operation applies to, and which are left alone (and why), so the bar can say "3 of 5" before it sends anything.
 * The server applies the same rules and is the one that decides.
 */
export function bulkTargets(
  op: BulkOp,
  comments: Pick<ThreadComment, 'id' | 'direction' | 'status' | 'handled_status' | 'capabilities'>[],
): { ids: string[]; skipped: string[] } {
  const ids: string[] = []
  const skipped: string[] = []
  for (const c of comments) {
    if (c.direction !== 'inbound' || c.status === 'deleted') {
      skipped.push(c.id)
      continue
    }
    const h: CommentHandled = c.handled_status
    const ok =
      op === 'resolve' ? h === 'open'
      : op === 'spam' ? h !== 'spam'
      : op === 'reopen' ? h === 'resolved' || h === 'spam'
      : op === 'hide' ? c.capabilities.hide
      : c.capabilities.unhide
    ;(ok ? ids : skipped).push(c.id)
  }
  return { ids, skipped }
}

/** Hiding and marking spam ask once before they run; marking handled does not. */
export function needsConfirm(op: BulkOp): boolean {
  return op === 'hide' || op === 'spam'
}

/** A bulk request carries at most this many ids; longer lists are sent in chunks. */
export const BULK_CHUNK = 50

export function chunk<T>(items: readonly T[], size: number = BULK_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** The per-comment answer to a bulk request. `skipped` = nothing to do (already in that state). */
export interface BulkResult {
  id: string
  ok: boolean
  skipped?: boolean
  error?: string
  reason?: string
}

export interface BulkSummary {
  done: number
  skipped: number
  failed: BulkResult[]
}

export function summariseBulk(results: readonly BulkResult[]): BulkSummary {
  const failed = results.filter((r) => !r.ok)
  return {
    done: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.ok && r.skipped).length,
    failed,
  }
}

// ---- the reply target --------------------------------------------------------------------------------------------------------------------

export type ReplyMode = 'reply' | 'private_reply'

export interface ReplyTarget {
  commentId: string
  mode: ReplyMode
}

/**
 * The comment the reply box is aimed at, as the line above the box shows it. Null when nothing is chosen, when the comment is gone, or
 * when what the mode needs is not allowed for it (the box then says nothing is selected rather than offering a send that would fail).
 */
export function resolveReplyTarget(
  target: ReplyTarget | null,
  comments: ThreadComment[],
): { comment: ThreadComment; mode: ReplyMode; label: string; snippet: string; allowed: boolean } | null {
  if (!target) return null
  const comment = comments.find((c) => c.id === target.commentId)
  if (!comment || comment.direction !== 'inbound' || comment.status === 'deleted') return null
  const allowed = target.mode === 'reply' ? comment.capabilities.reply : comment.capabilities.privateReply
  return {
    comment,
    mode: target.mode,
    label: authorLabel(comment) ?? '',
    snippet: snippet(comment.text, 80),
    allowed,
  }
}

// ---- the flat list preference ------------------------------------------------------------------------------------------------------------

export const FLAT_LIST_KEY = 'vircle.comments.flatList'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The storage key for one person (two people sharing a browser each keep their own choice). */
export function flatPrefKey(userId: string | null | undefined): string {
  return `${FLAT_LIST_KEY}:${userId ?? 'anon'}`
}

/** Remembered per person on this device; every access is guarded because storage can be blocked or empty. */
export function readFlatPref(storage: StorageLike | null | undefined, userId?: string | null): boolean {
  try {
    return storage?.getItem(flatPrefKey(userId)) === '1'
  } catch {
    return false
  }
}

export function writeFlatPref(storage: StorageLike | null | undefined, flat: boolean, userId?: string | null): void {
  try {
    storage?.setItem(flatPrefKey(userId), flat ? '1' : '0')
  } catch {
    // blocked storage: the toggle still works for this visit
  }
}
