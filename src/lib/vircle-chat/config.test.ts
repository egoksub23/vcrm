import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}))

import {
  findConfigByKey,
  generateApiToken,
  generateSigningSecret,
  generateWorkspaceKey,
  openConfig,
  sealSecret,
  toConfigView,
  WORKSPACE_KEY_PATTERN,
  type VircleChatConfigRow,
} from './config'
import { VircleSendError } from './errors'
import { GatewayError } from './gateway'

const row: VircleChatConfigRow = {
  id: 'vc-1',
  account_id: 'acct-1',
  workspace_key: 'vcw_abcdefghijklmnop1234',
  gateway_base_url: 'https://gw.example.com',
  signing_secret: 'enc:vcs_secret',
  api_token: 'enc:vct_token',
  push_alerts_enabled: true,
  enabled: true,
  last_inbound_at: '2026-10-02T09:00:00Z',
  last_error: null,
  connected_by_user_id: 'u1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}

describe('generated values', () => {
  it('make a workspace key the database accepts, and secrets nobody can guess', () => {
    const key = generateWorkspaceKey()
    expect(key).toMatch(WORKSPACE_KEY_PATTERN)
    expect(generateWorkspaceKey()).not.toBe(key)
    expect(generateSigningSecret()).toMatch(/^vcs_[A-Za-z0-9_-]{40,}$/)
    expect(generateApiToken()).toMatch(/^vct_[A-Za-z0-9_-]{40,}$/)
    expect(generateSigningSecret()).not.toBe(generateSigningSecret())
  })

  it('seal and open round-trip through the encryption', () => {
    expect(openConfig({ ...row, signing_secret: sealSecret('s1'), api_token: sealSecret('t1') })).toMatchObject({
      signingSecret: 's1',
      apiToken: 't1',
    })
  })
})

describe('toConfigView', () => {
  it('never carries a secret, encrypted or not', () => {
    const view = toConfigView(row)
    expect(JSON.stringify(view)).not.toMatch(/secret|token|enc:/i)
    expect(view).toEqual({
      workspaceKey: 'vcw_abcdefghijklmnop1234',
      gatewayBaseUrl: 'https://gw.example.com',
      pushAlertsEnabled: true,
      enabled: true,
      lastInboundAt: '2026-10-02T09:00:00Z',
      lastError: null,
      createdAt: '2026-10-01T00:00:00Z',
    })
  })
})

describe('findConfigByKey', () => {
  it('does not query for a key that cannot be one', async () => {
    const admin = { from: vi.fn() }
    expect(await findConfigByKey(admin as never, "x' or 1=1 --")).toBeNull()
    expect(await findConfigByKey(admin as never, '')).toBeNull()
    expect(admin.from).not.toHaveBeenCalled()
  })
})

describe('VircleSendError', () => {
  it('maps a gateway code to one the inbox already explains, and keeps the gateway\'s own words', () => {
    const e = new VircleSendError(new GatewayError('user_not_found', 'No such user', 404, false))
    expect(e).toMatchObject({ code: 551, details: 'user_not_found: No such user', message: 'Vircle Chat: No such user' })
    expect(new VircleSendError(new GatewayError('unauthorized', 'bad token', 401, false)).code).toBe(401)
    expect(new VircleSendError(new GatewayError('rate_limited', 'slow', 429, true)).code).toBe(4)
    expect(new VircleSendError(new GatewayError('unreachable', 'down', 0, true)).code).toBe(2)
    expect(new VircleSendError(new GatewayError('invalid_media', 'x', 400, false)).code).toBe(131053)
  })

  it('falls back by whether a retry could help', () => {
    expect(new VircleSendError(new GatewayError('brand_new_code', 'x', 400, false)).code).toBe(100)
    expect(new VircleSendError(new GatewayError('brand_new_code', 'x', 503, true)).code).toBe(2)
  })
})
