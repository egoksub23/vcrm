import { describe, expect, it } from 'vitest'
import {
  AUTHOR_BLOCK_MIN,
  BULK_CHUNK,
  blockOpenIds,
  buildThread,
  bulkTargets,
  chunk,
  entryComments,
  firstNewEntryIndex,
  flatPrefKey,
  flattenNode,
  groupAuthorBlocks,
  needsConfirm,
  newCommentIds,
  pruneSelection,
  readFlatPref,
  resolveReplyTarget,
  selectableIds,
  showUnread,
  snippet,
  summariseBulk,
  toggleId,
  upsertPostRow,
  writeFlatPref,
  type InboxPost,
  type ThreadComment,
} from './threads'
import { commentCapabilities } from './types'

let n = 0
function comment(over: Partial<ThreadComment> & { minutes?: number } = {}): ThreadComment {
  n += 1
  const { minutes = n, ...rest } = over
  const at = new Date(Date.UTC(2026, 9, 1, 10, minutes)).toISOString()
  const base = {
    id: `c${n}`,
    post_id: 'p1',
    provider: 'instagram' as const,
    external_comment_id: `ext${n}`,
    parent_comment_id: null,
    parent_external_id: null,
    direction: 'inbound' as const,
    author_external_id: `u${n}`,
    author_name: `Person ${n}`,
    author_username: `person${n}`,
    author_avatar_url: null,
    contact_id: null,
    text: `comment ${n}`,
    attachment_url: null,
    status: 'visible' as const,
    handled_status: 'open' as const,
    assigned_to: null,
    private_replied_at: null,
    is_test: false,
    provider_created_at: at,
    created_at: at,
  }
  const merged = { ...base, ...rest }
  return { ...merged, capabilities: commentCapabilities(merged, Date.UTC(2026, 9, 2)) }
}

const ids = (nodes: { comment: { id: string } }[]) => nodes.map((x) => x.comment.id)

describe('buildThread', () => {
  it('orders top-level comments oldest first and puts replies under the comment they answer', () => {
    const a = comment({ id: 'a', minutes: 1 })
    const c = comment({ id: 'c', minutes: 5 })
    const b = comment({ id: 'b', minutes: 3 })
    const reply2 = comment({ id: 'r2', minutes: 9, parent_comment_id: 'a', direction: 'outbound' })
    const reply1 = comment({ id: 'r1', minutes: 4, parent_comment_id: 'a' })
    const roots = buildThread([c, reply2, b, a, reply1])
    expect(ids(roots)).toEqual(['a', 'b', 'c'])
    expect(ids(roots[0].replies)).toEqual(['r1', 'r2'])
    expect(roots[0].replies[1].comment.direction).toBe('outbound')
    expect(flattenNode(roots[0]).map((x) => x.id)).toEqual(['a', 'r1', 'r2'])
  })

  it('links a reply to its parent by the external id when the parent arrived later and was never linked', () => {
    const parent = comment({ id: 'parent', minutes: 5, external_comment_id: 'ext-parent' })
    const early = comment({ id: 'early', minutes: 2, parent_comment_id: null, parent_external_id: 'ext-parent' })
    const roots = buildThread([early, parent])
    expect(ids(roots)).toEqual(['parent'])
    expect(ids(roots[0].replies)).toEqual(['early'])
    expect(roots[0].replies[0].orphan).toBe(false)
  })

  it('keeps a reply whose parent is not in the thread visible at the top level, marked as an orphan', () => {
    const lost = comment({ id: 'lost', minutes: 2, parent_comment_id: null, parent_external_id: 'never-ingested' })
    const other = comment({ id: 'other', minutes: 1 })
    const roots = buildThread([lost, other])
    expect(ids(roots)).toEqual(['other', 'lost'])
    expect(roots[1].orphan).toBe(true)
    expect(roots[0].orphan).toBe(false)
  })

  it('survives a parent link that points at itself or loops', () => {
    const selfRef = comment({ id: 's', minutes: 1, parent_comment_id: 's' })
    const x = comment({ id: 'x', minutes: 2, parent_comment_id: 'y' })
    const y = comment({ id: 'y', minutes: 3, parent_comment_id: 'x' })
    const roots = buildThread([selfRef, x, y])
    // nothing is lost and nothing loops
    expect(roots.flatMap(flattenNode).map((c) => c.id).sort()).toEqual(['s', 'x', 'y'])
  })

  it('handles an empty thread', () => {
    expect(buildThread([])).toEqual([])
  })
})

