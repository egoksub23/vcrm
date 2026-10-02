import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireCapability: vi.fn(),
  rows: [] as unknown[],
  readRow: { app_secret_enc: null } as { app_secret_enc: string | null } | null,
  updates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: h.getCurrentAccount,
  requireCapability: h.requireCapability,
  toErrorResponse: (err: unknown) =>
    Response.json({ error: (err as Error).message }, { status: (err as { status?: number }).status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc:${s}` }))

import { DELETE, GET, PUT } from './route'

function ctx() {
  return {
    userId: 'u1',
    accountId: 'a1',
    supabase: {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.readRow, error: null }) }) }),
        update: (patch: Record<string, unknown>) => {
          h.updates.push(patch)
          const chain: Record<string, unknown> = {}
          chain.eq = () => chain
          chain.select = async () => ({ data: h.rows, error: null })
          chain.then = (resolve: (v: unknown) => unknown) => resolve({ error: null })
          return chain
        },
      }),
    },
  }
}

const put = (body: unknown) =>
  PUT(new Request('http://localhost/api/whatsapp/app-secret', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  h.getCurrentAccount.mockReset()
  h.requireCapability.mockReset()
  h.getCurrentAccount.mockResolvedValue(ctx())
  h.requireCapability.mockResolvedValue(ctx())
  h.rows = [{ id: 'cfg1' }]
  h.readRow = { app_secret_enc: null }
  h.updates = []
})

describe('/api/whatsapp/app-secret', () => {
  it('GET reports whether a secret is stored and never returns it', async () => {
    h.readRow = { app_secret_enc: 'enc:abc' }
    const res = await GET()
    expect(await res.json()).toEqual({ has_app_secret: true })
    h.readRow = null
    expect(await (await GET()).json()).toEqual({ has_app_secret: false })
  })

  it('PUT stores the secret encrypted and answers without echoing it', async () => {
    const res = await put({ app_secret: ' 0123456789abcdef0123456789abcdef ' })
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).not.toContain('0123456789abcdef')
    expect(h.updates).toEqual([{ app_secret_enc: 'enc:0123456789abcdef0123456789abcdef' }])
    expect(h.requireCapability).toHaveBeenCalledWith('channels.manage')
  })

  it.each([[''], ['short'], ['has spaces in it 0123456789'], ['x'.repeat(129)], [42], [null]])('PUT rejects %j', async (value) => {
    const res = await put({ app_secret: value })
    expect(res.status).toBe(400)
    expect(h.updates).toEqual([])
  })

  it('PUT says to connect the number first when there is no WhatsApp row', async () => {
    h.rows = []
    const res = await put({ app_secret: '0123456789abcdef0123456789abcdef' })
    expect(res.status).toBe(404)
  })

  it('DELETE clears it', async () => {
    const res = await DELETE()
    expect(await res.json()).toEqual({ has_app_secret: false })
    expect(h.updates).toEqual([{ app_secret_enc: null }])
  })

  it('refuses a caller without channels.manage', async () => {
    h.requireCapability.mockRejectedValue(Object.assign(new Error('This action requires the channels.manage permission'), { status: 403 }))
    expect((await put({ app_secret: '0123456789abcdef0123456789abcdef' })).status).toBe(403)
    expect((await DELETE()).status).toBe(403)
    expect(h.updates).toEqual([])
  })
})
