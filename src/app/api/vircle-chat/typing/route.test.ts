import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  findVircleTarget: vi.fn(),
  openGatewayConnection: vi.fn(),
  sendTyping: vi.fn(),
  afterCallbacks: [] as (() => unknown)[],
  supabase: { tag: 'user-client' },
  admin: { tag: 'admin-client' },
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => h.afterCallbacks.push(fn),
}))
vi.mock('@/lib/auth/account', () => ({
  requireCapability: (...a: unknown[]) => h.requireCapability(...a),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : 'x' }, { status: (err as { status?: number }).status ?? 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.admin }))
vi.mock('@/lib/vircle-chat/connection', () => ({
  findVircleTarget: (...a: unknown[]) => h.findVircleTarget(...a),
  openGatewayConnection: (...a: unknown[]) => h.openGatewayConnection(...a),
}))
vi.mock('@/lib/vircle-chat/gateway', () => ({ sendTyping: (...a: unknown[]) => h.sendTyping(...a) }))

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { POST } from './route'

const call = (body: unknown) =>
  POST(new Request('https://halo.example.com/api/vircle-chat/typing', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  __resetRateLimitForTests()
  h.afterCallbacks = []
  h.requireCapability.mockReset()
  h.requireCapability.mockResolvedValue({ supabase: h.supabase, accountId: 'acct-1', userId: 'user-1' })
  h.findVircleTarget.mockReset()
  h.findVircleTarget.mockResolvedValue({ conversationId: 'cv-1', walletId: 'W123' })
  h.openGatewayConnection.mockReset()
  h.openGatewayConnection.mockResolvedValue({ baseUrl: 'https://gw.example.com', apiToken: 'tok' })
  h.sendTyping.mockReset()
  h.sendTyping.mockResolvedValue(1)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/vircle-chat/typing', () => {
  it('needs the capability to send messages', async () => {
    await call({ conversationId: 'cv-1' })
    expect(h.requireCapability).toHaveBeenCalledWith('messages.send')
    h.requireCapability.mockRejectedValueOnce(Object.assign(new Error('no'), { status: 403 }))
    expect((await call({ conversationId: 'cv-1' })).status).toBe(403)
  })

  it('answers at once and calls the gateway after the answer, with the user\'s wallet id', async () => {
    const res = await call({ conversationId: 'cv-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.findVircleTarget).toHaveBeenCalledWith(h.supabase, 'acct-1', 'cv-1')
    expect(h.sendTyping).not.toHaveBeenCalled()
    expect(h.afterCallbacks).toHaveLength(1)
    await h.afterCallbacks[0]()
    expect(h.openGatewayConnection).toHaveBeenCalledWith(h.admin, 'acct-1')
    expect(h.sendTyping).toHaveBeenCalledWith({ baseUrl: 'https://gw.example.com', apiToken: 'tok' }, 'W123')
  })

  it('passes on one signal per 3 seconds per agent and conversation, and drops the rest quietly', async () => {
    const first = await call({ conversationId: 'cv-1' })
    const second = await call({ conversationId: 'cv-1' })
    expect(await first.json()).toEqual({ ok: true })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, throttled: true })
    expect(h.afterCallbacks).toHaveLength(1)

    // another conversation, and another agent, each have their own budget
    h.findVircleTarget.mockResolvedValue({ conversationId: 'cv-2', walletId: 'W9' })
    await call({ conversationId: 'cv-2' })
    h.requireCapability.mockResolvedValue({ supabase: h.supabase, accountId: 'acct-1', userId: 'user-2' })
    await call({ conversationId: 'cv-1' })
    expect(h.afterCallbacks).toHaveLength(3)
  })

  it('lets the throttle window pass', async () => {
    vi.useFakeTimers()
    try {
      await call({ conversationId: 'cv-1' })
      vi.advanceTimersByTime(3001)
      const again = await call({ conversationId: 'cv-1' })
      expect(await again.json()).toEqual({ ok: true })
      expect(h.afterCallbacks).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call the gateway when the connection is missing or paused, and swallows a gateway failure', async () => {
    h.openGatewayConnection.mockResolvedValueOnce(null)
    await call({ conversationId: 'cv-1' })
    await h.afterCallbacks[0]()
    expect(h.sendTyping).not.toHaveBeenCalled()

    __resetRateLimitForTests()
    h.sendTyping.mockRejectedValueOnce(new Error('gateway down'))
    await call({ conversationId: 'cv-1' })
    await expect(h.afterCallbacks[1]()).resolves.toBeUndefined()
  })

  it('answers 404 for a conversation that is not a Vircle Chat one in the caller\'s workspace, and spends no throttle budget', async () => {
    h.findVircleTarget.mockResolvedValueOnce(null)
    expect((await call({ conversationId: 'cv-x' })).status).toBe(404)
    expect(h.afterCallbacks).toHaveLength(0)
    const ok = await call({ conversationId: 'cv-1' })
    expect(await ok.json()).toEqual({ ok: true })
  })

  it('answers 400 without a conversation id', async () => {
    expect((await call({})).status).toBe(400)
    expect((await call('nope')).status).toBe(400)
    expect(h.findVircleTarget).not.toHaveBeenCalled()
  })
})
