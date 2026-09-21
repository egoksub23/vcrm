import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeDb } from '@/lib/comments/fake-db'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => {
    if (s === 'BAD') throw new Error('bad ciphertext')
    return `dec:${s}`
  },
}))

import { loadAiConfig } from './config'
import { fillRouting } from './connections'
import { budgetState, ensureWithinBudget, sendBudgetAlert, monthKey } from './budget'
import { AiError } from './types'

const ACCT = 'acct-1'

const baseConfig = {
  account_id: ACCT, provider: 'openai', base_url: null, model: 'gpt-default', api_key: 'enc-default',
  system_prompt: 'ctx', is_active: true, auto_reply_enabled: false, auto_reply_max_per_conversation: 3,
  handoff_agent_id: null, embeddings_api_key: null, embeddings_base_url: null, embeddings_model: null,
  monthly_token_budget: 1000,
}
const conn = { id: 'conn-1', account_id: ACCT, provider: 'openai_compatible', base_url: 'https://api.moonshot.ai/v1', model: 'kimi-fast', api_key: 'enc-kimi' }

const seed = (routing: Record<string, unknown>[] = [], connections: Record<string, unknown>[] = [conn], cfg = baseConfig) =>
  makeFakeDb({ ai_configs: [cfg], ai_connections: connections, ai_task_routing: routing })

describe('loadAiConfig with a task', () => {
  it('uses the default connection when the job has no routing row', async () => {
    const f = seed()
    const c = await loadAiConfig(f.db, ACCT, { task: 'draft' })
    expect(c).toMatchObject({ provider: 'openai', model: 'gpt-default', apiKey: 'dec:enc-default', connectionId: null, monthlyTokenBudget: 1000 })
  })

  it('behaves exactly as before when no task is given', async () => {
    const f = seed([{ account_id: ACCT, task: 'draft', connection_id: 'conn-1', enabled: true }])
    expect((await loadAiConfig(f.db, ACCT))?.provider).toBe('openai')
  })

  it('routes a job to another connection, with its host, key and model', async () => {
    const f = seed([{ account_id: ACCT, task: 'auto_label', connection_id: 'conn-1', model_override: null, enabled: true }])
    const c = await loadAiConfig(f.db, ACCT, { task: 'auto_label' })
    expect(c).toMatchObject({ provider: 'openai_compatible', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-fast', apiKey: 'dec:enc-kimi', connectionId: 'conn-1' })
    // Shared settings still come from the account.
    expect(c?.systemPrompt).toBe('ctx')
  })

  it('applies a model override on a routed connection', async () => {
    const f = seed([{ account_id: ACCT, task: 'summary', connection_id: 'conn-1', model_override: 'kimi-big', enabled: true }])
    expect((await loadAiConfig(f.db, ACCT, { task: 'summary' }))?.model).toBe('kimi-big')
  })

  it('applies a model override on the default connection', async () => {
    const f = seed([{ account_id: ACCT, task: 'draft', connection_id: null, model_override: 'gpt-careful', enabled: true }])
    const c = await loadAiConfig(f.db, ACCT, { task: 'draft' })
    expect(c).toMatchObject({ model: 'gpt-careful', provider: 'openai', connectionId: null })
  })

  it('returns null for a job that is switched off, and leaves the others alone', async () => {
    const f = seed([{ account_id: ACCT, task: 'summary', connection_id: null, enabled: false }])
    expect(await loadAiConfig(f.db, ACCT, { task: 'summary' })).toBeNull()
    expect(await loadAiConfig(f.db, ACCT, { task: 'draft' })).not.toBeNull()
  })

  it('falls back to the default when the routed connection is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = seed([{ account_id: ACCT, task: 'draft', connection_id: 'missing', enabled: true }])
    expect((await loadAiConfig(f.db, ACCT, { task: 'draft' }))?.connectionId).toBeNull()
    warn.mockRestore()
  })

  it('falls back to the default when the routed key cannot be decrypted', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = seed([{ account_id: ACCT, task: 'draft', connection_id: 'conn-1', enabled: true }], [{ ...conn, api_key: 'BAD' }])
    expect((await loadAiConfig(f.db, ACCT, { task: 'draft' }))?.provider).toBe('openai')
    err.mockRestore()
  })

  it('does not leak another accounts connection', async () => {
    const f = seed([{ account_id: ACCT, task: 'draft', connection_id: 'conn-1', enabled: true }], [{ ...conn, account_id: 'other' }])
    expect((await loadAiConfig(f.db, ACCT, { task: 'draft' }))?.connectionId).toBeNull()
  })
})

