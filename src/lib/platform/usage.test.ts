import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  __resetUsageCacheForTests,
  aiAllowance,
  assertCanAddContact,
  assertCanSendDocument,
  assertCanSendMessage,
  loadAccountUsage,
  usageMeters,
  usageState,
  UsageLimitError,
  worstState,
  type AccountUsage,
} from './usage'

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  contacts: 10,
  members: 2,
  conversations: 5,
  messages_month: 100,
  ai_tokens_month: 1000,
  storage_bytes: 5 * 1024 * 1024,
  storage_measured_at: null,
  limits: {},
  ...over,
})

/** A client whose account_usage() answers `data`, and which counts the calls. */
function fakeDb(data: unknown, calls = { n: 0 }): SupabaseClient {
  return {
    rpc: async () => {
      calls.n++
      return { data, error: null }
    },
  } as unknown as SupabaseClient
}

beforeEach(() => __resetUsageCacheForTests())

describe('usageState', () => {
  it('is ok with no limit, warn from 80%, over at 100%', () => {
    expect(usageState(1_000_000, null)).toBe('ok')
    expect(usageState(79, 100)).toBe('ok')
    expect(usageState(80, 100)).toBe('warn')
    expect(usageState(99, 100)).toBe('warn')
    expect(usageState(100, 100)).toBe('over')
    expect(usageState(150, 100)).toBe('over')
  })
})

describe('usageMeters', () => {
  it('reads every meter against its own limit; unlimited meters have no fraction', () => {
    const meters = usageMeters(usage({ limits: { contacts: 12, messages_per_month: 100, storage_mb: 10 } }))
    const by = Object.fromEntries(meters.map((m) => [m.key, m]))
    expect(by.contacts).toMatchObject({ used: 10, limit: 12, state: 'warn' })
    expect(by.messages_per_month).toMatchObject({ used: 100, limit: 100, state: 'over' })
    expect(by.storage_mb).toMatchObject({ used: 5, limit: 10, state: 'ok' })
    expect(by.ai_tokens_per_month).toMatchObject({ limit: null, fraction: null, state: 'ok' })
    expect(by.seats).toMatchObject({ used: 2, limit: null })
    expect(worstState(meters)).toBe('over')
  })

  it('ignores a zero or malformed limit (reads as unlimited)', () => {
    const meters = usageMeters(usage({ limits: { contacts: 0, seats: Number.NaN } as never }))
    expect(meters.every((m) => m.limit === null)).toBe(true)
    expect(worstState(meters)).toBe('ok')
  })

  it('is empty without a reading', () => {
    expect(usageMeters(null)).toEqual([])
  })

  it('shows the Secure Sign meter only for a workspace that has a limit on it or has sent something', () => {
    const keys = (u: AccountUsage) => usageMeters(u).map((m) => m.key)
    expect(keys(usage())).not.toContain('sign_documents_per_month')
    expect(keys(usage({ sign_documents_month: 0 }))).not.toContain('sign_documents_per_month')
    expect(keys(usage({ sign_documents_month: 3 }))).toContain('sign_documents_per_month')
    expect(keys(usage({ limits: { sign_documents_per_month: 50 } }))).toContain('sign_documents_per_month')
    const by = Object.fromEntries(usageMeters(usage({ sign_documents_month: 45, limits: { sign_documents_per_month: 50 } })).map((m) => [m.key, m]))
    expect(by.sign_documents_per_month).toMatchObject({ used: 45, limit: 50, state: 'warn' })
  })
})

describe('loadAccountUsage', () => {
  it('caches for a minute and then reads again', async () => {
    const calls = { n: 0 }
    const db = fakeDb(usage(), calls)
    let now = 1_000
    await loadAccountUsage(db, 'a', () => now)
    await loadAccountUsage(db, 'a', () => (now += 30_000))
    expect(calls.n).toBe(1)
    await loadAccountUsage(db, 'a', () => (now += 40_000))
    expect(calls.n).toBe(2)
  })

  it('fails open: null when the call errors or throws', async () => {
    const erroring = { rpc: async () => ({ data: null, error: { message: 'boom' } }) } as unknown as SupabaseClient
    const throwing = { rpc: async () => { throw new Error('down') } } as unknown as SupabaseClient
    expect(await loadAccountUsage(erroring, 'a')).toBeNull()
    expect(await loadAccountUsage(throwing, 'b')).toBeNull()
  })
})

