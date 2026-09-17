import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findOrCreateContactByExternalId } from './contact-identity'

interface Script {
  existing?: Record<string, unknown> | null
  insertedContact?: Record<string, unknown> | null
  insertError?: { code?: string } | null
  racedContact?: Record<string, unknown> | null
}

function stubClient(script: Script) {
  let maybeSingleCalls = 0
  const inserts: Record<string, unknown>[] = []

  const client = {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        ilike: () => builder,
        maybeSingle: async () => {
          maybeSingleCalls++
          if (maybeSingleCalls === 1) return { data: script.existing ?? null, error: null }
          // Second maybeSingle is the post-race re-lookup.
          return { data: script.racedContact ?? null, error: null }
        },
        insert: (payload: Record<string, unknown>) => {
          inserts.push(payload)
          return builder
        },
        single: async () => {
          if (script.insertError) return { data: null, error: script.insertError }
          return { data: script.insertedContact ?? { id: 'ct-new' }, error: null }
        },
      }
      return builder
    },
  }

  return { client: client as unknown as SupabaseClient, inserts }
}

describe('findOrCreateContactByExternalId', () => {
  it('returns an existing contact without calling resolveDisplayName', async () => {
    const { client, inserts } = stubClient({ existing: { id: 'ct-1', messenger_psid: 'psid-1' } })
    const resolveDisplayName = vi.fn(async () => 'should not be called')

    const result = await findOrCreateContactByExternalId(client, {
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      column: 'messenger_psid',
      externalId: 'psid-1',
      resolveDisplayName,
    })

    expect(result).toEqual({ contact: { id: 'ct-1', messenger_psid: 'psid-1' }, wasCreated: false })
    expect(resolveDisplayName).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(0)
  })

  it('creates a new contact with an empty phone and the resolved display name', async () => {
    const { client, inserts } = stubClient({
      existing: null,
      insertedContact: { id: 'ct-new', messenger_psid: 'psid-1', name: 'Jane', phone: '' },
    })

    const result = await findOrCreateContactByExternalId(client, {
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      column: 'messenger_psid',
      externalId: 'psid-1',
      resolveDisplayName: async () => 'Jane',
    })

    expect(result).toEqual({
      contact: { id: 'ct-new', messenger_psid: 'psid-1', name: 'Jane', phone: '' },
      wasCreated: true,
    })
    expect(inserts).toEqual([
      {
        account_id: 'acct-1',
        user_id: 'user-1',
        phone: '',
        name: 'Jane',
        messenger_psid: 'psid-1',
      },
    ])
  })

  it('resolves the raced contact on a unique-violation instead of throwing', async () => {
    const { client } = stubClient({
      existing: null,
      insertError: { code: '23505' },
      racedContact: { id: 'ct-raced', messenger_psid: 'psid-1' },
    })

    const result = await findOrCreateContactByExternalId(client, {
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      column: 'messenger_psid',
      externalId: 'psid-1',
      resolveDisplayName: async () => 'Jane',
    })

    expect(result).toEqual({ contact: { id: 'ct-raced', messenger_psid: 'psid-1' }, wasCreated: false })
  })

  it('matches an existing email case-insensitively via ilike, not eq', async () => {
    const ilikeSpy = vi.fn()
    const eqSpy = vi.fn()
    const client = {
      from() {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (...args: unknown[]) => {
            eqSpy(...args)
            return builder
          },
          ilike: (...args: unknown[]) => {
            ilikeSpy(...args)
            return builder
          },
          maybeSingle: async () => ({ data: { id: 'ct-1', email: 'Jane@Example.com' }, error: null }),
        }
        return builder
      },
    } as unknown as SupabaseClient

    const result = await findOrCreateContactByExternalId(client, {
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      column: 'email',
      externalId: 'jane@example.com',
      resolveDisplayName: async () => 'should not be called',
    })

    expect(result).toEqual({ contact: { id: 'ct-1', email: 'Jane@Example.com' }, wasCreated: false })
    expect(ilikeSpy).toHaveBeenCalledWith('email', 'jane@example.com')
    // account_id still goes through eq — only the identity column switches.
    expect(eqSpy).toHaveBeenCalledWith('account_id', 'acct-1')
  })
})
