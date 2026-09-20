import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCapabilities } from '@/lib/auth/capabilities'
import type { AccountRole } from '@/lib/auth/roles'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getCurrentAccount: vi.fn(),
  inserts: [] as Record<string, unknown>[],
  view: null as null | { id: string; owner_id: string | null },
  updates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireCapability: h.requireCapability,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push(row)
        return b
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push(row)
        return b
      }
      b.delete = () => b
      b.select = () => b
      b.eq = () => b
      b.single = async () => ({ data: h.inserts[h.inserts.length - 1], error: null })
      b.maybeSingle = async () => ({ data: h.view, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ error: null })
      return b
    },
  }),
}))

import { POST } from './route'
import { DELETE, PATCH } from './[id]/route'

function as(role: AccountRole, overrides?: Record<string, boolean>) {
  h.requireCapability.mockResolvedValue({
    userId: 'u1',
    accountId: 'a1',
    role,
    capabilities: resolveCapabilities(role, overrides),
  })
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/inbox-views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  h.requireCapability.mockReset()
  h.inserts.length = 0
  h.updates.length = 0
  h.view = null
})

describe('POST /api/inbox-views', () => {
  it('needs conversations.manage for any view', async () => {
    as('agent')
    await post({ name: 'Mine', filter_config: {} })
    expect(h.requireCapability).toHaveBeenCalledWith('conversations.manage')
  })

  it('lets an agent save a personal view owned by them', async () => {
    as('agent')
    const res = await post({ name: 'Mine', filter_config: {} })
    expect(res.status).toBe(201)
    expect(h.inserts[0]).toMatchObject({ owner_id: 'u1', account_id: 'a1' })
  })

  it('refuses a shared view without inbox.shared-views (an agent)', async () => {
    as('agent')
    const res = await post({ name: 'Team', shared: true })
    expect(res.status).toBe(403)
    expect(h.inserts).toHaveLength(0)
  })

  it('lets an admin and an owner save a shared view (owner_id null)', async () => {
    for (const role of ['admin', 'owner'] as const) {
      as(role)
      const res = await post({ name: 'Team', shared: true })
      expect(res.status).toBe(201)
    }
    expect(h.inserts.every((r) => r.owner_id === null)).toBe(true)
  })

  it('refuses a shared view for an admin whose inbox.shared-views was switched off', async () => {
    as('admin', { 'inbox.shared-views': false })
    expect((await post({ name: 'Team', shared: true })).status).toBe(403)
    // ...but they can still keep personal views.
    expect((await post({ name: 'Mine' })).status).toBe(201)
  })
})

describe('PATCH / DELETE /api/inbox-views/[id]', () => {
  const patch = (id: string) =>
    PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New' }),
      }),
      params(id),
    )
  const del = (id: string) => DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params(id))

  it('only lets a holder of inbox.shared-views edit or delete a shared view', async () => {
    h.view = { id: 'v1', owner_id: null }
    as('agent')
    expect((await patch('v1')).status).toBe(403)
    expect((await del('v1')).status).toBe(403)
    as('admin')
    expect((await patch('v1')).status).toBe(200)
    expect((await del('v1')).status).toBe(200)
    as('admin', { 'inbox.shared-views': false })
    expect((await patch('v1')).status).toBe(403)
  })

  it('only lets the owner of a personal view change it', async () => {
    h.view = { id: 'v2', owner_id: 'someone-else' }
    as('admin')
    expect((await patch('v2')).status).toBe(403)
    h.view = { id: 'v2', owner_id: 'u1' }
    expect((await patch('v2')).status).toBe(200)
  })

  it('404s an unknown view', async () => {
    h.view = null
    as('agent')
    expect((await del('nope')).status).toBe(404)
  })
})