describe('groupAuthorBlocks', () => {
  const by = (id: string, minutes: number, over: Partial<ThreadComment> = {}) =>
    comment({ id, minutes, author_external_id: 'aya', author_name: 'Aya', author_username: 'ayakorose645', ...over })

  it('folds one author with three or more open comments into a block placed at their first comment', () => {
    const list = [by('a1', 1), comment({ id: 'bob', minutes: 2 }), by('a2', 3), by('a3', 4), comment({ id: 'cy', minutes: 5 })]
    const entries = groupAuthorBlocks(buildThread(list))
    expect(entries.map((e) => (e.kind === 'node' ? e.node.comment.id : `block:${e.nodes.length}`))).toEqual(['block:3', 'bob', 'cy'])
    const block = entries[0]
    expect(block.kind === 'author-block' && block.label).toBe('Aya')
    expect(block.kind === 'author-block' && blockOpenIds(block)).toEqual(['a1', 'a2', 'a3'])
  })

  it('does not fold two comments, or comments that are already handled', () => {
    expect(AUTHOR_BLOCK_MIN).toBe(3)
    const two = groupAuthorBlocks(buildThread([by('a1', 1), by('a2', 2)]))
    expect(two.every((e) => e.kind === 'node')).toBe(true)
    // three comments but only two still open: no block, all three stay visible
    const handled = groupAuthorBlocks(buildThread([by('a1', 1), by('a2', 2), by('a3', 3, { handled_status: 'resolved' })]))
    expect(handled.map((e) => e.kind)).toEqual(['node', 'node', 'node'])
  })

  it('counts only open comments in the block and leaves their handled comments as plain entries', () => {
    const list = [by('a1', 1), by('a2', 2, { handled_status: 'replied' }), by('a3', 3), by('a4', 4), by('a5', 5)]
    const entries = groupAuthorBlocks(buildThread(list))
    expect(entries.map((e) => e.kind)).toEqual(['author-block', 'node'])
    expect(entries[0].kind === 'author-block' && blockOpenIds(entries[0])).toEqual(['a1', 'a3', 'a4', 'a5'])
    expect(entries[1].kind === 'node' && entries[1].node.comment.id).toBe('a2')
  })

  it('never folds our own comments, deleted comments, replies or authors we cannot tell apart', () => {
    const own = [1, 2, 3].map((i) => comment({ id: `o${i}`, minutes: i, direction: 'outbound', handled_status: 'open', author_external_id: 'page' }))
    expect(groupAuthorBlocks(buildThread(own)).every((e) => e.kind === 'node')).toBe(true)
    const deleted = [1, 2, 3].map((i) => by(`d${i}`, i, { status: 'deleted' }))
    expect(groupAuthorBlocks(buildThread(deleted)).every((e) => e.kind === 'node')).toBe(true)
    const noId = [1, 2, 3].map((i) => comment({ id: `n${i}`, minutes: i, author_external_id: null, author_name: null, author_username: null }))
    expect(groupAuthorBlocks(buildThread(noId)).every((e) => e.kind === 'node')).toBe(true)
    // replies stay under the comment they answer
    const parent = comment({ id: 'p', minutes: 1 })
    const replies = [1, 2, 3].map((i) => by(`r${i}`, i + 1, { parent_comment_id: 'p' }))
    const entries = groupAuthorBlocks(buildThread([parent, ...replies]))
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('node')
  })

  it('matches an author by platform id, falling back to username, then name (case-insensitive)', () => {
    const list = [
      comment({ id: 'u1', minutes: 1, author_external_id: null, author_username: 'Aya_R', author_name: null }),
      comment({ id: 'u2', minutes: 2, author_external_id: null, author_username: 'aya_r', author_name: null }),
      comment({ id: 'u3', minutes: 3, author_external_id: null, author_username: 'AYA_R', author_name: null }),
    ]
    const entries = groupAuthorBlocks(buildThread(list))
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('author-block')
  })

  it('lists the comments an entry stands for, replies included', () => {
    const a1 = by('a1', 1)
    const reply = comment({ id: 'ours', minutes: 2, parent_comment_id: 'a1', direction: 'outbound' })
    const entries = groupAuthorBlocks(buildThread([a1, reply, by('a2', 3), by('a3', 4)]))
    expect(entryComments(entries[0]).map((c) => c.id)).toEqual(['a1', 'ours', 'a2', 'a3'])
  })
})