describe('assertCanSendMessage', () => {
  it('lets a send through under the limit, with no limit, or when usage cannot be read', async () => {
    await expect(assertCanSendMessage(fakeDb(usage({ limits: { messages_per_month: 101 } })), 'a')).resolves.toBeUndefined()
    await expect(assertCanSendMessage(fakeDb(usage()), 'b')).resolves.toBeUndefined()
    const down = { rpc: async () => { throw new Error('down') } } as unknown as SupabaseClient
    await expect(assertCanSendMessage(down, 'c')).resolves.toBeUndefined()
  })

  it('refuses at the limit with a typed error', async () => {
    const err = await assertCanSendMessage(fakeDb(usage({ limits: { messages_per_month: 100 } })), 'a').catch((e) => e)
    expect(err).toBeInstanceOf(UsageLimitError)
    expect(err).toMatchObject({ code: 'message_limit_reached', status: 429 })
  })
})

describe('assertCanSendDocument', () => {
  it('lets a send through under the limit, with no limit, or when usage cannot be read', async () => {
    await expect(assertCanSendDocument(fakeDb(usage({ sign_documents_month: 49, limits: { sign_documents_per_month: 50 } })), 'a')).resolves.toBeUndefined()
    await expect(assertCanSendDocument(fakeDb(usage({ sign_documents_month: 900 })), 'b')).resolves.toBeUndefined()
    const down = { rpc: async () => { throw new Error('down') } } as unknown as SupabaseClient
    await expect(assertCanSendDocument(down, 'c')).resolves.toBeUndefined()
  })

  it('refuses at the limit with a typed error, and reads the count fresh each time', async () => {
    const calls = { n: 0 }
    const db = fakeDb(usage({ sign_documents_month: 50, limits: { sign_documents_per_month: 50 } }), calls)
    const err = await assertCanSendDocument(db, 'a').catch((e) => e)
    expect(err).toBeInstanceOf(UsageLimitError)
    expect(err).toMatchObject({ code: 'sign_limit_reached', status: 429 })
    await assertCanSendDocument(db, 'a').catch(() => undefined)
    expect(calls.n).toBe(2)
  })
})

describe('aiAllowance', () => {
  it('is null without a limit and carries limit and use with one', async () => {
    expect(await aiAllowance(fakeDb(usage()), 'a')).toBeNull()
    expect(await aiAllowance(fakeDb(usage({ limits: { ai_tokens_per_month: 5000 } })), 'b')).toEqual({ limit: 5000, used: 1000 })
  })
})

describe('assertCanAddContact', () => {
  /** account_platform.limits for the first lookup, then the contacts head count. */
  function contactsDb(limits: Record<string, number> | null, count: number): SupabaseClient {
    const platform = { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: limits ? { limits } : null }) }) }) }
    const contacts = { select: () => ({ eq: () => ({ is: async () => ({ count }) }) }) }
    return { from: (t: string) => (t === 'account_platform' ? platform : contacts) } as unknown as SupabaseClient
  }

  it('allows with no limit and under the limit; refuses at it', async () => {
    await expect(assertCanAddContact(contactsDb(null, 999), 'a')).resolves.toBeUndefined()
    await expect(assertCanAddContact(contactsDb({ contacts: 5 }, 4), 'a')).resolves.toBeUndefined()
    await expect(assertCanAddContact(contactsDb({ contacts: 5 }, 5), 'a')).rejects.toMatchObject({ code: 'contact_limit_reached' })
  })

  it('fails open when the lookup breaks', async () => {
    const broken = { from: () => { throw new Error('down') } } as unknown as SupabaseClient
    await expect(assertCanAddContact(broken, 'a')).resolves.toBeUndefined()
  })
})
