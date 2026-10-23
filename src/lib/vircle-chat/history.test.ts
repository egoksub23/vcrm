import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/storage/sign-media', () => ({
  signMediaUrl: async (_admin: unknown, url: string, accountId: string, ttl: number) =>
    url.startsWith(`private/${accountId}/`) ? `https://files.example.com/${url}?ttl=${ttl}` : null,
}))

import { answerHistoryFile, answerHistoryPage, HISTORY_FILE_LINK_SECONDS, parseHistoryRequest } from './history'

// ------------------------------------------------------------
// A small in-memory stand-in for the part of the Supabase query builder these queries use, so the cursor, the window and the filters
// are really exercised and not only recorded.
// ------------------------------------------------------------
type Row = Record<string, unknown>

function cmp(col: string, a: unknown, b: unknown): number {
  if (col === 'created_at') return Date.parse(String(a)) - Date.parse(String(b))
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}
function topLevelSplit(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}
function condition(expr: string): (r: Row) => boolean {
  if (expr.startsWith('and(')) {
    const parts = topLevelSplit(expr.slice(4, -1)).map(condition)
    return (r) => parts.every((p) => p(r))
  }
  const [col, op, ...rest] = expr.split('.')
  const val = rest.join('.')
  return (r) => {
    const c = cmp(col!, r[col!], val)
    return op === 'lt' ? c < 0 : op === 'lte' ? c <= 0 : op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'eq' ? c === 0 : false
  }
}

class Query {
  private filters: ((r: Row) => boolean)[] = []
  private orders: { col: string; asc: boolean }[] = []
  private max = Infinity
  constructor(private readonly rows: Row[]) {}
  select() {
    return this
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v)
    return this
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]))
    return this
  }
  not(c: string) {
    this.filters.push((r) => r[c] !== null && r[c] !== undefined)
    return this
  }
  is(c: string) {
    this.filters.push((r) => r[c] === null || r[c] === undefined)
    return this
  }
  gt(c: string, v: string) {
    this.filters.push((r) => cmp(c, r[c], v) > 0)
    return this
  }
  gte(c: string, v: string) {
    this.filters.push((r) => cmp(c, r[c], v) >= 0)
    return this
  }
  lt(c: string, v: string) {
    this.filters.push((r) => cmp(c, r[c], v) < 0)
    return this
  }
  lte(c: string, v: string) {
    this.filters.push((r) => cmp(c, r[c], v) <= 0)
    return this
  }
  or(expr: string) {
    const alts = topLevelSplit(expr).map(condition)
    this.filters.push((r) => alts.some((a) => a(r)))
    return this
  }
  order(col: string, o: { ascending: boolean }) {
    this.orders.push({ col, asc: o.ascending })
    return this
  }
  limit(n: number) {
    this.max = n
    return this
  }
  then(resolve: (r: { data: Row[]; error: null }) => unknown) {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)))
    for (const o of [...this.orders].reverse()) out = [...out].sort((a, b) => (o.asc ? 1 : -1) * cmp(o.col, a[o.col], b[o.col]))
    return resolve({ data: out.slice(0, this.max), error: null })
  }
}

const NOW = Date.parse('2026-10-23T12:00:00Z')
const daysAgo = (d: number, extraMs = 0) => new Date(NOW - d * 24 * 3600 * 1000 + extraMs).toISOString()

function db(tables: Record<string, Row[]>) {
  return { from: (name: string) => new Query(tables[name] ?? []) } as never
}

const msg = (id: string, ageDays: number, extra: Row = {}): Row => ({
  id: `uuid-${id}`,
  message_id: id,
  conversation_id: 'conv-1',
  channel_type: 'vircle_chat',
  is_internal: false,
  pending_delete: false,
  sender_type: 'agent',
  sender_id: 'user-1',
  content_type: 'text',
  content_text: `text of ${id}`,
  media_url: null,
  media_type: null,
  media_animated: null,
  status: 'read',
  reply_to_message_id: null,
  created_at: daysAgo(ageDays),
  ...extra,
})

