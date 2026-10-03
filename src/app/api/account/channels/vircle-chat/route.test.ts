import { createHmac } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  checkGatewayHealth: vi.fn(),
  state: {
    platform: null as Record<string, unknown> | null,
    config: null as Record<string, unknown> | null,
    inserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: vi.fn(),
  requireCapability: h.requireCapability,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/gmail/oauth', () => ({ getOAuthBaseUrl: () => 'https://halo.test' }))
// A readable stand-in for the real cipher, so a test can tell "stored as ciphertext" from "stored as is".
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (plain: string) => `enc:${plain}`,
  decrypt: (cipher: string) => cipher.replace(/^enc:/, ''),
}))
vi.mock('@/lib/vircle-chat/gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vircle-chat/gateway')>()),
  checkGatewayHealth: h.checkGatewayHealth,
}))

// An in-memory stand-in for the service-role client: just the two tables these routes touch.
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let payload: Record<string, unknown> = {}
      const run = async () => {
        if (table === 'account_platform') return { data: h.state.platform, error: null }
        if (op === 'insert') {
          h.state.inserts.push(payload)
          h.state.config = {
            id: 'cfg-1',
            enabled: true,
            last_inbound_at: null,
            last_error: null,
            created_at: '2026-10-02T00:00:00Z',
            updated_at: '2026-10-02T00:00:00Z',
            ...payload,
          }
          return { data: h.state.config, error: null }
        }
        if (op === 'update') {
          h.state.updates.push(payload)
          if (h.state.config) h.state.config = { ...h.state.config, ...payload }
          return { data: h.state.config, error: null }
        }
        if (op === 'delete') {
          h.state.config = null
          return { data: null, error: null }
        }
        return { data: h.state.config, error: null }
      }
      const b = {
        select: () => b,
        eq: () => b,
        insert: (p: Record<string, unknown>) => ((op = 'insert'), (payload = p), b),
        update: (p: Record<string, unknown>) => ((op = 'update'), (payload = p), b),
        delete: () => ((op = 'delete'), b),
        maybeSingle: run,
        single: run,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
      }
      return b
    },
  }),
}))

import { DELETE, GET, PATCH, PUT } from './route'
import { POST as rotateSecret } from './secret/route'
import { POST as rotateToken } from './token/route'
import { POST as testConnection } from './test/route'
import { POST as openSimulator } from './simulator/route'

const SECRET_FIELDS = ['signing_secret', 'api_token', 'signingSecret', 'apiToken', 'secrets']

