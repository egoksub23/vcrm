import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from '@/lib/ai/types'
import {
  AiStepError,
  type AiCaller,
  type AiCallRequest,
  type AiCallResult,
  type AiStepRuntime,
} from './types'

// Test-only helpers: a fake AI client and a read-only fake database.

export type FakeReply = string | Error | { text: string; handoff?: boolean; tokens?: number }

export interface FakeAi extends AiCaller {
  calls: AiCallRequest[]
}

export const TEST_CONFIG: AiConfig = {
  provider: 'openai',
  model: 'test-model',
  apiKey: 'k',
  baseUrl: null,
  systemPrompt: 'We sell shoes.',
  isActive: true,
  autoReplyEnabled: false,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
  connectionId: null,
}

/** Answers the model calls in order. An Error in the list is thrown instead. */
export function fakeAi(replies: FakeReply[], opts: { configError?: AiStepError } = {}): FakeAi {
  const queue = [...replies]
  const calls: AiCallRequest[] = []
  return {
    calls,
    async getConfig() {
      if (opts.configError) throw opts.configError
      return TEST_CONFIG
    },
    async call(req): Promise<AiCallResult> {
      if (opts.configError) throw opts.configError
      calls.push(req)
      const next = queue.shift()
      if (next === undefined) throw new Error('fakeAi: no more replies queued')
      if (next instanceof Error) throw next
      const r = typeof next === 'string' ? { text: next } : next
      const tokens = 'tokens' in r && r.tokens !== undefined ? r.tokens : 30
      return {
        text: r.text,
        handoff: 'handoff' in r ? r.handoff : false,
        usage: { promptTokens: tokens - 5, completionTokens: 5, totalTokens: tokens },
        tokens,
        model: 'test-model',
        provider: 'openai',
      }
    },
  }
}

type Row = Record<string, unknown>

export interface FakeDb {
  db: SupabaseClient
  /** Every write the code under test attempted (there must be none in a dry run). */
  writes: string[]
}

/**
 * A read-only stand-in for supabase-js. Tables are arrays of rows; `.eq`, `.is`,
 * `.in`, `.neq`, `.order` and `.limit` are honoured; any write (`insert`,
 * `update`, `upsert`, `delete`, `rpc`) is RECORDED in `writes` and answered with
 * an error, so a test can assert that a dry run wrote nothing.
 */
export function fakeDb(tables: Record<string, Row[]>): FakeDb {
  const writes: string[] = []

  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    let limitN = Infinity
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limitN)
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), api),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), api),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), api),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), api),
      order: () => api,
      limit: (n: number) => ((limitN = n), api),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(ok, bad),
    }
    for (const w of ['insert', 'update', 'upsert', 'delete']) {
      api[w] = () => {
        writes.push(`${table}.${w}`)
        return {
          ...api,
          eq: () => api,
          select: () => api,
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'write refused' } }).then(ok),
        }
      }
    }
    return api
  }

  const db = {
    from: (t: string) => builder(t),
    rpc: async (name: string) => {
      writes.push(`rpc.${name}`)
      return { data: null, error: { message: 'write refused' } }
    },
  } as unknown as SupabaseClient
  return { db, writes }
}

export function runtime(over: Partial<AiStepRuntime> & Pick<AiStepRuntime, 'db' | 'ai'>): AiStepRuntime {
  return {
    accountId: 'acct-1',
    automation: { id: 'auto-1', name: 'Test automation' },
    conversationId: 'conv-1',
    contactId: 'contact-1',
    messageText: 'Hi, can I get a refund?',
    vars: {},
    dryRun: false,
    ...over,
  }
}
