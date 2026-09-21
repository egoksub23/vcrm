import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiConfig } from '@/lib/ai/types'

const mocks = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  logAiUsage: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  RATE_LIMITS: { aiAutoReplyAccount: { limit: 30, windowMs: 60_000 } },
}))

import { AiError } from '@/lib/ai/types'
import { checkAiAvailability, createAiCaller } from './caller'
import { AiStepError } from './types'
import { fakeDb, TEST_CONFIG } from './test-helpers'

const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({ ...TEST_CONFIG, ...over })
const usage = { promptTokens: 40, completionTokens: 10, totalTokens: 50 }

beforeEach(() => {
  mocks.loadAiConfig.mockResolvedValue(cfg())
  mocks.generateReply.mockResolvedValue({ text: 'ok', handoff: false, usage })
  mocks.checkRateLimit.mockReturnValue({ success: true })
})

const caller = (over: Partial<Parameters<typeof createAiCaller>[0]> = {}) =>
  createAiCaller({ db: fakeDb({}).db, accountId: 'acct-1', conversationId: 'conv-1', ...over })

describe('routing: every AI step resolves its connection through the `automation` job', () => {
  it('asks for the automation task', async () => {
    await caller().call({ system: 's', messages: [] })
    expect(mocks.loadAiConfig).toHaveBeenCalledWith(expect.anything(), 'acct-1', { task: 'automation' })
  })

  it('uses whichever connection and model that routing resolved to', async () => {
    mocks.loadAiConfig.mockResolvedValue(cfg({ provider: 'anthropic', model: 'claude-x', connectionId: 'conn-9' }))
    const r = await caller().call({ system: 's', messages: [] })
    expect(mocks.generateReply).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ model: 'claude-x', connectionId: 'conn-9' }) }))
    expect(r).toMatchObject({ model: 'claude-x', provider: 'anthropic', tokens: 50, text: 'ok' })
  })

  it('loads the configuration once per run', async () => {
    const c = caller()
    await c.call({ system: 's', messages: [] })
    await c.call({ system: 's', messages: [] })
    expect(mocks.loadAiConfig).toHaveBeenCalledTimes(1)
  })
})

describe('budget: the shared guard, the 80% warning and the 100% stop', () => {
  it('passes the budget guard to the provider call', async () => {
    const db = fakeDb({}).db
    await caller({ db }).call({ system: 's', messages: [] })
    expect(mocks.generateReply).toHaveBeenCalledWith(expect.objectContaining({ guard: { db, accountId: 'acct-1' } }))
  })

  it('a used-up budget is reported as "AI budget used up"', async () => {
    mocks.generateReply.mockRejectedValue(new AiError('The monthly AI token budget has been used up.', { code: 'budget_exceeded', status: 429 }))
    await expect(caller().call({ system: 's', messages: [] })).rejects.toMatchObject({ code: 'budget_exceeded', message: 'AI budget used up' })
    // Nothing was spent, so nothing is logged.
    expect(mocks.logAiUsage).not.toHaveBeenCalled()
  })
})

describe('usage log', () => {
  it('records a row with mode automation, the connection and the tokens', async () => {
    mocks.loadAiConfig.mockResolvedValue(cfg({ connectionId: 'conn-9' }))
    await caller().call({ system: 's', messages: [] })
    expect(mocks.logAiUsage).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'automation',
      connectionId: 'conn-9',
      provider: 'openai',
      model: 'test-model',
      usage,
    })
  })

  it('can be switched off for a caller that logs elsewhere', async () => {
    await caller({ logUsage: false }).call({ system: 's', messages: [] })
    expect(mocks.logAiUsage).not.toHaveBeenCalled()
  })
})

