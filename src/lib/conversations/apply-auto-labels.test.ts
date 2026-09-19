import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  addLabel: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  logAiUsage: vi.fn(),
}))

vi.mock('./label-events', () => ({ addConversationLabelAndDispatch: h.addLabel }))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: h.logAiUsage }))

import { applyAutoLabels } from './auto-label'

interface Fixture {
  rules?: unknown[]
  aiEnabled?: boolean
  existingLabels?: number
}

function fakeDb(f: Fixture): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      const chain = () => b
      Object.assign(b, {
        select: chain,
        eq: chain,
        maybeSingle: () =>
          Promise.resolve({ data: { auto_label_ai_enabled: f.aiEnabled ?? false }, error: null }),
        then: (resolve: (r: unknown) => unknown) =>
          resolve(
            table === 'auto_label_rules'
              ? { data: f.rules ?? [], error: null }
              : { data: null, count: f.existingLabels ?? 0, error: null },
          ),
      })
      return b
    },
  } as unknown as SupabaseClient
}

const ARGS = { accountId: 'acct', conversationId: 'conv' }
const billingRule = {
  id: 'r1', tag_id: 'billing', keywords: ['refund'], match_type: 'word',
  description: 'Payments and refunds', tags: { name: 'Billing' },
}
const techRule = {
  id: 'r2', tag_id: 'tech', keywords: [], match_type: 'word',
  description: 'Bugs and outages', tags: [{ name: 'Technical' }],
}

beforeEach(() => {
  h.addLabel.mockReset().mockResolvedValue({ added: true, dispatched: true })
  h.loadAiConfig.mockReset().mockResolvedValue({ provider: 'openai', model: 'm', apiKey: 'k' })
  h.generateReply.mockReset()
  h.logAiUsage.mockReset()
})

describe('applyAutoLabels', () => {
  it('applies the label of a matching keyword rule and never calls the AI', async () => {
    const res = await applyAutoLabels({
      ...ARGS, db: fakeDb({ rules: [billingRule, techRule], aiEnabled: true }),
      text: 'I would like a refund please',
    })
    expect(res).toEqual({ applied: ['billing'], via: 'keywords' })
    expect(h.addLabel).toHaveBeenCalledWith(expect.objectContaining({ tagId: 'billing', conversationId: 'conv' }))
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('does nothing when there are no rules', async () => {
    const res = await applyAutoLabels({ ...ARGS, db: fakeDb({ rules: [] }), text: 'anything at all here' })
    expect(res).toEqual({ applied: [], via: null })
    expect(h.addLabel).not.toHaveBeenCalled()
  })

  it('skips the AI pass unless the account opted in, the text is long enough, and the conversation is unlabeled', async () => {
    const text = 'the app keeps freezing on startup'
    for (const fx of [
      { aiEnabled: false },
      { aiEnabled: true, existingLabels: 1 },
    ]) {
      const res = await applyAutoLabels({ ...ARGS, db: fakeDb({ rules: [techRule], ...fx }), text })
      expect(res.applied).toEqual([])
    }
    const short = await applyAutoLabels({ ...ARGS, db: fakeDb({ rules: [techRule], aiEnabled: true }), text: 'help me' })
    expect(short.applied).toEqual([])
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('labels via the AI when no keyword matched, and logs the spend', async () => {
    h.generateReply.mockResolvedValue({ text: 'Technical', handoff: false, usage: { totalTokens: 9 } })
    const res = await applyAutoLabels({
      ...ARGS, db: fakeDb({ rules: [billingRule, techRule], aiEnabled: true }),
      text: 'the app keeps freezing on startup',
    })
    expect(res).toEqual({ applied: ['tech'], via: 'ai' })
    expect(h.logAiUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: 'auto_label', conversationId: 'conv' }))
  })

  it('does not apply a label the model invented or NONE', async () => {
    for (const out of ['Shipping', 'NONE']) {
      h.generateReply.mockResolvedValue({ text: out, handoff: false, usage: null })
      const res = await applyAutoLabels({
        ...ARGS, db: fakeDb({ rules: [techRule], aiEnabled: true }),
        text: 'the app keeps freezing on startup',
      })
      expect(res.applied).toEqual([])
    }
  })

  it('never throws — an AI failure just means no label', async () => {
    h.generateReply.mockRejectedValue(new Error('provider down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      applyAutoLabels({ ...ARGS, db: fakeDb({ rules: [techRule], aiEnabled: true }), text: 'the app keeps freezing on startup' }),
    ).resolves.toEqual({ applied: [], via: null })
    spy.mockRestore()
  })
})
