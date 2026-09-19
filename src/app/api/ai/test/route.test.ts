import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listModels: vi.fn(),
  validateAiCredentials: vi.fn(),
  decrypt: vi.fn((v: string) => `plain:${v}`),
  stored: null as null | { api_key: string; provider: string; base_url: string | null },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: mocks.decrypt }))
vi.mock('@/lib/ai/models', () => ({ listModels: mocks.listModels }))
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: mocks.validateAiCredentials }))
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: vi.fn(async (u: string) => !u.includes('internal.test')) }))

import { AiError } from '@/lib/ai/types'
import { POST } from './route'

const supabase = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.stored }) }) }),
  }),
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.stored = null
  mocks.requireRole.mockResolvedValue({ supabase, accountId: 'a1', userId: 'u1' })
  mocks.listModels.mockResolvedValue(['kimi-a', 'kimi-b'])
  mocks.validateAiCredentials.mockResolvedValue({ sample: 'OK', usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 }, latencyMs: 321 })
})

describe('POST /api/ai/test', () => {
  const kimi = { provider: 'openai_compatible', base_url: 'https://api.moonshot.ai/v1', api_key: 'sk-typed' }

  it('lists models only when no model is chosen yet', async () => {
    const res = await post(kimi)
    expect(await res.json()).toEqual({ ok: true, models: ['kimi-a', 'kimi-b'], tested_model: false })
    expect(mocks.validateAiCredentials).not.toHaveBeenCalled()
  })

  it('also sends a test completion and reports time and tokens when a model is given', async () => {
    const res = await post({ ...kimi, model: 'kimi-a' })
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, tested_model: true, latency_ms: 321, sample: 'OK' })
    expect(mocks.validateAiCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai_compatible', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-a' }),
    )
  })

  it('refuses a private or non-https base URL before calling anything', async () => {
    for (const [url, code] of [
      ['https://internal.test/v1', 'base_url_blocked'],
      ['http://api.example.com/v1', 'base_url_not_https'],
      ['', 'base_url_required'],
    ]) {
      const res = await post({ ...kimi, base_url: url })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe(code)
    }
    expect(mocks.listModels).not.toHaveBeenCalled()
  })

  it('adds the region hint when a Kimi key is rejected', async () => {
    mocks.listModels.mockRejectedValue(new AiError('rejected', { code: 'invalid_key', status: 401 }))
    const res = await post(kimi)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_key', hint: 'kimi_region' })
  })

  it('carries on to the completion when the service has no models endpoint', async () => {
    mocks.listModels.mockRejectedValue(new AiError('no /models', { code: 'provider_error' }))
    const res = await post({ ...kimi, model: 'm' })
    expect(await res.json()).toMatchObject({ ok: true, models: null, tested_model: true })
  })

  it('asks for a model name when there is no list and none was typed', async () => {
    mocks.listModels.mockRejectedValue(new AiError('no /models', { code: 'provider_error' }))
    const res = await post(kimi)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('models_unavailable')
  })

  describe('reusing the stored key', () => {
    const noKey = { provider: 'openai_compatible', base_url: 'https://api.moonshot.ai/v1' }

    it('works for the same provider and URL', async () => {
      mocks.stored = { api_key: 'enc', provider: 'openai_compatible', base_url: 'https://api.moonshot.ai/v1' }
      const res = await post(noKey)
      expect((await res.json()).ok).toBe(true)
      expect(mocks.listModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'plain:enc' }))
    })

    it('is refused for a different URL, so it can’t be sent to another host', async () => {
      mocks.stored = { api_key: 'enc', provider: 'openai_compatible', base_url: 'https://api.moonshot.ai/v1' }
      const res = await post({ ...noKey, base_url: 'https://api.deepseek.com/v1' })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('key_required')
      expect(mocks.listModels).not.toHaveBeenCalled()
    })

    it('is refused for a different provider', async () => {
      mocks.stored = { api_key: 'enc', provider: 'openai', base_url: null }
      const res = await post(noKey)
      expect((await res.json()).code).toBe('key_required')
    })

    it('asks for a key when none is stored', async () => {
      const res = await post(noKey)
      expect((await res.json()).code).toBe('key_required')
    })
  })
})