const req = (method: string, body?: unknown) =>
  new Request('https://halo.test/api/account/channels/vircle-chat', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const existingRow = () => ({
  id: 'cfg-1',
  account_id: 'a1',
  workspace_key: 'vcw_abcdefghijklmnopqrst',
  gateway_base_url: 'https://gw.example.com',
  signing_secret: 'enc:vcs_old',
  api_token: 'enc:vct_old',
  enabled: true,
  last_inbound_at: null,
  last_error: null,
  connected_by_user_id: 'u1',
  created_at: '2026-10-02T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
})

beforeEach(() => {
  h.requireCapability.mockReset().mockResolvedValue({ userId: 'u1', accountId: 'a1' })
  h.checkGatewayHealth.mockReset().mockResolvedValue({ ok: true })
  h.state.platform = null // no row: every flag reads as enabled
  h.state.config = null
  h.state.inserts = []
  h.state.updates = []
})

describe('PUT creates the connection', () => {
  it('returns the signing secret and API token once, with no-store, and stores only ciphertext', async () => {
    const res = await PUT(req('PUT', { gateway_base_url: 'https://gw.example.com/' }))
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.secrets.signingSecret).toMatch(/^vcs_/)
    expect(body.secrets.apiToken).toMatch(/^vct_/)
    expect(body.webhookUrl).toBe('https://halo.test/api/vircle-chat/webhook')
    expect(body.config.workspaceKey).toMatch(/^vcw_/)
    expect(body.config.gatewayBaseUrl).toBe('https://gw.example.com')

    const stored = h.state.inserts[0]
    expect(stored.signing_secret).toBe(`enc:${body.secrets.signingSecret}`)
    expect(stored.api_token).toBe(`enc:${body.secrets.apiToken}`)
    expect(stored.signing_secret).not.toBe(body.secrets.signingSecret)
    expect(stored.account_id).toBe('a1')
    expect(stored.connected_by_user_id).toBe('u1')
    // The config view that comes with the secrets carries none of them.
    expect(JSON.stringify(body.config)).not.toContain('vcs_')
    expect(JSON.stringify(body.config)).not.toContain('vct_')
  })

  it('rejects an address that is not https with 400 and creates nothing', async () => {
    const res = await PUT(req('PUT', { gateway_base_url: 'http://gw.example.com' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/https/)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('rejects a missing or garbled address with 400', async () => {
    expect((await PUT(req('PUT', {}))).status).toBe(400)
    expect((await PUT(req('PUT', { gateway_base_url: 'not a url' }))).status).toBe(400)
  })

  it('on a second save only updates the address: no secrets, no new insert, no push setting', async () => {
    h.state.config = existingRow()
    const res = await PUT(req('PUT', { gateway_base_url: 'https://other.example.com' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.secrets).toBeUndefined()
    expect(body.config.gatewayBaseUrl).toBe('https://other.example.com')
    expect(body.config).not.toHaveProperty('pushAlertsEnabled')
    expect(h.state.inserts).toHaveLength(0)
    expect(h.state.updates[0]).not.toHaveProperty('signing_secret')
    expect(h.state.updates[0]).not.toHaveProperty('api_token')
  })
})

describe('GET', () => {
  it('reports "not configured" with the webhook address', async () => {
    const res = await GET(req('GET'))
    expect(await res.json()).toEqual({
      featureEnabled: true,
      configured: false,
      config: null,
      webhookUrl: 'https://halo.test/api/vircle-chat/webhook',
    })
  })

  it('never contains a secret field, not even the encrypted one', async () => {
    h.state.config = existingRow()
    const res = await GET(req('GET'))
    const text = await res.text()
    for (const field of SECRET_FIELDS) expect(text).not.toContain(field)
    expect(text).not.toContain('enc:')
    expect(text).not.toContain('vcs_')
    expect(text).not.toContain('vct_')
    const body = JSON.parse(text)
    expect(body.configured).toBe(true)
    expect(body.config.workspaceKey).toBe('vcw_abcdefghijklmnopqrst')
  })

  it('says featureEnabled false (and shows no connection) when the operator flag is off', async () => {
    h.state.platform = { status: 'active', features: { vircle_chat: false } }
    h.state.config = existingRow()
    const body = await (await GET(req('GET'))).json()
    expect(body.featureEnabled).toBe(false)
    expect(body.config).toBeNull()
  })
})

describe('the operator flag', () => {
  beforeEach(() => {
    h.state.platform = { status: 'active', features: { vircle_chat: false } }
    h.state.config = existingRow()
  })

  it('refuses every write route with 403 and the agreed message', async () => {
    const calls: [string, () => Promise<Response>][] = [
      ['PUT', () => PUT(req('PUT', { gateway_base_url: 'https://gw.example.com' }))],
      ['PATCH', () => PATCH(req('PATCH', { enabled: false }))],
      ['DELETE', () => DELETE()],
      ['secret', () => rotateSecret()],
      ['token', () => rotateToken()],
      ['test', () => testConnection()],
    ]
    for (const [name, call] of calls) {
      const res = await call()
      expect(res.status, name).toBe(403)
      expect((await res.json()).error, name).toBe('Vircle Chat is not enabled for this workspace')
    }
    expect(h.state.inserts).toHaveLength(0)
    expect(h.state.updates).toHaveLength(0)
    expect(h.state.config).not.toBeNull()
    expect(h.checkGatewayHealth).not.toHaveBeenCalled()
  })

  it('also refuses a suspended workspace', async () => {
    h.state.platform = { status: 'suspended', features: {} }
    expect((await rotateToken()).status).toBe(403)
  })
})

describe('needs channels.manage', () => {
  it('stops at the capability check', async () => {
    h.requireCapability.mockRejectedValue(new Error('forbidden'))
    expect((await PUT(req('PUT', { gateway_base_url: 'https://gw.example.com' }))).status).toBe(403)
    expect((await rotateSecret()).status).toBe(403)
    expect(h.requireCapability).toHaveBeenCalledWith('channels.manage')
  })
})

describe('rotation', () => {
  beforeEach(() => {
    h.state.config = existingRow()
  })

  it('POST secret returns a new signing secret once, no-store, and stores it encrypted', async () => {
    const res = await rotateSecret()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const { signingSecret } = await res.json()
    expect(signingSecret).toMatch(/^vcs_/)
    expect(signingSecret).not.toBe('vcs_old')
    expect(h.state.updates[0].signing_secret).toBe(`enc:${signingSecret}`)
    expect(h.state.updates[0]).not.toHaveProperty('api_token')
  })

  it('POST token returns a new API token once, no-store, and stores it encrypted', async () => {
    const res = await rotateToken()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const { apiToken } = await res.json()
    expect(apiToken).toMatch(/^vct_/)
    expect(h.state.updates[0].api_token).toBe(`enc:${apiToken}`)
    expect(h.state.updates[0]).not.toHaveProperty('signing_secret')
  })

  it('two rotations give two different values', async () => {
    const a = (await (await rotateSecret()).json()).signingSecret
    const b = (await (await rotateSecret()).json()).signingSecret
    expect(a).not.toBe(b)
  })

  it('answers 404 when there is no connection to rotate', async () => {
    h.state.config = null
    expect((await rotateSecret()).status).toBe(404)
    expect((await rotateToken()).status).toBe(404)
  })
})

describe('POST test', () => {
  beforeEach(() => {
    h.state.config = existingRow()
  })

  it('calls the gateway with the decrypted token and the stored address', async () => {
    const res = await testConnection()
    expect(await res.json()).toEqual({ ok: true })
    expect(h.checkGatewayHealth).toHaveBeenCalledWith({ baseUrl: 'https://gw.example.com', apiToken: 'vct_old' })
  })

  it('passes a failed health check on as { ok: false, error }', async () => {
    h.checkGatewayHealth.mockResolvedValue({ ok: false, error: 'The gateway refused the API token' })
    const res = await testConnection()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, error: 'The gateway refused the API token' })
  })

  it('answers 404 with no connection', async () => {
    h.state.config = null
    expect((await testConnection()).status).toBe(404)
  })
})

describe('PATCH (pause switch) and DELETE', () => {
  beforeEach(() => {
    h.state.config = existingRow()
  })

  it('pauses and resumes', async () => {
    const off = await PATCH(req('PATCH', { enabled: false }))
    expect(off.status).toBe(200)
    expect(await off.json()).toEqual({ success: true, enabled: false })
    expect(h.state.config?.enabled).toBe(false)
    await PATCH(req('PATCH', { enabled: true }))
    expect(h.state.config?.enabled).toBe(true)
  })

  it('no longer takes a push-alerts switch (the gateway decides about push)', async () => {
    expect((await PATCH(req('PATCH', { push_alerts_enabled: true }))).status).toBe(400)
    expect(h.state.config).not.toHaveProperty('push_alerts_enabled')
  })

  it('rejects a body with no boolean', async () => {
    expect((await PATCH(req('PATCH', { enabled: 'yes' }))).status).toBe(400)
    expect((await PATCH(req('PATCH', {}))).status).toBe(400)
  })

  it('PATCH answers 404 with no connection', async () => {
    h.state.config = null
    expect((await PATCH(req('PATCH', { enabled: false }))).status).toBe(404)
  })

  it('DELETE removes the connection', async () => {
    const res = await DELETE()
    expect(await res.json()).toEqual({ disconnected: true })
    expect(h.state.config).toBeNull()
  })
})

describe('POST /simulator (Open simulator)', () => {
  it('answers with the gateway\'s simulator page and a launch token in the fragment, signed with this workspace\'s secret', async () => {
    h.state.config = existingRow()
    const res = await openSimulator()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const { url } = await res.json()
    expect(url.startsWith('https://gw.example.com/simulator#t=')).toBe(true)
    const token = url.split('#t=')[1] as string
    const [payload, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ k: 'vcw_abcdefghijklmnopqrst' })
    expect(signature).toBe(createHmac('sha256', 'vcs_old').update(`vircle-sim.${payload}`).digest('hex'))
    // no secret travels in the answer
    expect(JSON.stringify({ url })).not.toContain('vcs_old')
  })

  it('needs channels.manage', async () => {
    h.state.config = existingRow()
    h.requireCapability.mockRejectedValueOnce(new Error('forbidden'))
    expect((await openSimulator()).status).toBe(403)
  })

  it('is refused when the operator has not enabled Vircle Chat, and when there is no connection', async () => {
    h.state.config = existingRow()
    h.state.platform = { features: { vircle_chat: false } }
    expect((await openSimulator()).status).toBe(403)
    h.state.platform = null
    h.state.config = null
    expect((await openSimulator()).status).toBe(404)
  })
})
