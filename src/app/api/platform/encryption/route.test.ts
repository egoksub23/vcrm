import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  encryptionReport: vi.fn(),
  reencryptAll: vi.fn(),
}))

vi.mock('@/lib/platform/auth', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/auth/account', () => ({
  toErrorResponse: (err: unknown) =>
    Response.json({ error: (err as Error).message }, { status: (err as { status?: number }).status ?? 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ __admin: true }) }))
vi.mock('@/lib/crypto/reencrypt', () => ({
  encryptionReport: h.encryptionReport,
  reencryptAll: h.reencryptAll,
}))

import { EncryptionConfigError } from '@/lib/crypto/keyring'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { GET, POST } from './route'

beforeEach(() => {
  h.requirePlatformAdmin.mockReset()
  h.encryptionReport.mockReset()
  h.reencryptAll.mockReset()
  __resetRateLimitForTests()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: {}, userId: 'op-1' })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/platform/encryption', () => {
  it('returns the report from the service-role client, uncached', async () => {
    h.encryptionReport.mockResolvedValue({ currentKeyId: 'legacy', versioned: false, loadedKeyIds: ['legacy'], columns: [], stale: 0 })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ currentKeyId: 'legacy', stale: 0 })
    expect(h.encryptionReport).toHaveBeenCalledWith({ __admin: true })
  })

  it('is operator only: nothing is read when the caller is refused', async () => {
    h.requirePlatformAdmin.mockRejectedValue(Object.assign(new Error('Platform administrator access required'), { status: 403 }))
    const res = await GET()
    expect(res.status).toBe(403)
    expect(h.encryptionReport).not.toHaveBeenCalled()
  })

  it('reports a bad key configuration clearly, without leaking anything else', async () => {
    h.encryptionReport.mockRejectedValue(new EncryptionConfigError("ENCRYPTION_KEY_ID 'x' is not one of the configured keys"))
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "ENCRYPTION_KEY_ID 'x' is not one of the configured keys", code: 'encryption_misconfigured' })
  })
})

describe('POST /api/platform/encryption', () => {
  it('runs one re-encrypt pass and returns its counts', async () => {
    h.reencryptAll.mockResolvedValue({ rewritten: 4, unreadable: 0, conflicts: 1, finished: true })
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rewritten: 4, unreadable: 0, conflicts: 1, finished: true })
  })

  it('is operator only: nothing is rewritten when the caller is refused', async () => {
    h.requirePlatformAdmin.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }))
    expect((await POST()).status).toBe(403)
    expect(h.reencryptAll).not.toHaveBeenCalled()
  })

  it('is rate limited per operator', async () => {
    h.reencryptAll.mockResolvedValue({ rewritten: 0, unreadable: 0, conflicts: 0, finished: true })
    let last = 200
    for (let i = 0; i < 40; i++) last = (await POST()).status
    expect(last).toBe(429)
  })
})
