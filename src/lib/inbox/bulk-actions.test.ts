import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bulkAssign, bulkClose, bulkMarkRead, bulkMarkUnread } from './bulk-actions'

interface UpdateCall {
  payload: Record<string, unknown>
  ids: string[]
}

function fakeDb(opts: { updateError?: boolean; failRpcFor?: string[] } = {}) {
  const updates: UpdateCall[] = []
  const rpcs: { fn: string; args: Record<string, unknown> }[] = []
  const db = {
    from() {
      let payload: Record<string, unknown> = {}
      const b = {
        update(p: Record<string, unknown>) {
          payload = p
          return b
        },
        in(_col: string, ids: string[]) {
          updates.push({ payload, ids })
          return Promise.resolve({ error: opts.updateError ? { message: 'x' } : null })
        },
      }
      return b
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args })
      const fail = opts.failRpcFor?.includes(args.p_conversation_id as string)
      return Promise.resolve({ error: fail ? { message: 'nope' } : null })
    },
  } as unknown as SupabaseClient
  return { db, updates, rpcs }
}

const conv = (id: string, status: string, unread: number) =>
  ({ id, status, unread_count: unread }) as never

describe('bulkAssign', () => {
  it('assigns every id in one update, and can unassign with null', async () => {
    const { db, updates } = fakeDb()
    expect(await bulkAssign(db, ['a', 'b'], 'u1')).toEqual({ succeeded: ['a', 'b'], failed: 0 })
    expect(updates[0]).toEqual({ payload: { assigned_agent_id: 'u1' }, ids: ['a', 'b'] })
    await bulkAssign(db, ['a'], null)
    expect(updates[1].payload).toEqual({ assigned_agent_id: null })
  })

  it('reports everything failed when the update errors, and does nothing for an empty selection', async () => {
    expect(await bulkAssign(fakeDb({ updateError: true }).db, ['a', 'b'], 'u1')).toEqual({
      succeeded: [],
      failed: 2,
    })
    const { db, updates } = fakeDb()
    expect(await bulkAssign(db, [], 'u1')).toEqual({ succeeded: [], failed: 0 })
    expect(updates).toHaveLength(0)
  })
})

describe('bulkMarkRead / bulkMarkUnread', () => {
  it('only touches conversations that actually change', async () => {
    const convs = [conv('a', 'open', 3), conv('b', 'open', 0), conv('c', 'open', 1)]
    const read = fakeDb()
    expect((await bulkMarkRead(read.db, convs)).succeeded).toEqual(['a', 'c'])
    expect(read.updates[0].payload).toEqual({ unread_count: 0 })

    const unread = fakeDb()
    expect((await bulkMarkUnread(unread.db, convs)).succeeded).toEqual(['b'])
    expect(unread.updates[0].payload).toEqual({ unread_count: 1 })
  })

  it('makes no write when nothing needs changing', async () => {
    const { db, updates } = fakeDb()
    await bulkMarkRead(db, [conv('a', 'open', 0)])
    await bulkMarkUnread(db, [conv('a', 'open', 2)])
    expect(updates).toHaveLength(0)
  })
})

describe('bulkClose', () => {
  it('closes only open/pending conversations, each through the note RPC', async () => {
    const { db, rpcs } = fakeDb()
    const res = await bulkClose(
      db,
      [conv('a', 'open', 0), conv('b', 'closed', 0), conv('c', 'pending', 0)],
      'Outage resolved',
    )
    expect(res).toEqual({ succeeded: ['a', 'c'], failed: 0 })
    expect(rpcs).toEqual([
      { fn: 'close_conversation_with_note', args: { p_conversation_id: 'a', p_note: 'Outage resolved' } },
      { fn: 'close_conversation_with_note', args: { p_conversation_id: 'c', p_note: 'Outage resolved' } },
    ])
  })

  it('keeps going past a failure and reports it', async () => {
    const { db } = fakeDb({ failRpcFor: ['b'] })
    const res = await bulkClose(db, [conv('a', 'open', 0), conv('b', 'open', 0), conv('c', 'open', 0)], 'x')
    expect(res).toEqual({ succeeded: ['a', 'c'], failed: 1 })
  })
})