describe('fillRouting', () => {
  it('returns every job, defaulting the ones with no row', () => {
    const r = fillRouting([{ task: 'summary', connection_id: 'c', model_override: 'm', enabled: false }])
    expect(r.map((x) => x.task)).toEqual(['draft', 'auto_reply', 'auto_label', 'closing_note', 'summary', 'translate', 'automation'])
    expect(r.find((x) => x.task === 'summary')).toEqual({ task: 'summary', connectionId: 'c', modelOverride: 'm', enabled: false })
    expect(r.find((x) => x.task === 'draft')).toEqual({ task: 'draft', connectionId: null, modelOverride: null, enabled: true })
  })
})

describe('budgetState', () => {
  it('has no limit without a budget', () => {
    expect(budgetState(5000, null)).toEqual({ budget: null, used: 5000, fraction: null, warn: false, exceeded: false })
    expect(budgetState(5000, 0).budget).toBeNull()
  })
  it('warns from 80% and stops at 100%', () => {
    expect(budgetState(799, 1000)).toMatchObject({ warn: false, exceeded: false })
    expect(budgetState(800, 1000)).toMatchObject({ warn: true, exceeded: false })
    expect(budgetState(999, 1000)).toMatchObject({ warn: true, exceeded: false })
    expect(budgetState(1000, 1000)).toMatchObject({ warn: true, exceeded: true })
    expect(budgetState(1500, 1000).exceeded).toBe(true)
  })
})

/** A db whose usage RPC returns a fixed number, on top of the fake tables. */
function dbWithUsage(used: number | 'error', tables: Parameters<typeof makeFakeDb>[0] = {}) {
  const f = makeFakeDb({ ai_configs: [{ account_id: ACCT, budget_alert_month: null }], ...tables })
  const rpc = vi.fn(async () => (used === 'error' ? { data: null, error: { message: 'boom' } } : { data: used, error: null }))
  return { ...f, db: { from: f.db.from.bind(f.db), rpc } as unknown as SupabaseClient, rpc }
}

describe('ensureWithinBudget', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('does nothing without a budget (and never queries usage)', async () => {
    const f = dbWithUsage(999999)
    await ensureWithinBudget(f.db, ACCT, { monthlyTokenBudget: null })
    expect(f.rpc).not.toHaveBeenCalled()
  })

  it('lets a call through under the budget', async () => {
    const f = dbWithUsage(100)
    await expect(ensureWithinBudget(f.db, ACCT, { monthlyTokenBudget: 1000 })).resolves.toBeUndefined()
    expect(f.rpc).toHaveBeenCalledWith('ai_tokens_this_month', { p_account_id: ACCT })
  })

  it('throws a typed budget_exceeded error at the limit', async () => {
    const f = dbWithUsage(1000)
    await expect(ensureWithinBudget(f.db, ACCT, { monthlyTokenBudget: 1000 })).rejects.toMatchObject({
      name: 'AiError',
      code: 'budget_exceeded',
      status: 429,
    })
    await expect(ensureWithinBudget(f.db, ACCT, { monthlyTokenBudget: 1000 })).rejects.toBeInstanceOf(AiError)
  })

  it('goes ahead when the usage lookup itself fails', async () => {
    const f = dbWithUsage('error')
    await expect(ensureWithinBudget(f.db, ACCT, { monthlyTokenBudget: 1000 })).resolves.toBeUndefined()
  })
})

describe('sendBudgetAlert', () => {
  const admins = [
    { user_id: 'u1', account_id: ACCT, account_role: 'owner' },
    { user_id: 'u2', account_id: ACCT, account_role: 'admin' },
    { user_id: 'u3', account_id: ACCT, account_role: 'agent' },
  ]

  it('notifies each admin once at 80% and never again the same month', async () => {
    const f = dbWithUsage(800, { profiles: admins })
    await ensureWithinBudget(f.db, ACCT, { monthlyTokenBudget: 1000 })
    await new Promise((r) => setTimeout(r, 0))
    expect(f.tables.notifications).toHaveLength(2)
    expect(f.tables.notifications[0]).toMatchObject({ type: 'ai_budget', title: 'AI budget at 80%' })
    expect(f.tables.ai_configs[0].budget_alert_month).toBe(monthKey())

    await ensureWithinBudget(f.db, ACCT, { monthlyTokenBudget: 1000 })
    await new Promise((r) => setTimeout(r, 0))
    expect(f.tables.notifications).toHaveLength(2)
  })

  it('says so when the budget is used up', async () => {
    const f = dbWithUsage(1200, { profiles: admins })
    await sendBudgetAlert(f.db, ACCT, budgetState(1200, 1000))
    expect(f.tables.notifications[0]).toMatchObject({ title: 'AI budget used up' })
    expect(String(f.tables.notifications[0].body)).toContain('paused')
  })
})
