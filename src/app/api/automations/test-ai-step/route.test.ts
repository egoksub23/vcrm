import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  assertCapability: vi.fn(),
  checkRateLimit: vi.fn(),
  ai: null as unknown,
  admin: null as unknown,
}))

vi.mock('@/lib/auth/account', () => ({
  requireCapability: mocks.requireCapability,
  assertCapability: mocks.assertCapability,
  toErrorResponse: (e: { message?: string; status?: number }) =>
    Response.json({ error: e.message ?? 'error' }, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: () => Response.json({ error: 'Rate limit exceeded' }, { status: 429 }),
  RATE_LIMITS: { aiDraft: { limit: 20, windowMs: 60_000 }, aiDraftAccount: { limit: 60, windowMs: 60_000 } },
}))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => (mocks.admin as { db: unknown }).db }))
vi.mock('@/lib/automations/ai/caller', () => ({ createAiCaller: () => mocks.ai }))
vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: vi.fn(async () => [{ role: 'user', content: 'I want my money back' }]),
  getPreferredLanguage: vi.fn(async () => null),
}))
vi.mock('@/lib/ai/knowledge', () => ({ searchKnowledge: vi.fn(async () => []) }))

import { AiStepError } from '@/lib/automations/ai/types'
import { fakeAi, fakeDb, type FakeDb } from '@/lib/automations/ai/test-helpers'
import { POST } from './route'

class Forbidden extends Error {
  readonly status = 403
}

const CONV = { id: 'conv-1', account_id: 'acct-1', contact_id: 'c1', status: 'open', assigned_agent_id: null, ai_autoreply_disabled: false }

function userClient(visible = true) {
  return { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: visible ? CONV : null }) }) }) }) }) }
}

function grant(caps: string[], visible = true) {
  mocks.requireCapability.mockImplementation(async (cap: string) => {
    if (!caps.includes(cap)) throw new Forbidden(`This action requires the '${cap}' permission`)
    return { supabase: userClient(visible), accountId: 'acct-1', userId: 'u1', capabilities: new Set(caps) }
  })
  mocks.assertCapability.mockImplementation((ctx: { capabilities: Set<string> }, cap: string) => {
    if (!ctx.capabilities.has(cap)) throw new Forbidden(`This action requires the '${cap}' permission`)
  })
}

