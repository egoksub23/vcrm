import { beforeEach, describe, expect, it, vi } from 'vitest'

// An automation that sends documents for signing sends them in the workspace's name, so saving one (or keeping
// one active) needs sign.send on top of automations.manage. Everything else about the routes is unchanged.

const m = vi.hoisted(() => ({
  caps: new Set<string>(),
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  stored: [] as { step_type: string; step_config: Record<string, unknown> }[],
}))

class Forbidden extends Error {
  readonly status = 403
}

vi.mock('@/lib/auth/account', () => ({
  requireCapability: async (cap: string) => {
    if (!m.caps.has(cap)) throw new Forbidden(`This action requires the '${cap}' permission`)
    return { accountId: 'acct-1', userId: 'u1', capabilities: m.caps }
  },
  assertCapability: (ctx: { capabilities: Set<string> }, cap: string) => {
    if (!ctx.capabilities.has(cap)) throw new Forbidden(`This action requires the '${cap}' permission`)
  },
  toErrorResponse: (e: { message?: string; status?: number }) => Response.json({ error: e.message ?? 'error' }, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { account_id: 'acct-1' } }) }) }) }),
  }),
}))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        insert: (row: Record<string, unknown>) => ((m.inserted.push(row)), b),
        update: (row: Record<string, unknown>) => ((m.updated.push(row)), b),
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { id: 'a1', user_id: 'u1', is_active: false, trigger_type: 'tag_added', trigger_config: { tag_id: 't1' } } }),
        single: async () => ({ data: { id: 'a1', ...(m.inserted.at(-1) ?? {}) }, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      }
      return b
    },
  }),
}))
vi.mock('@/lib/automations/steps-tree', () => ({
  insertSteps: async () => null,
  replaceSteps: async () => null,
  loadStepsTree: async () => m.stored,
}))
vi.mock('@/lib/automations/ai/activation', () => ({ aiSetupForActivation: async () => undefined }))
vi.mock('@/lib/automations/sign-activation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/automations/sign-activation')>()),
  signSetupForActivation: async () => undefined,
}))

import { POST } from './route'
import { PATCH } from './[id]/route'

const SIGN_STEP = { step_type: 'send_sign_document', step_config: { template_id: 'tpl-1', recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }], merge_values: {}, send: true } }
const TAG_STEP = { step_type: 'add_tag', step_config: { tag_id: 't1' } }

const post = (body: unknown) => POST(new Request('http://x/api/automations', { method: 'POST', body: JSON.stringify(body) }))
const patch = (body: unknown) => PATCH(new Request('http://x/api/automations/a1', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'a1' }) })

const base = { name: 'Merchant onboarding', trigger_type: 'tag_added', trigger_config: { tag_id: 't1' } }

beforeEach(() => {
  m.caps = new Set(['automations.manage'])
  m.inserted = []
  m.updated = []
  m.stored = []
})

describe('creating an automation', () => {
  it('without sign.send, a Send document for signing step is refused and nothing is saved', async () => {
    const res = await post({ ...base, is_active: false, steps: [SIGN_STEP] })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('sign.send')
    expect(m.inserted).toEqual([])
  })

  it('also when it sits inside a branch', async () => {
    const res = await post({ ...base, is_active: false, steps: [{ step_type: 'condition', step_config: { subject: 'tag_presence', operand: 't' }, branches: { yes: [SIGN_STEP], no: [] } }] })
    expect(res.status).toBe(403)
  })

  it('with sign.send it is saved', async () => {
    m.caps.add('sign.send')
    const res = await post({ ...base, is_active: false, steps: [SIGN_STEP] })
    expect(res.status).toBe(201)
    expect(m.inserted).toHaveLength(1)
  })

  it('an automation without the step needs only automations.manage', async () => {
    const res = await post({ ...base, is_active: false, steps: [TAG_STEP] })
    expect(res.status).toBe(201)
  })
})

describe('changing an automation', () => {
  it('saving steps that send documents needs sign.send', async () => {
    const res = await patch({ steps: [SIGN_STEP] })
    expect(res.status).toBe(403)
    expect(m.updated).toEqual([])
    m.caps.add('sign.send')
    expect((await patch({ steps: [SIGN_STEP] })).status).toBe(200)
  })

  it('switching on an automation that already has the step needs sign.send too, and switching off does not', async () => {
    m.stored = [SIGN_STEP]
    expect((await patch({ is_active: true })).status).toBe(403)
    expect((await patch({ is_active: false })).status).toBe(200)
    m.caps.add('sign.send')
    expect((await patch({ is_active: true })).status).toBe(200)
  })

  it('renaming or editing steps without the step is untouched', async () => {
    expect((await patch({ name: 'New name', steps: [TAG_STEP] })).status).toBe(200)
  })
})
