import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  conversation: null as null | { id: string; last_channel_type: string; contact: { wallet_id: string | null } | null },
  conversationError: false,
  pending: [] as { id: string; message_id: string | null }[],
  pendingError: false,
  updateError: false,
  config: null as null | { enabled: boolean; gateway_base_url: string },
  flagOn: true,
  send: vi.fn(),
  queries: [] as { table: string; filters: [string, unknown][]; limit?: number }[],
  updates: [] as { patch: Record<string, unknown>; ids: string[]; guard: unknown[] }[],
}))

vi.mock('./config', () => ({
  findConfigForAccount: async () => h.config,
  openConfig: () => ({ signingSecret: 's', apiToken: 'tok' }),
}))
vi.mock('./feature', () => ({ vircleChatEnabled: async () => h.flagOn }))
vi.mock('./gateway', () => ({ sendReadReceipts: (...a: unknown[]) => h.send(...a) }))

import { notifyVircleReads, RECEIPT_BATCH_MAX } from './read-receipts'

const admin = {
  from(table: string) {
    const q = { table, filters: [] as [string, unknown][], limit: undefined as number | undefined }
    let patch: Record<string, unknown> | null = null
    let ids: string[] = []
    const guard: unknown[] = []
    const b: Record<string, unknown> = {
      select: () => {
        h.queries.push(q)
        return b
      },
      eq: (c: string, v: unknown) => (q.filters.push([c, v]), b),
      is: (c: string, v: unknown) => {
        q.filters.push([`${c} is`, v])
        guard.push([c, v])
        return b
      },
      not: (c: string) => (q.filters.push([`${c} not null`, true]), b),
      order: () => b,
      limit: (n: number) => {
        q.limit = n
        return Promise.resolve({ data: h.pending, error: h.pendingError ? { message: 'select failed' } : null })
      },
      maybeSingle: async () => ({
        data: h.conversationError ? null : h.conversation,
        error: h.conversationError ? { message: 'boom' } : null,
      }),
      update: (p: Record<string, unknown>) => {
        patch = p
        return b
      },
      in: (_c: string, v: string[]) => {
        ids = v
        return b
      },
      then: (resolve: (r: unknown) => unknown) => {
        if (patch) h.updates.push({ patch, ids, guard })
        return resolve({ error: h.updateError ? { message: 'update failed' } : null })
      },
    }
    return b
  },
}

beforeEach(() => {
  h.conversation = { id: 'cv-1', last_channel_type: 'vircle_chat', contact: { wallet_id: 'W123' } }
  h.conversationError = false
  h.pending = [
    { id: 'row-1', message_id: 'm_41' },
    { id: 'row-2', message_id: 'm_42' },
  ]
  h.pendingError = false
  h.updateError = false
  h.config = { enabled: true, gateway_base_url: 'https://gw.example.com' }
  h.flagOn = true
  h.send.mockReset()
  h.send.mockResolvedValue(2)
  h.queries = []
  h.updates = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('notifyVircleReads', () => {
  it('tells the gateway which messages were read, then marks exactly those as told', async () => {
    const n = await notifyVircleReads(admin as never, 'acct-1', 'cv-1')
    expect(n).toBe(2)
    expect(h.send).toHaveBeenCalledWith({ baseUrl: 'https://gw.example.com', apiToken: 'tok' }, 'W123', ['m_41', 'm_42'])
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].ids).toEqual(['row-1', 'row-2'])
    expect(typeof h.updates[0].patch.read_receipt_sent_at).toBe('string')
    // never overwrites a message that was reported in the meantime
    expect(h.updates[0].guard).toContainEqual(['read_receipt_sent_at', null])
  })

  it('looks only for this conversation\'s Vircle Chat customer messages that are read and not reported yet, 200 at most', async () => {
    await notifyVircleReads(admin as never, 'acct-1', 'cv-1')
    const q = h.queries.find((x) => x.table === 'messages')!
    expect(q.filters).toEqual(
      expect.arrayContaining([
        ['conversation_id', 'cv-1'],
        ['channel_type', 'vircle_chat'],
        ['sender_type', 'customer'],
        ['status', 'read'],
        ['read_receipt_sent_at is', null],
      ]),
    )
    expect(q.limit).toBe(RECEIPT_BATCH_MAX)
    expect(RECEIPT_BATCH_MAX).toBe(200)
  })

  it('is idempotent: with nothing pending it calls nothing and writes nothing', async () => {
    h.pending = []
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(0)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
  })

  it('ignores a message that has no gateway id', async () => {
    h.pending = [{ id: 'row-1', message_id: null }]
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(0)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('leaves the messages pending, and does not throw, when the gateway call fails', async () => {
    h.send.mockRejectedValueOnce(new Error('gateway down'))
    await expect(notifyVircleReads(admin as never, 'acct-1', 'cv-1')).resolves.toBe(0)
    expect(h.updates).toHaveLength(0)
  })

  it('does not throw when the lookups or the final write fail', async () => {
    h.conversationError = true
    await expect(notifyVircleReads(admin as never, 'acct-1', 'cv-1')).resolves.toBe(0)
    h.conversationError = false
    h.pendingError = true
    await expect(notifyVircleReads(admin as never, 'acct-1', 'cv-1')).resolves.toBe(0)
    h.pendingError = false
    h.updateError = true
    await expect(notifyVircleReads(admin as never, 'acct-1', 'cv-1')).resolves.toBe(0)
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a conversation that has no Vircle user, or is not found', async () => {
    h.conversation = { id: 'cv-1', last_channel_type: 'vircle_chat', contact: { wallet_id: null } }
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(0)
    h.conversation = null
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(0)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('still reports Vircle messages when the conversation has since moved on to another channel', async () => {
    h.conversation = { id: 'cv-1', last_channel_type: 'whatsapp', contact: { wallet_id: 'W123' } }
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(2)
  })

  it('does nothing when the connection is missing, paused, or switched off by the operator', async () => {
    h.config = null
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(0)
    h.config = { enabled: false, gateway_base_url: 'https://gw.example.com' }
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(0)
    h.config = { enabled: true, gateway_base_url: 'https://gw.example.com' }
    h.flagOn = false
    expect(await notifyVircleReads(admin as never, 'acct-1', 'cv-1')).toBe(0)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
  })
})
