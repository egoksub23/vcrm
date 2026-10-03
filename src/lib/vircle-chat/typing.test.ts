import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  contact: null as null | { id: string },
  conversations: [] as { id: string }[],
  conversationError: false,
  findByWallet: vi.fn(),
  httpSend: vi.fn(),
  removeChannel: vi.fn(),
  channelNames: [] as string[],
  filters: [] as [string, unknown][],
}))

vi.mock('@/lib/widget/identity-resolve', () => ({
  createSupabaseIdentityStore: () => ({ findByWallet: (...a: unknown[]) => h.findByWallet(...a) }),
}))

import type { TypingEvent } from './contract'
import { createTypingState, TYPING_DISPLAY_MS, TYPING_EVENT, typingChannelName } from './typing-channel'
import { broadcastUserTyping } from './typing'

const admin = {
  from: () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (h.filters.push([c, v]), b),
      order: () => b,
      limit: async () => ({ data: h.conversations, error: h.conversationError ? { message: 'boom' } : null }),
    }
    return b
  },
  channel: (name: string) => {
    h.channelNames.push(name)
    return { httpSend: (...a: unknown[]) => h.httpSend(...a) }
  },
  removeChannel: (...a: unknown[]) => h.removeChannel(...a),
}

const ev: TypingEvent = { kind: 'user.typing', eventId: 'evt_t', workspaceKey: 'vcw_x', walletId: 'W123', conversationId: 'c_1' }

beforeEach(() => {
  h.contact = { id: 'ct-1' }
  h.conversations = [{ id: 'cv-1' }]
  h.conversationError = false
  h.channelNames = []
  h.filters = []
  h.findByWallet.mockReset()
  h.findByWallet.mockImplementation(async () => h.contact)
  h.httpSend.mockReset()
  h.httpSend.mockResolvedValue({ success: true })
  h.removeChannel.mockReset()
  h.removeChannel.mockResolvedValue('ok')
})

describe('broadcastUserTyping', () => {
  it('finds the contact by wallet id and broadcasts on vircle-typing:<haloConversationId> with the event and a timestamp', async () => {
    const r = await broadcastUserTyping(admin as never, 'acct-1', ev)
    expect(r).toEqual({ status: 'broadcast', conversationId: 'cv-1' })
    expect(h.findByWallet).toHaveBeenCalledWith('acct-1', 'W123')
    expect(h.filters).toEqual([['account_id', 'acct-1'], ['contact_id', 'ct-1']])
    expect(h.channelNames).toEqual(['vircle-typing:cv-1'])
    expect(h.httpSend).toHaveBeenCalledTimes(1)
    expect(h.httpSend.mock.calls[0][0]).toBe('typing')
    expect(Date.parse(h.httpSend.mock.calls[0][1].at)).not.toBeNaN()
  })

  it('removes the channel it opened, even when the broadcast fails (and rethrows for the caller to log)', async () => {
    h.httpSend.mockRejectedValueOnce(new Error('realtime down'))
    await expect(broadcastUserTyping(admin as never, 'acct-1', ev)).rejects.toThrow('realtime down')
    expect(h.removeChannel).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a user Halo has not seen, or one with no conversation yet', async () => {
    h.contact = null
    expect(await broadcastUserTyping(admin as never, 'acct-1', ev)).toEqual({ status: 'unknown_user' })
    h.contact = { id: 'ct-1' }
    h.conversations = []
    expect(await broadcastUserTyping(admin as never, 'acct-1', ev)).toEqual({ status: 'unknown_user' })
    expect(h.httpSend).not.toHaveBeenCalled()
  })

  it('throws when the conversation lookup fails', async () => {
    h.conversationError = true
    await expect(broadcastUserTyping(admin as never, 'acct-1', ev)).rejects.toThrow('boom')
  })
})

describe('typing channel constants', () => {
  it('names the channel and event the Inbox listens on', () => {
    expect(typingChannelName('cv-9')).toBe('vircle-typing:cv-9')
    expect(TYPING_EVENT).toBe('typing')
    expect(TYPING_DISPLAY_MS).toBe(6000)
  })
})

describe('createTypingState', () => {
  beforeEach(() => vi.useFakeTimers())

  it('shows "typing" on a signal and switches itself off 6 seconds after the LAST one', () => {
    const seen: boolean[] = []
    const s = createTypingState((t) => seen.push(t))
    s.signal()
    vi.advanceTimersByTime(4000)
    s.signal()
    vi.advanceTimersByTime(4000) // 8s after the first, 4s after the second
    expect(seen).toEqual([true, true])
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual([true, true, false])
    vi.useRealTimers()
  })

  it('clear() hides it at once and cancels the countdown; dispose() cancels without a change', () => {
    const seen: boolean[] = []
    const s = createTypingState((t) => seen.push(t))
    s.signal()
    s.clear()
    vi.advanceTimersByTime(10_000)
    expect(seen).toEqual([true, false])

    const seen2: boolean[] = []
    const s2 = createTypingState((t) => seen2.push(t))
    s2.signal()
    s2.dispose()
    vi.advanceTimersByTime(10_000)
    expect(seen2).toEqual([true])
    vi.useRealTimers()
  })
})
