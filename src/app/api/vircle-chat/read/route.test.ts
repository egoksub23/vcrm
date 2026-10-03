import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  findVircleTarget: vi.fn(),
  notify: vi.fn(),
  supabase: { tag: 'user-client' },
  admin: { tag: 'admin-client' },
}))

vi.mock('@/lib/auth/account', () => ({
  requireCapability: (...a: unknown[]) => h.requireCapability(...a),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : 'x' }, { status: (err as { status?: number }).status ?? 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.admin }))
vi.mock('@/lib/vircle-chat/connection', () => ({ findVircleTarget: (...a: unknown[]) => h.findVircleTarget(...a) }))
vi.mock('@/lib/vircle-chat/read-receipts', () => ({ notifyVircleReads: (...a: unknown[]) => h.notify(...a) }))

import { POST } from './route'

const call = (body: unknown) =>
  POST(new Request('https://halo.example.com/api/vircle-chat/read', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  h.requireCapability.mockReset()
  h.requireCapability.mockResolvedValue({ supabase: h.supabase, accountId: 'acct-1', userId: 'user-1' })
  h.findVircleTarget.mockReset()
  h.findVircleTarget.mockResolvedValue({ conversationId: 'cv-1', walletId: 'W123' })
  h.notify.mockReset()
  h.notify.mockResolvedValue(2)
})

describe('POST /api/vircle-chat/read', () => {
  it('needs the capability to send messages (the same gate as replying)', async () => {
    await call({ conversationId: 'cv-1' })
    expect(h.requireCapability).toHaveBeenCalledWith('messages.send')
  })

  it('answers the capability error and does nothing else when the caller may not', async () => {
    h.requireCapability.mockRejectedValueOnce(Object.assign(new Error("Missing capability 'messages.send'"), { status: 403 }))
    const res = await call({ conversationId: 'cv-1' })
    expect(res.status).toBe(403)
    expect(h.findVircleTarget).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })

  it("checks the conversation with the caller's own client and workspace, then notifies with the service client", async () => {
    const res = await call({ conversationId: 'cv-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, notified: 2 })
    expect(h.findVircleTarget).toHaveBeenCalledWith(h.supabase, 'acct-1', 'cv-1')
    expect(h.notify).toHaveBeenCalledWith(h.admin, 'acct-1', 'cv-1')
  })

  it('answers 404 for a conversation that is not in the caller\'s workspace or is not a Vircle Chat one', async () => {
    h.findVircleTarget.mockResolvedValueOnce(null)
    const res = await call({ conversationId: 'cv-other' })
    expect(res.status).toBe(404)
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('answers 400 without a conversation id, or with a body that is not JSON', async () => {
    expect((await call({})).status).toBe(400)
    expect((await call({ conversationId: 42 })).status).toBe(400)
    expect((await call('not json')).status).toBe(400)
    expect(h.notify).not.toHaveBeenCalled()
  })
})