const tables = (messages: Row[]) => ({
  contacts: [
    { id: 'contact-1', account_id: 'acct-1', wallet_id: 'W123', deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'contact-2', account_id: 'acct-1', wallet_id: 'W999', deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'contact-3', account_id: 'acct-2', wallet_id: 'W123', deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
  ],
  conversations: [
    { id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1' },
    { id: 'conv-2', account_id: 'acct-1', contact_id: 'contact-2' },
    { id: 'conv-3', account_id: 'acct-2', contact_id: 'contact-3' },
  ],
  profiles: [{ user_id: 'user-1', account_id: 'acct-1', full_name: 'Aisha from support' }],
  messages,
})

const page = (rows: Row[], over: Partial<Parameters<typeof answerHistoryPage>[2]> = {}, cfg = { account_id: 'acct-1', history_days: 90 as number | null }) =>
  answerHistoryPage(
    db(tables(rows)),
    cfg,
    { kind: 'page', walletId: 'W123', beforeSentAt: daysAgo(0), beforeServerId: null, limit: 30, notBefore: null, ...over },
    NOW,
  )
const ids = (a: { messages: Record<string, unknown>[] }) => a.messages.map((m) => m.server_id)

// ------------------------------------------------------------

describe('parseHistoryRequest', () => {
  const base = { v: 1, wallet_id: 'W123', before: { sent_at: '2026-10-01T00:00:00Z' } }

  it('reads a page request, with the defaults', () => {
    expect(parseHistoryRequest(base)).toEqual({
      ok: true,
      request: { kind: 'page', walletId: 'W123', beforeSentAt: '2026-10-01T00:00:00.000Z', beforeServerId: null, limit: 30, notBefore: null },
    })
  })

  it('clamps the limit to 1..50 and reads the optional parts', () => {
    const r = (limit: number) => (parseHistoryRequest({ ...base, limit, not_before: '2026-09-20T00:00:00Z', before: { ...base.before, server_id: 'm_1' } }) as { request: { limit: number } }).request.limit
    expect([r(0), r(7), r(500)]).toEqual([1, 7, 50])
    expect(parseHistoryRequest({ ...base, not_before: '2026-09-20T00:00:00Z' })).toMatchObject({ request: { notBefore: '2026-09-20T00:00:00.000Z' } })
  })

  it('reads a request for a file', () => {
    expect(parseHistoryRequest({ v: 1, wallet_id: 'W123', file_for: 'm_old1' })).toEqual({ ok: true, request: { kind: 'file', walletId: 'W123', serverId: 'm_old1' } })
  })

  it.each([
    [null],
    [[]],
    [{ ...base, v: 2 }],
    [{ ...base, wallet_id: '' }],
    [{ ...base, wallet_id: 5 }],
    [{ ...base, before: null }],
    [{ ...base, before: { sent_at: 'x' } }],
    [{ ...base, before: { sent_at: '1970-01-01T00:00:00Z' } }],
    [{ ...base, before: { ...base.before, server_id: 'a,b' } }],
    [{ ...base, before: { ...base.before, server_id: 'a)b' } }],
    [{ ...base, before: { ...base.before, server_id: 5 } }],
    [{ ...base, limit: 'many' }],
    [{ ...base, not_before: 'soon' }],
    [{ v: 1, wallet_id: 'W', file_for: 'a/b' }],
    [{ v: 1, wallet_id: 'W', file_for: 5 }],
  ])('refuses %j', (body) => {
    expect(parseHistoryRequest(body).ok).toBe(false)
  })
})

describe('a page of older messages', () => {
  it('returns the person\'s messages newest page first, oldest first within it, with the fields the contract lists', async () => {
    const out = await page([msg('m_a', 5), msg('m_b', 4, { sender_type: 'customer', sender_id: null, status: 'sent' }), msg('m_c', 3)])
    expect(ids(out)).toEqual(['m_a', 'm_b', 'm_c'])
    expect(out).toMatchObject({ more: false, end: 'start' })
    expect(out.messages[0]).toMatchObject({ direction: 'out', kind: 'text', text: 'text of m_a', status: 'read', sender: { name: 'Aisha from support' }, reply_to: null, media: null })
    expect(out.messages[1]).toMatchObject({ direction: 'in', status: 'sent', sender: { name: null } })
    expect(out.messages[0]!.sent_at).toBe(daysAgo(5))
  })

  it('takes only the limit, says there is more, and the next page continues exactly where the last stopped', async () => {
    const all = [1, 2, 3, 4, 5].map((n) => msg(`m_${n}`, 10 - n)) // m_5 is the newest
    const first = await page(all, { limit: 2 })
    expect(ids(first)).toEqual(['m_4', 'm_5'])
    expect(first).toMatchObject({ more: true, end: null })
    const cursor = first.messages[0]!
    const second = await page(all, { limit: 2, beforeSentAt: cursor.sent_at as string, beforeServerId: cursor.server_id as string })
    expect(ids(second)).toEqual(['m_2', 'm_3'])
    const cursor2 = second.messages[0]!
    const third = await page(all, { limit: 2, beforeSentAt: cursor2.sent_at as string, beforeServerId: cursor2.server_id as string })
    expect(ids(third)).toEqual(['m_1'])
    expect(third).toMatchObject({ more: false, end: 'start' })
  })

  it('splits messages written in the same instant by id, losing none and repeating none', async () => {
    const t = daysAgo(3)
    const all = ['m_1', 'm_2', 'm_3', 'm_4'].map((id) => msg(id, 0, { created_at: t }))
    const first = await page(all, { limit: 2 })
    expect(ids(first)).toEqual(['m_3', 'm_4'])
    const second = await page(all, { limit: 2, beforeSentAt: t, beforeServerId: 'm_3' })
    expect(ids(second)).toEqual(['m_1', 'm_2'])
  })

  it('without the id of a message, "older than this time" is strict', async () => {
    const t = daysAgo(3)
    const out = await page([msg('m_1', 4), msg('m_2', 0, { created_at: t })], { beforeSentAt: t })
    expect(ids(out)).toEqual(['m_1'])
  })

  it('never returns what the app must not see: other channels, internal notes, failed or unsent messages, trash, another person, a file kind Halo does not offer', async () => {
    const out = await page([
      msg('m_ok', 5),
      msg('m_whatsapp', 5, { channel_type: 'whatsapp' }),
      msg('m_note', 5, { is_internal: true }),
      msg('m_failed', 5, { status: 'failed' }),
      msg('m_pending', 5, { status: 'pending' }),
      msg('m_trash', 5, { pending_delete: true }),
      msg('m_other', 5, { conversation_id: 'conv-2' }),
      msg('m_noid', 5, { message_id: null }),
      msg('m_location', 5, { content_type: 'location' }),
    ])
    expect(ids(out)).toEqual(['m_ok'])
  })

  it('never reaches into another workspace that has the same wallet id', async () => {
    const out = await page([msg('m_here', 5), msg('m_there', 5, { conversation_id: 'conv-3' })])
    expect(ids(out)).toEqual(['m_here'])
  })

  it('answers an empty page for a person Halo does not know', async () => {
    const out = await answerHistoryPage(db(tables([msg('m_a', 5)])), { account_id: 'acct-1' }, { kind: 'page', walletId: 'W-unknown', beforeSentAt: daysAgo(0), beforeServerId: null, limit: 30, notBefore: null }, NOW)
    expect(out).toEqual({ messages: [], more: false, end: 'start' })
  })

  describe('how far back', () => {
    const rows = [msg('m_old', 100), msg('m_edge_in', 89), msg('m_new', 10)]

    it('stops at the workspace\'s limit (90 days by default) and says there is older', async () => {
      const out = await page(rows)
      expect(ids(out)).toEqual(['m_edge_in', 'm_new'])
      expect(out).toMatchObject({ more: false, end: 'window' })
    })

    it('says "start" when nothing lies beyond the limit', async () => {
      expect(await page([msg('m_edge_in', 89), msg('m_new', 10)])).toMatchObject({ more: false, end: 'start' })
    })

    it('follows a different limit, and defaults to 90 when the setting is not there yet', async () => {
      expect(ids(await page(rows, {}, { account_id: 'acct-1', history_days: 30 }))).toEqual(['m_new'])
      expect(ids(await page(rows, {}, { account_id: 'acct-1', history_days: 365 }))).toEqual(['m_old', 'm_edge_in', 'm_new'])
      expect(ids(await page(rows, {}, { account_id: 'acct-1', history_days: null }))).toEqual(['m_edge_in', 'm_new'])
    })

    it('answers an empty "window" page when the app\'s cursor is already beyond the limit', async () => {
      const out = await page(rows, { beforeSentAt: daysAgo(95) })
      expect(out).toEqual({ messages: [], more: false, end: 'window' })
    })

    it('respects the moment the app cleared its chat, and calls that the start, not the limit', async () => {
      const out = await page(rows, { notBefore: daysAgo(20) })
      expect(ids(out)).toEqual(['m_new'])
      expect(out.end).toBe('start')
    })

    it('uses the nearer of the two', async () => {
      expect(ids(await page(rows, { notBefore: daysAgo(200) }))).toEqual(['m_edge_in', 'm_new'])
    })
  })

  it('names the agent, quotes the message replied to, and describes a file without giving its address', async () => {
    const out = await page([
      msg('m_q', 6, { sender_type: 'customer', sender_id: null, content_text: 'x'.repeat(300) }),
      msg('m_r', 5, { reply_to_message_id: 'uuid-m_q', content_type: 'image', content_text: 'caption', media_url: 'private/acct-1/x.png', media_type: 'image/png', media_animated: true }),
      msg('m_gone', 4, { content_type: 'image', media_url: null, media_type: null }),
    ])
    const r = out.messages.find((m) => m.server_id === 'm_r')!
    expect(r.reply_to).toEqual({ server_id: 'm_q', kind: 'text', text: 'x'.repeat(140), from: 'you' })
    expect(r.media).toEqual({ mime_type: 'image/png', file_name: null, size_bytes: null, duration_seconds: null, animated: true })
    expect(JSON.stringify(out)).not.toContain('https://')
    expect(JSON.stringify(out)).not.toContain('private/')
    expect(out.messages.find((m) => m.server_id === 'm_gone')).toMatchObject({ kind: 'image', media: null })
  })
})

describe('a file in an older message', () => {
  const withFile = msg('m_f', 5, { content_type: 'image', media_url: 'private/acct-1/x.png', media_type: 'image/png' })
  const ask = (rows: Row[], serverId = 'm_f', walletId = 'W123', accountId = 'acct-1') =>
    answerHistoryFile(db(tables(rows)), { account_id: accountId }, { kind: 'file', walletId, serverId })

  it('gives a fresh signed address for the file of that person\'s message', async () => {
    const out = await ask([withFile])
    expect(out).toEqual({
      media: {
        download_url: `https://files.example.com/private/acct-1/x.png?ttl=${HISTORY_FILE_LINK_SECONDS}`,
        kind: 'image',
        mime_type: 'image/png',
        file_name: null,
        size_bytes: null,
        duration_seconds: null,
        animated: false,
      },
    })
  })

  it('has nothing for another person\'s message, another workspace, a text message, a trashed message, or one that does not exist', async () => {
    expect(await ask([{ ...withFile, conversation_id: 'conv-2' }])).toBeNull()
    expect(await ask([{ ...withFile, conversation_id: 'conv-3' }])).toBeNull()
    expect(await ask([{ ...withFile, content_type: 'text', media_url: null }])).toBeNull()
    expect(await ask([{ ...withFile, pending_delete: true }])).toBeNull()
    expect(await ask([{ ...withFile, is_internal: true }])).toBeNull()
    expect(await ask([withFile], 'm_nope')).toBeNull()
    expect(await ask([withFile], 'm_f', 'W-unknown')).toBeNull()
  })

  it('has nothing when the file is not inside the workspace\'s own storage folder', async () => {
    expect(await ask([{ ...withFile, media_url: 'private/acct-2/x.png' }])).toBeNull()
  })
})
