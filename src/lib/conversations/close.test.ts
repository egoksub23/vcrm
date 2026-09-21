import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mocks = vi.hoisted(() => ({ run: vi.fn(async () => {}) }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: mocks.run }))

import { CHAIN_VAR, MAX_CLOSE_CHAIN, chainOf, closeConversation, resetCloseDispatchMemory } from './close'

function fakeClient(opts: { status?: string; contact?: string | null; rpcError?: boolean; missing?: boolean } = {}) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = []
  const client = {
    from(table: string) {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => {
          if (table === 'profiles') return { data: { full_name: 'Alex Agent' }, error: null }
          if (opts.missing) return { data: null, error: null }
          return { data: { id: 'conv-1', status: opts.status ?? 'open', contact_id: opts.contact === undefined ? 'c1' : opts.contact }, error: null }
        },
      }
      return api
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args })
      return { error: opts.rpcError ? { message: 'permission denied' } : null }
    },
  } as unknown as SupabaseClient
  return { client, rpcs }
}

const base = (client: SupabaseClient) => ({
  rpcClient: client,
  admin: client,
  accountId: 'acct-1',
  conversationId: 'conv-1',
  note: 'Sorted out',
  closedBy: { type: 'agent' as const, userId: 'u1' },
})

beforeEach(() => resetCloseDispatchMemory())

describe('closeConversation: the one place conversation_closed is dispatched', () => {
  it('closes through the note RPC and fires the trigger once, with the note and who closed it', async () => {
    const { client, rpcs } = fakeClient()
    const r = await closeConversation(base(client))
    expect(r).toEqual({ closed: true, wasClosed: false, dispatched: true })
    expect(rpcs).toEqual([{ name: 'close_conversation_with_note', args: { p_conversation_id: 'conv-1', p_note: 'Sorted out' } }])
    expect(mocks.run).toHaveBeenCalledTimes(1)
    expect(mocks.run).toHaveBeenCalledWith({
      accountId: 'acct-1',
      triggerType: 'conversation_closed',
      contactId: 'c1',
      context: {
        conversation_id: 'conv-1',
        closure_note: 'Sorted out',
        vars: { closure_note: 'Sorted out', closed_by: 'Alex Agent', closed_by_type: 'agent', [CHAIN_VAR]: [] },
      },
    })
  })

  it('an automation closing it is named, and joins the chain', async () => {
    const { client } = fakeClient()
    await closeConversation({
      ...base(client),
      closedBy: { type: 'automation', automationId: 'auto-1', automationName: 'Auto closer' },
      chain: ['auto-0'],
    })
    const ctx = (mocks.run.mock.calls[0] as unknown as [{ context: { vars: Record<string, unknown> } }])[0].context
    expect(ctx.vars).toMatchObject({ closed_by: 'Auto closer', closed_by_type: 'automation', [CHAIN_VAR]: ['auto-0', 'auto-1'] })
  })

  it('closing an already-closed conversation records the note but does not fire again', async () => {
    const { client, rpcs } = fakeClient({ status: 'closed' })
    const r = await closeConversation(base(client))
    expect(r).toEqual({ closed: true, wasClosed: true, dispatched: false })
    expect(rpcs).toHaveLength(1)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('two closes of the same open conversation at once fire once', async () => {
    const { client } = fakeClient()
    const [a, b] = await Promise.all([closeConversation(base(client)), closeConversation(base(client))])
    expect([a.dispatched, b.dispatched].filter(Boolean)).toHaveLength(1)
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('a chain that is already too long does not dispatch (an automation loop across conversations cannot grow)', async () => {
    const { client } = fakeClient()
    const chain = Array.from({ length: MAX_CLOSE_CHAIN }, (_, i) => `a${i}`)
    const r = await closeConversation({ ...base(client), closedBy: { type: 'automation', automationId: 'new-one', automationName: 'x' }, chain })
    expect(r.dispatched).toBe(false)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('can defer the dispatch (the route runs it after the response)', async () => {
    const { client } = fakeClient()
    const jobs: (() => Promise<void>)[] = []
    const r = await closeConversation({ ...base(client), defer: (j) => jobs.push(j) })
    expect(r.dispatched).toBe(true)
    expect(mocks.run).not.toHaveBeenCalled()
    await jobs[0]()
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('uses the conversation\'s contact when the caller did not pass one', async () => {
    const { client } = fakeClient({ contact: 'c9' })
    await closeConversation(base(client))
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c9' }))
  })

  it('a failed RPC (no permission, no note) throws and dispatches nothing', async () => {
    const { client } = fakeClient({ rpcError: true })
    await expect(closeConversation(base(client))).rejects.toMatchObject({ message: 'permission denied' })
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('a conversation from another account is not found', async () => {
    const { client, rpcs } = fakeClient({ missing: true })
    await expect(closeConversation(base(client))).rejects.toThrow('Conversation not found')
    expect(rpcs).toHaveLength(0)
  })

  it('a failing dispatch never fails the close', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.run.mockRejectedValueOnce(new Error('automation blew up'))
    const { client } = fakeClient()
    await expect(closeConversation(base(client))).resolves.toMatchObject({ closed: true })
    err.mockRestore()
  })
})

describe('chainOf', () => {
  it('reads the automation ids from the run vars, ignoring anything else', () => {
    expect(chainOf({ [CHAIN_VAR]: ['a', 'b', 3, null] })).toEqual(['a', 'b'])
    expect(chainOf({})).toEqual([])
    expect(chainOf(undefined)).toEqual([])
  })
})

describe('outbound AI messages cannot re-trigger automations', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('neither the shared send path nor the AI step applier dispatches automations', () => {
    for (const file of ['src/lib/whatsapp/send-message.ts', 'src/lib/automations/ai/apply.ts', 'src/lib/automations/ai/run.ts', 'src/lib/automations/meta-send.ts']) {
      expect(read(file)).not.toMatch(/runAutomationsForTrigger/)
    }
  })

  it('new_message_received is only dispatched from the inbound webhooks and widget routes', () => {
    // The senders above are the only outbound path an AI reply uses; inbound routes are the dispatchers.
    for (const file of ['src/app/api/whatsapp/webhook/route.ts', 'src/app/api/widget/message/route.ts']) {
      expect(read(file)).toMatch(/runAutomationsForTrigger/)
    }
  })
})
