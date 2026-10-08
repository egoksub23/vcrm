import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeDb } from './fake-db'

// performCommentAction pulls in the provider clients; the bulk code only needs its answer.
vi.mock('./actions', () => ({ performCommentAction: vi.fn() }))

import { BULK_MAX_IDS, runBulkOp } from './bulk'

const ctx = { accountId: 'acct', userId: 'user' }

function seed() {
  const f = makeFakeDb({
    comments: [
      { id: 'open1', account_id: 'acct', direction: 'inbound', status: 'visible', handled_status: 'open' },
      { id: 'open2', account_id: 'acct', direction: 'inbound', status: 'visible', handled_status: 'open' },
      { id: 'replied', account_id: 'acct', direction: 'inbound', status: 'visible', handled_status: 'replied' },
      { id: 'resolved', account_id: 'acct', direction: 'inbound', status: 'visible', handled_status: 'resolved' },
      { id: 'spam', account_id: 'acct', direction: 'inbound', status: 'visible', handled_status: 'spam' },
      { id: 'ours', account_id: 'acct', direction: 'outbound', status: 'visible', handled_status: 'resolved' },
      { id: 'gone', account_id: 'acct', direction: 'inbound', status: 'deleted', handled_status: 'open' },
      { id: 'other', account_id: 'someone-else', direction: 'inbound', status: 'visible', handled_status: 'open' },
    ],
  })
  return f
}
const state = (f: ReturnType<typeof seed>, id: string) => f.tables.comments.find((r) => r.id === id)?.handled_status

describe('runBulkOp: handled status', () => {
  it('marks only open comments handled, one answer per comment, in the order asked', async () => {
    const f = seed()
    const out = await runBulkOp({ userDb: f.db, adminDb: f.db, ctx, op: 'resolve', ids: ['open1', 'replied', 'open2', 'resolved'] })
    expect(out).toEqual([
      { id: 'open1', ok: true },
      { id: 'replied', ok: true, skipped: true },
      { id: 'open2', ok: true },
      { id: 'resolved', ok: true, skipped: true },
    ])
    expect(state(f, 'open1')).toBe('resolved')
    expect(state(f, 'open2')).toBe('resolved')
    // handled-by-reply stays replied: marking handled does not rewrite how it was handled
    expect(state(f, 'replied')).toBe('replied')
  })

  it('moves open, replied and resolved comments to Spam, and reopens resolved and spam ones', async () => {
    const f = seed()
    await runBulkOp({ userDb: f.db, adminDb: f.db, ctx, op: 'spam', ids: ['open1', 'replied', 'resolved', 'spam'] })
    expect(['open1', 'replied', 'resolved', 'spam'].map((i) => state(f, i))).toEqual(['spam', 'spam', 'spam', 'spam'])
    const out = await runBulkOp({ userDb: f.db, adminDb: f.db, ctx, op: 'reopen', ids: ['open1', 'spam'] })
    expect(out.map((r) => [r.id, r.ok, !!r.skipped])).toEqual([
      ['open1', true, false],
      ['spam', true, false],
    ])
    expect(state(f, 'open1')).toBe('open')
  })

  it('reports comments that are ours, deleted, missing or in another workspace instead of dropping them', async () => {
    const f = seed()
    const out = await runBulkOp({ userDb: f.db, adminDb: f.db, ctx, op: 'spam', ids: ['ours', 'gone', 'nope', 'other', 'open1'] })
    const by = Object.fromEntries(out.map((r) => [r.id, r]))
    expect(by.ours).toMatchObject({ ok: false, reason: 'ownComment' })
    expect(by.gone).toMatchObject({ ok: false, reason: 'deleted' })
    expect(by.nope).toMatchObject({ ok: false })
    expect(by.other).toMatchObject({ ok: false })
    expect(by.open1).toEqual({ id: 'open1', ok: true })
    expect(state(f, 'other')).toBe('open')
    expect(state(f, 'ours')).toBe('resolved')
  })

  it('says so when the update was not allowed for some comments (row level security returned fewer rows)', async () => {
    const f = seed()
    // the caller may change open1 but not open2: the database filters open2 out of the write
    const userDb = {
      from: (t: string) => {
        const b = f.db.from(t) as unknown as Record<string, (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown>>
        if (t === 'comments') {
          const update = b.update.bind(b)
          b.update = (p: unknown) => {
            const u = update(p)
            const inFn = u.in.bind(u)
            u.in = (col: unknown, vals: unknown) => inFn(col, (vals as string[]).filter((v) => v !== 'open2'))
            return u
          }
        }
        return b
      },
    } as unknown as SupabaseClient
    const out = await runBulkOp({ userDb, adminDb: f.db, ctx, op: 'resolve', ids: ['open1', 'open2'] })
    expect(out[0]).toEqual({ id: 'open1', ok: true })
    expect(out[1]).toMatchObject({ id: 'open2', ok: false })
    expect(out[1].error).toMatch(/permission/i)
  })

  it('answers a repeated id once', async () => {
    const f = seed()
    const out = await runBulkOp({ userDb: f.db, adminDb: f.db, ctx, op: 'resolve', ids: ['open1', 'open1'] })
    expect(out).toEqual([{ id: 'open1', ok: true }])
  })

  it('exposes a per-request cap that the route enforces', () => {
    expect(BULK_MAX_IDS).toBe(50)
  })
})

describe('runBulkOp: hide and unhide', () => {
  it('runs the existing action once per comment and keeps going after a failure', async () => {
    const f = seed()
    const perform = vi.fn(async (...args: unknown[]) =>
      args[2] === 'open2'
        ? ({ ok: false, status: 502, error: 'Instagram said no', reason: undefined } as const)
        : ({ ok: true, comment: { id: args[2] } } as never),
    )
    const out = await runBulkOp({ userDb: f.db, adminDb: f.db, ctx, op: 'hide', ids: ['open1', 'open2', 'replied'], perform: perform as never })
    expect(perform.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['open1', 'hide'],
      ['open2', 'hide'],
      ['replied', 'hide'],
    ])
    expect(out).toEqual([
      { id: 'open1', ok: true },
      { id: 'open2', ok: false, error: 'Instagram said no', reason: undefined },
      { id: 'replied', ok: true },
    ])
  })

  it('carries the reason when the action is not available, and turns a thrown error into that comment\'s failure', async () => {
    const f = seed()
    const perform = vi.fn(async (...args: unknown[]) => {
      if (args[2] === 'open2') throw new Error('network down')
      return { ok: false, status: 409, error: 'That action is not available for this comment.', reason: 'igHidden' } as const
    })
    const out = await runBulkOp({ userDb: f.db, adminDb: f.db, ctx, op: 'unhide', ids: ['open1', 'open2', 'ours'], perform: perform as never })
    expect(out[0]).toMatchObject({ id: 'open1', ok: false, reason: 'igHidden' })
    expect(out[1]).toMatchObject({ id: 'open2', ok: false })
    expect(out[2]).toMatchObject({ id: 'ours', ok: false, reason: 'ownComment' })
    // an own comment never reaches the provider
    expect(perform.mock.calls.map((c) => c[2])).toEqual(['open1', 'open2'])
  })
})