function post(body: unknown) {
  return POST(new Request('http://localhost/api/automations/test-ai-step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

const ask = { step_type: 'condition', step_config: { subject: 'ai_question', operand: 'Is the customer asking for a refund?' } }

let admin: FakeDb

beforeEach(() => {
  admin = fakeDb({
    conversations: [CONV],
    messages: [{ conversation_id: 'conv-1', sender_type: 'customer', is_internal: false, content_type: 'text', content_text: 'I want my money back' }],
    conversation_events: [{ conversation_id: 'conv-1', event_type: 'closed', note: 'Resolved by phone' }],
    tickets: [],
    contacts: [{ id: 'c1', account_id: 'acct-1', name: 'Casey' }],
  })
  mocks.admin = admin
  mocks.ai = fakeAi(['{"answer":"yes","reason":"asks for money back"}'])
  mocks.checkRateLimit.mockReturnValue({ success: true })
  grant(['automations.manage', 'ai.use'])
})

describe('capabilities: automations.manage AND ai.use', () => {
  it('asks for automations.manage, then ai.use', async () => {
    await post({ step: ask, conversation_id: 'conv-1' })
    expect(mocks.requireCapability).toHaveBeenCalledWith('automations.manage')
    expect(mocks.assertCapability).toHaveBeenCalledWith(expect.anything(), 'ai.use')
  })

  it('refuses someone who can build automations but may not use AI, before any model call', async () => {
    grant(['automations.manage'])
    const res = await post({ step: ask, conversation_id: 'conv-1' })
    expect(res.status).toBe(403)
    expect((mocks.ai as { calls: unknown[] }).calls).toHaveLength(0)
  })

  it('refuses someone who may use AI but not build automations', async () => {
    grant(['ai.use'])
    const res = await post({ step: ask, conversation_id: 'conv-1' })
    expect(res.status).toBe(403)
    expect((mocks.ai as { calls: unknown[] }).calls).toHaveLength(0)
  })
})

describe('limits and input checks', () => {
  it('is rate limited per user and per account', async () => {
    await post({ step: ask, conversation_id: 'conv-1' })
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('automation-ai-test:u1', expect.anything())
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('ai-draft-acct:acct-1', expect.anything())
    mocks.checkRateLimit.mockReturnValue({ success: false })
    const res = await post({ step: ask, conversation_id: 'conv-1' })
    expect(res.status).toBe(429)
  })

  it('only tests AI steps, Ask AI and Create ticket', async () => {
    for (const step of [{ step_type: 'send_message', step_config: { text: 'hi' } }, { step_type: 'condition', step_config: { subject: 'tag_presence', operand: 'x' } }, { step_type: 'nonsense', step_config: {} }]) {
      const res = await post({ step, conversation_id: 'conv-1' })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('not_testable')
    }
  })

  it('needs a conversation, and one the caller can see', async () => {
    expect((await post({ step: ask })).status).toBe(400)
    grant(['automations.manage', 'ai.use'], false)
    expect((await post({ step: ask, conversation_id: 'conv-1' })).status).toBe(404)
  })
})

describe('the dry run', () => {
  it('shows the outcome, the branch and the tokens used', async () => {
    const res = await post({ step: ask, conversation_id: 'conv-1' })
    expect(res.status).toBe(200)
    const { result } = await res.json()
    expect(result).toMatchObject({ outcome: 'yes', branch: 'yes', reason: 'asks for money back', tokens: 30, wouldDo: [] })
  })

  it('an AI reply reports the answer it WOULD send, and sends nothing', async () => {
    mocks.ai = fakeAi(['We can refund you within 5 days.'])
    // A business context exists (no knowledge): the AI may answer from it.
    ;(mocks.ai as { getConfig: () => Promise<unknown> }).getConfig = async () => ({ systemPrompt: 'We sell shoes.', provider: 'openai', model: 'm' })
    const res = await post({ step: { step_type: 'ai_reply', step_config: { mode: 'send' } }, conversation_id: 'conv-1' })
    const { result } = await res.json()
    expect(result.outcome).toBe('answered')
    expect(result.wouldDo).toEqual([{ kind: 'send_reply', text: 'We can refund you within 5 days.' }])
    expect(admin.writes).toEqual([])
  })

  it('never writes: not a send, an update, an insert or an RPC', async () => {
    for (const step of [
      { step_type: 'ai_summarize', step_config: { post_note: true } },
      { step_type: 'ai_translate', step_config: { target_language: 'ko' } },
      { step_type: 'ai_extract', step_config: { fields: [{ key: 'email', type: 'text', description: 'Email', target: { kind: 'contact_field', field: 'email' } }] } },
      { step_type: 'create_ticket', step_config: { subject: 'Follow-up', ai_write: true } },
    ]) {
      mocks.ai = fakeAi(['- ok', '알겠습니다', '{"email":"a@b.co"}', '{"subject":"S","description":"D"}'])
      await post({ step, conversation_id: 'conv-1' })
    }
    expect(admin.writes).toEqual([])
  })

  it('Create ticket previews the subject and description, without creating anything', async () => {
    mocks.ai = fakeAi(['{"subject":"Refund request","description":"The customer wants a refund."}'])
    const res = await post({ step: { step_type: 'create_ticket', step_config: { subject: 'Fallback', ai_write: true } }, conversation_id: 'conv-1' })
    const { result } = await res.json()
    expect(result.ticket).toMatchObject({ subject: 'Refund request', description: 'The customer wants a refund.', usedAi: true, skip: null })
    expect(result.wouldDo).toEqual([{ kind: 'create_ticket', text: 'Refund request', name: 'normal' }])
    expect(admin.writes).toEqual([])
  })

  it('takes sample values for earlier steps\' variables, and ignores the engine\'s own', async () => {
    const ai = fakeAi(['- ok'])
    mocks.ai = ai
    await post({
      step: { step_type: 'ai_translate', step_config: { source: '{{ vars.summary }}', target_language: 'ko' } },
      conversation_id: 'conv-1',
      vars: { summary: 'Hello there', _ai_steps: 99, 'Bad Key': 'x' },
    })
    expect(ai.calls[0].messages[0].content).toBe('Hello there')
  })

  it('uses the closure note for a conversation_closed flow', async () => {
    const ai = fakeAi(['- ok'])
    mocks.ai = ai
    await post({
      step: { step_type: 'ai_translate', step_config: { source: '{{ closure.note }}', target_language: 'ko' } },
      conversation_id: 'conv-1',
      trigger_type: 'conversation_closed',
    })
    expect(ai.calls[0].messages[0].content).toBe('Resolved by phone')
  })

  it('a step that cannot run says why (not configured, budget) as a result or a clear error, never a system prompt', async () => {
    mocks.ai = fakeAi([], { configError: new AiStepError('ai_not_configured', 'AI is not set up') })
    const res = await post({ step: ask, conversation_id: 'conv-1' })
    const body = await res.json()
    expect(body.result.failure.code).toBe('ai_not_configured')
    expect(JSON.stringify(body)).not.toMatch(/untrusted|Reply with JSON only/)

    mocks.ai = fakeAi([new AiStepError('budget_exceeded', 'AI budget used up')])
    const res2 = await post({ step: ask, conversation_id: 'conv-1' })
    expect((await res2.json()).result.failure.code).toBe('budget_exceeded')
  })

  it('the response never contains the prompt it sent', async () => {
    const res = await post({ step: ask, conversation_id: 'conv-1' })
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('Reply with JSON only')
    expect(text).not.toContain('untrusted')
  })
})