describe('new comments', () => {
  const list = [
    comment({ id: 'old', minutes: 1 }),
    comment({ id: 'mid', minutes: 5 }),
    comment({ id: 'ours', minutes: 8, direction: 'outbound' }),
    comment({ id: 'late', minutes: 9 }),
  ]
  const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString()

  it('marks customer comments that arrived after the post was last opened', () => {
    expect([...newCommentIds(list, { seenAt: at(3), knownIds: null })]).toEqual(['mid', 'late'])
  })

  it('never marks our own comments', () => {
    expect(newCommentIds(list, { seenAt: at(0), knownIds: null }).has('ours')).toBe(false)
  })

  it('marks live arrivals that were not there when the thread was opened, together with the unread ones', () => {
    const known = new Set(['old', 'mid', 'ours'])
    expect([...newCommentIds(list, { seenAt: at(7), knownIds: known })]).toEqual(['late'])
    expect([...newCommentIds(list, { seenAt: null, knownIds: known })]).toEqual(['late'])
  })

  it('has no new comments the first time a post is opened with nothing to compare against', () => {
    expect(newCommentIds(list, { seenAt: null, knownIds: null }).size).toBe(0)
  })

  it('finds where the New divider goes', () => {
    const entries = groupAuthorBlocks(buildThread(list))
    expect(firstNewEntryIndex(entries, new Set(['late']))).toBe(3)
    expect(firstNewEntryIndex(entries, new Set(['mid', 'late']))).toBe(1)
    expect(firstNewEntryIndex(entries, new Set())).toBe(-1)
  })
})

describe('selection and bulk', () => {
  it('toggles an id without changing the original set', () => {
    const base = new Set(['a'])
    const added = toggleId(base, 'b')
    expect([...added]).toEqual(['a', 'b'])
    expect([...base]).toEqual(['a'])
    expect([...toggleId(added, 'a')]).toEqual(['b'])
  })

  it('drops ticks for comments that are gone, and keeps the same set when nothing is gone', () => {
    const sel = new Set(['a', 'b'])
    expect([...pruneSelection(sel, new Set(['b', 'c']))]).toEqual(['b'])
    expect(pruneSelection(sel, new Set(['a', 'b', 'c']))).toBe(sel)
  })

  it('offers a tick only on customer comments that still exist', () => {
    expect(
      selectableIds([
        comment({ id: 'in' }),
        comment({ id: 'out', direction: 'outbound' }),
        comment({ id: 'gone', status: 'deleted' }),
      ]),
    ).toEqual(['in'])
  })

  it('decides who a bulk operation applies to', () => {
    const open = comment({ id: 'open' })
    const replied = comment({ id: 'replied', handled_status: 'replied' })
    const resolved = comment({ id: 'resolved', handled_status: 'resolved' })
    const spam = comment({ id: 'spam', handled_status: 'spam' })
    const hidden = comment({ id: 'hidden', status: 'hidden' })
    const ours = comment({ id: 'ours', direction: 'outbound' })
    const gone = comment({ id: 'gone', status: 'deleted' })
    const all = [open, replied, resolved, spam, hidden, ours, gone]
    expect(bulkTargets('resolve', all).ids).toEqual(['open', 'hidden'])
    expect(bulkTargets('spam', all).ids).toEqual(['open', 'replied', 'resolved', 'hidden'])
    expect(bulkTargets('reopen', all).ids).toEqual(['resolved', 'spam'])
    expect(bulkTargets('hide', all).ids).toEqual(['open', 'replied', 'resolved', 'spam'])
    expect(bulkTargets('unhide', all).ids).toEqual(['hidden'])
    expect(bulkTargets('hide', all).skipped).toEqual(['hidden', 'ours', 'gone'])
  })

  it('asks before hiding or marking spam, not before marking handled', () => {
    expect(needsConfirm('hide')).toBe(true)
    expect(needsConfirm('spam')).toBe(true)
    expect(needsConfirm('resolve')).toBe(false)
    expect(needsConfirm('reopen')).toBe(false)
  })

  it('sends long lists in chunks', () => {
    const list = Array.from({ length: BULK_CHUNK * 2 + 3 }, (_, i) => i)
    const parts = chunk(list)
    expect(parts.map((p) => p.length)).toEqual([BULK_CHUNK, BULK_CHUNK, 3])
    expect(parts.flat()).toEqual(list)
    expect(chunk([])).toEqual([])
  })

  it('reports every failure by comment instead of dropping it', () => {
    const s = summariseBulk([
      { id: 'a', ok: true },
      { id: 'b', ok: true, skipped: true },
      { id: 'c', ok: false, error: 'Instagram rejected it' },
      { id: 'd', ok: false, error: 'Comment not found.' },
    ])
    expect(s.done).toBe(1)
    expect(s.skipped).toBe(1)
    expect(s.failed.map((f) => [f.id, f.error])).toEqual([
      ['c', 'Instagram rejected it'],
      ['d', 'Comment not found.'],
    ])
  })
})

