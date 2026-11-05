import { beforeEach, describe, it, expect, vi } from 'vitest'

const notifyVircleRead = vi.hoisted(() => vi.fn())
vi.mock('@/lib/vircle-chat/client', () => ({ notifyVircleRead }))

import { bulkAssign, bulkClose, bulkMarkRead, bulkMarkUnread } from './bulk-actions'

const conv = (id: string, status: string, unread: number) =>
  ({ id, status, unread_count: unread }) as never

function mockFetch(result: object) {
  return vi.fn(() =>
    Promise.resolve({ json: () => Promise.resolve(result) } as Response),
  )
}

describe('bulkAssign', () => {
  it('calls bulk route and returns result', async () => {
    global.fetch = mockFetch({ succeeded: ['a', 'b'], failed: 0 })
    expect(await bulkAssign(['a', 'b'], 'u1')).toEqual({ succeeded: ['a', 'b'], failed: 0 })
  })

  it('does nothing for an empty selection', async () => {
    global.fetch = mockFetch({})
    expect(await bulkAssign([], 'u1')).toEqual({ succeeded: [], failed: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('bulkMarkRead / bulkMarkUnread', () => {
  it('calls bulk route and returns result', async () => {
    global.fetch = mockFetch({ succeeded: ['a', 'c'], failed: 0 })
    const convs = [conv('a', 'open', 3), conv('b', 'open', 0), conv('c', 'open', 1)]
    expect((await bulkMarkRead(convs)).succeeded).toEqual(['a', 'c'])

    global.fetch = mockFetch({ succeeded: ['b'], failed: 0 })
    expect((await bulkMarkUnread(convs)).succeeded).toEqual(['b'])
  })

  it('makes no write when nothing needs changing', async () => {
    global.fetch = mockFetch({})
    // All already unread=0 means no-op for markRead
    await bulkMarkRead([conv('a', 'open', 0)])
    expect(global.fetch).not.toHaveBeenCalled()
    // All already unread>0 means no-op for markUnread
    await bulkMarkUnread([conv('a', 'open', 2)])
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('bulkClose', () => {
  const closer = (failIds: string[] = []) => {
    const calls: { ids: string[]; note: string }[] = []
    const close = async (ids: string[], note: string) => {
      calls.push({ ids, note })
      return {
        succeeded: ids.filter((i) => !failIds.includes(i)),
        failed: ids.filter((i) => failIds.includes(i)).map((id) => ({ id, error: 'nope' })),
      }
    }
    return { close, calls }
  }

  it('closes only open/pending conversations, in one server call with the shared note', async () => {
    const { close, calls } = closer()
    const res = await bulkClose(
      [conv('a', 'open', 0), conv('b', 'closed', 0), conv('c', 'pending', 0)],
      'Outage resolved',
      close,
    )
    expect(res).toEqual({ succeeded: ['a', 'c'], failed: 0 })
    expect(calls).toEqual([{ ids: ['a', 'c'], note: 'Outage resolved' }])
  })

  it('keeps going past a failure and reports it', async () => {
    const { close } = closer(['b'])
    const res = await bulkClose([conv('a', 'open', 0), conv('b', 'open', 0), conv('c', 'open', 0)], 'x', close)
    expect(res).toEqual({ succeeded: ['a', 'c'], failed: 1 })
  })

  it('reports every conversation as failed when the request itself fails', async () => {
    const res = await bulkClose([conv('a', 'open', 0), conv('b', 'open', 0)], 'x', async () => {
      throw new Error('network')
    })
    expect(res).toEqual({ succeeded: [], failed: 2 })
  })

  it('does nothing when everything is already closed', async () => {
    const { close, calls } = closer()
    expect(await bulkClose([conv('a', 'closed', 0)], 'x', close)).toEqual({ succeeded: [], failed: 0 })
    expect(calls).toHaveLength(0)
  })
})
