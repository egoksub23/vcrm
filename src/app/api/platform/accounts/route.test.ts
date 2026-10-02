import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  rpc: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  generateLink: vi.fn(),
  sendWelcome: vi.fn(),
  profileRow: { account_id: 'acct-new' } as { account_id?: string } | null,
  accountUpdates: [] as Record<string, unknown>[],
  platformUpdates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/platform/auth', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/auth/account', () => ({
  toErrorResponse: (err: unknown) =>
    Response.json({ error: (err as Error).message }, { status: (err as { status?: number }).status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/email/tenant-welcome-email', () => ({ sendTenantWelcomeEmail: h.sendWelcome }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    auth: { admin: { createUser: h.createUser, deleteUser: h.deleteUser, generateLink: h.generateLink } },
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.profileRow, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        if (table === 'accounts') h.accountUpdates.push(patch)
        if (table === 'account_platform') h.platformUpdates.push(patch)
        return { eq: async () => ({ error: null }) }
      },
    }),
  }),
}))

import { GET, POST } from './route'

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/platform/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'crm.test' },
      body: JSON.stringify(body),
    }),
  )

const VALID = { companyName: 'Acme Sdn Bhd', ownerEmail: 'Boss@Acme.com', ownerName: 'Ann', plan: 'pro', seats: 8 }

beforeEach(() => {
  for (const k of ['requirePlatformAdmin', 'rpc', 'createUser', 'deleteUser', 'generateLink', 'sendWelcome'] as const) h[k].mockReset()
  h.profileRow = { account_id: 'acct-new' }
  h.accountUpdates = []
  h.platformUpdates = []
  h.requirePlatformAdmin.mockResolvedValue({ supabase: { rpc: h.rpc }, userId: 'op-1' })
  h.createUser.mockResolvedValue({ data: { user: { id: 'user-new' } }, error: null })
  h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'HASH123' } }, error: null })
  h.sendWelcome.mockResolvedValue(true)
  delete process.env.NEXT_PUBLIC_SITE_URL
})

describe('GET /api/platform/accounts', () => {
  it('returns the operator list from the RPC', async () => {
    h.rpc.mockResolvedValue({ data: [{ id: 'a', name: 'Acme' }], error: null })
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).accounts).toEqual([{ id: 'a', name: 'Acme' }])
    expect(h.rpc).toHaveBeenCalledWith('platform_list_accounts')
  })

  it('refuses a caller who is not a platform admin', async () => {
    h.requirePlatformAdmin.mockRejectedValue(Object.assign(new Error('Platform administrator access required'), { status: 403 }))
    const res = await GET()
    expect(res.status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/platform/accounts', () => {
  it('creates the login flagged as provisioned, names the account, applies plan/seats and emails the link', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual({ accountId: 'acct-new', emailed: true })

    expect(h.createUser).toHaveBeenCalledWith({
      email: 'boss@acme.com',
      email_confirm: true,
      user_metadata: { full_name: 'Ann' },
      app_metadata: { provisioned: true },
    })
    expect(h.accountUpdates).toEqual([{ name: 'Acme Sdn Bhd' }])
    expect(h.platformUpdates).toEqual([{ plan: 'pro', limits: { seats: 8 } }])

    const sent = h.sendWelcome.mock.calls[0][0]
    expect(sent.to).toBe('boss@acme.com')
    expect(sent.url).toBe(
      'http://localhost/auth/confirm?token_hash=HASH123&type=recovery&next=%2Freset-password',
    )
  })

  it('returns the one-time link to the operator when no email provider is configured', async () => {
    h.sendWelcome.mockResolvedValue(false)
    const res = await post({ companyName: 'Acme', ownerEmail: 'a@b.co' })
    const body = await res.json()
    expect(body.emailed).toBe(false)
    expect(body.setPasswordUrl).toContain('/auth/confirm?token_hash=HASH123')
  })

  it('rejects a bad body before touching auth', async () => {
    const res = await post({ companyName: '', ownerEmail: 'nope' })
    expect(res.status).toBe(400)
    expect(h.createUser).not.toHaveBeenCalled()
  })

  it('answers 409 when the email already has a login', async () => {
    h.createUser.mockResolvedValue({ data: { user: null }, error: { message: 'A user with this email address has already been registered' } })
    const res = await post(VALID)
    expect(res.status).toBe(409)
  })

  it('removes the new login and fails when no workspace was built for it', async () => {
    h.profileRow = null
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await post(VALID)
      expect(res.status).toBe(500)
    } finally {
      err.mockRestore()
    }
    expect(h.deleteUser).toHaveBeenCalledWith('user-new')
  })

  it('refuses a caller who is not a platform admin without creating anything', async () => {
    h.requirePlatformAdmin.mockRejectedValue(Object.assign(new Error('Platform administrator access required'), { status: 403 }))
    const res = await post(VALID)
    expect(res.status).toBe(403)
    expect(h.createUser).not.toHaveBeenCalled()
  })
})
