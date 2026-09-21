import { describe, it, expect, vi } from 'vitest'
import { logAiUsage } from './usage'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const db = { from: vi.fn(() => ({ insert })) }
  return { db: db as unknown as SupabaseClient, insert, from: db.from }
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const { db, insert, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    expect(from).toHaveBeenCalledWith('ai_usage_log')
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      connection_id: null,
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
    })
  })

  it('stores prompt-cache numbers when there are any', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 5000, completionTokens: 10, totalTokens: 5010, cacheReadTokens: 4000 },
    })
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({
      total_tokens: 5010,
      cache_read_tokens: 4000,
      cache_write_tokens: 0,
    })
  })

  it('does not send the cache columns when nothing was cached', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 1 },
    })
    expect(insert.mock.calls[0][0]).not.toHaveProperty('cache_read_tokens')
  })

  it('logs the row without the cache columns when the database does not have them yet', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: 'column "cache_read_tokens" does not exist' } })
      .mockResolvedValueOnce({ error: null })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 5000, completionTokens: 10, totalTokens: 5010, cacheReadTokens: 4000 },
    })
    expect(insert).toHaveBeenCalledTimes(2)
    expect(insert.mock.calls[1][0]).not.toHaveProperty('cache_read_tokens')
    expect(insert.mock.calls[1][0]).toMatchObject({ total_tokens: 5010 })
  })

  it('is a no-op when the provider reported no usage', async () => {
    const { db, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('never throws when the insert errors', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
  })
})