describe('limits', () => {
  it('a hard timeout per call, and a cap on the output length', async () => {
    await caller().call({ system: 's', messages: [], maxOutputTokens: 200 })
    expect(mocks.generateReply).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 20_000, maxOutputTokens: 200 }))
  })

  it('a provider timeout is reported as one', async () => {
    mocks.generateReply.mockRejectedValue(new AiError('slow', { code: 'timeout', status: 504 }))
    await expect(caller().call({ system: 's', messages: [] })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('other provider errors and surprises become ai_error, never a raw throw', async () => {
    mocks.generateReply.mockRejectedValueOnce(new AiError('bad key', { code: 'invalid_key' }))
    await expect(caller().call({ system: 's', messages: [] })).rejects.toMatchObject({ code: 'ai_error', message: 'bad key' })
    mocks.generateReply.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(caller().call({ system: 's', messages: [] })).rejects.toBeInstanceOf(AiStepError)
  })

  it('the per-account AI rate limit is shared with auto-reply (same bucket) and refuses over the limit', async () => {
    await caller().call({ system: 's', messages: [] })
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('ai-autoreply:acct-1', { limit: 30, windowMs: 60_000 })
    mocks.checkRateLimit.mockReturnValue({ success: false })
    await expect(caller().call({ system: 's', messages: [] })).rejects.toMatchObject({ code: 'rate_limited' })
    expect(mocks.generateReply).toHaveBeenCalledTimes(1)
  })

  it('the Test panel uses its own bucket', async () => {
    await caller({ rateKey: 'automation-ai-test-calls:acct-1' }).call({ system: 's', messages: [] })
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('automation-ai-test-calls:acct-1', expect.anything())
  })
})

describe('not configured and the privacy notice', () => {
  it('AI not set up, switched off, or the Automations job off: every call is refused', async () => {
    mocks.loadAiConfig.mockResolvedValue(null)
    await expect(caller().call({ system: 's', messages: [] })).rejects.toMatchObject({ code: 'ai_not_configured' })
    await expect(caller().getConfig()).rejects.toMatchObject({ code: 'ai_not_configured' })
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('an undecryptable key reads as not set up', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.loadAiConfig.mockRejectedValue(new Error('bad decrypt'))
    const a = await checkAiAvailability(fakeDb({}).db, 'acct-1')
    expect(a).toMatchObject({ ok: false, code: 'ai_not_configured' })
    err.mockRestore()
  })

  it('OpenAI and Anthropic (your own key) need no notice, as in Setup', async () => {
    expect(await checkAiAvailability(fakeDb({}).db, 'acct-1')).toMatchObject({ ok: true })
  })

  it('an OpenAI-compatible host must have the customer-data notice confirmed, else the step refuses to run', async () => {
    mocks.loadAiConfig.mockResolvedValue(cfg({ provider: 'openai_compatible', baseUrl: 'https://api.moonshot.ai/v1' }))
    const unconfirmed = fakeDb({ ai_configs: [{ account_id: 'acct-1', data_notice_ack_at: null }] })
    expect(await checkAiAvailability(unconfirmed.db, 'acct-1')).toMatchObject({ ok: false, code: 'notice_required' })
    await expect(caller({ db: unconfirmed.db }).call({ system: 's', messages: [] })).rejects.toMatchObject({ code: 'notice_required' })
    expect(mocks.generateReply).not.toHaveBeenCalled()

    const confirmed = fakeDb({ ai_configs: [{ account_id: 'acct-1', data_notice_ack_at: '2026-09-01T00:00:00Z' }] })
    expect(await checkAiAvailability(confirmed.db, 'acct-1')).toMatchObject({ ok: true })
  })

  it('a routed connection is checked on its own notice flag', async () => {
    mocks.loadAiConfig.mockResolvedValue(cfg({ provider: 'openai_compatible', connectionId: 'conn-1' }))
    const db = fakeDb({
      ai_connections: [{ id: 'conn-1', account_id: 'acct-1', data_notice_ack_at: '2026-09-01T00:00:00Z' }],
      ai_configs: [{ account_id: 'acct-1', data_notice_ack_at: null }],
    }).db
    expect(await checkAiAvailability(db, 'acct-1')).toMatchObject({ ok: true })
  })
})