describe('reply target', () => {
  const a = comment({ id: 'a', author_name: 'Aya', text: 'love this   so much\nreally' })
  const reply = comment({ id: 'reply', parent_comment_id: 'a', provider: 'instagram' })
  const tiktok = comment({ id: 'tt', provider: 'tiktok' })
  const ours = comment({ id: 'ours', direction: 'outbound' })

  it('describes the comment the reply box is aimed at', () => {
    const r = resolveReplyTarget({ commentId: 'a', mode: 'reply' }, [a])
    expect(r?.label).toBe('Aya')
    expect(r?.snippet).toBe('love this so much really')
    expect(r?.allowed).toBe(true)
    expect(r?.mode).toBe('reply')
  })

  it('is empty when nothing is chosen, or the comment is gone, ours or deleted', () => {
    expect(resolveReplyTarget(null, [a])).toBeNull()
    expect(resolveReplyTarget({ commentId: 'zzz', mode: 'reply' }, [a])).toBeNull()
    expect(resolveReplyTarget({ commentId: 'ours', mode: 'reply' }, [ours])).toBeNull()
    expect(resolveReplyTarget({ commentId: 'a', mode: 'reply' }, [{ ...a, status: 'deleted' }])).toBeNull()
  })

  it('uses the existing rules for what is allowed, per mode', () => {
    // Instagram only replies to a top-level comment
    expect(resolveReplyTarget({ commentId: 'reply', mode: 'reply' }, [reply])?.allowed).toBe(false)
    // TikTok has no private reply
    expect(resolveReplyTarget({ commentId: 'tt', mode: 'private_reply' }, [tiktok])?.allowed).toBe(false)
    expect(resolveReplyTarget({ commentId: 'tt', mode: 'reply' }, [tiktok])?.allowed).toBe(true)
  })
})

describe('post rows', () => {
  const row = (id: string, at: string, over: Partial<InboxPost> = {}): InboxPost => ({
    post_id: id,
    provider: 'instagram',
    source: 'organic',
    external_post_id: id,
    message: id,
    permalink_url: null,
    media_url: null,
    media_type: null,
    posted_at: null,
    open_count: 1,
    done_count: 0,
    spam_count: 0,
    total_count: 1,
    last_comment_id: null,
    last_comment_text: null,
    last_author_name: null,
    last_author_username: null,
    last_comment_at: at,
    last_provider_created_at: at,
    has_test: false,
    unread: false,
    seen_at: null,
    ...over,
  })

  it('updates a post in place and moves it to the top; it is never listed twice', () => {
    const rows = [row('b', '2026-10-01T12:00:00Z'), row('a', '2026-10-01T11:00:00Z'), row('c', '2026-10-01T10:00:00Z')]
    const next = upsertPostRow(rows, row('a', '2026-10-01T13:00:00Z', { open_count: 4, total_count: 9, unread: true }))
    expect(next.map((r) => r.post_id)).toEqual(['a', 'b', 'c'])
    expect(next[0]).toMatchObject({ open_count: 4, total_count: 9, unread: true })
    expect(next.filter((r) => r.post_id === 'a')).toHaveLength(1)
  })

  it('adds a post that is not on the page yet', () => {
    expect(upsertPostRow([row('a', '2026-10-01T11:00:00Z')], row('z', '2026-10-01T12:00:00Z')).map((r) => r.post_id)).toEqual(['z', 'a'])
  })

  it('never shows a dot on the post that is open', () => {
    expect(showUnread({ post_id: 'a', unread: true }, 'b')).toBe(true)
    expect(showUnread({ post_id: 'a', unread: true }, 'a')).toBe(false)
    expect(showUnread({ post_id: 'a', unread: false }, 'b')).toBe(false)
  })

  it('cuts a snippet on whitespace and length', () => {
    expect(snippet('  a \n b  ', 10)).toBe('a b')
    expect(snippet('x'.repeat(100), 10)).toHaveLength(10)
    expect(snippet('x'.repeat(100), 10).endsWith('…')).toBe(true)
    expect(snippet(null)).toBe('')
  })
})

describe('flat list preference', () => {
  const store = (initial: Record<string, string> = {}) => {
    const m = { ...initial }
    return { m, getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => void (m[k] = v) }
  }

  it('defaults to grouped, and remembers the choice per person', () => {
    const s = store()
    expect(readFlatPref(s, 'u1')).toBe(false)
    writeFlatPref(s, true, 'u1')
    expect(readFlatPref(s, 'u1')).toBe(true)
    expect(readFlatPref(s, 'u2')).toBe(false)
    writeFlatPref(s, false, 'u1')
    expect(readFlatPref(s, 'u1')).toBe(false)
    expect(Object.keys(s.m)).toEqual([flatPrefKey('u1')])
  })

  it('does not throw when storage is blocked or missing', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceeded')
      },
    }
    expect(readFlatPref(blocked, 'u1')).toBe(false)
    expect(() => writeFlatPref(blocked, true, 'u1')).not.toThrow()
    expect(readFlatPref(null, 'u1')).toBe(false)
    expect(() => writeFlatPref(undefined, true)).not.toThrow()
  })
})
