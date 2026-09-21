import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  closeConversation: vi.fn(),
  after: vi.fn(),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: mocks.after }
})
vi.mock('@/lib/auth/account', () => ({
  requireCapability: mocks.requireCapability,
  toErrorResponse: (e: { message?: string; status?: number }) => Response.json({ error: e.message }, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/conversations/close', () => ({ closeConversation: mocks.closeConversation }))

import { POST } from './route'

const userClient = { user: true }

function post(body: unknown) {
  return POST(new Request('http://localhost/api/conversations/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

beforeEach(() => {
  mocks.requireCapability.mockResolvedValue({ supabase: userClient, accountId: 'acct-1', userId: 'u1' })
  mocks.closeConversation.mockResolvedValue({ closed: true, wasClosed: false, dispatched: true })
})

describe('POST /api/conversations/close', () => {
  it('needs conversations.manage', async () => {
    mocks.requireCapability.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const res = await post({ conversation_ids: ['a'], note: 'x' })
    expect(res.status).toBe(403)
    expect(mocks.requireCapability).toHaveBeenCalledWith('conversations.manage')
    expect(mocks.closeConversation).not.toHaveBeenCalled()
  })

  it('needs a closure note and 1 to 200 ids', async () => {
    expect((await post({ conversation_ids: ['a'], note: '   ' })).status).toBe(400)
    expect((await post({ conversation_ids: [], note: 'x' })).status).toBe(400)
    expect((await post({ conversation_ids: Array.from({ length: 201 }, (_, i) => `c${i}`), note: 'x' })).status).toBe(400)
    expect((await post({ note: 'x' })).status).toBe(400)
    expect(mocks.closeConversation).not.toHaveBeenCalled()
  })

  it('closes each conversation as the signed-in user and hands the trigger dispatch to after()', async () => {
    const res = await post({ conversation_ids: ['a', 'b', 'a'], note: '  Resolved  ' })
    expect(await res.json()).toEqual({ succeeded: ['a', 'b'], failed: [] })
    expect(mocks.closeConversation).toHaveBeenCalledTimes(2)
    const first = mocks.closeConversation.mock.calls[0][0]
    expect(first).toMatchObject({
      rpcClient: userClient,
      accountId: 'acct-1',
      conversationId: 'a',
      note: 'Resolved',
      closedBy: { type: 'agent', userId: 'u1' },
    })
    // The dispatch is deferred to after(): the agent's screen never waits for an AI step.
    first.defer(async () => {})
    expect(mocks.after).toHaveBeenCalledTimes(1)
  })

  it('one failure does not stop the others, and is reported', async () => {
    mocks.closeConversation.mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce({ closed: true })
    const res = await post({ conversation_ids: ['a', 'b'], note: 'x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ succeeded: ['b'], failed: [{ id: 'a', error: 'permission denied' }] })
  })

  it('every one failing is a 400 with the reasons', async () => {
    mocks.closeConversation.mockRejectedValue(new Error('nope'))
    const res = await post({ conversation_ids: ['a'], note: 'x' })
    expect(res.status).toBe(400)
    expect((await res.json()).failed).toEqual([{ id: 'a', error: 'nope' }])
  })
})
