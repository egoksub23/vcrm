import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findOrCreateConversation } from './find-or-create'

/**
 * Extracted verbatim from the WhatsApp webhook route (migration 055's
 * prep work) so the Messenger/Instagram webhook routes can share it —
 * this covers the extracted unit directly rather than relying only on
 * the WhatsApp webhook's own tests to exercise it indirectly.
 */

interface Script {
  existingRows?: unknown[]
  insertedConversation?: Record<string, unknown> | null
  insertError?: { code?: string } | null
  racedRow?: Record<string, unknown> | null
}

function stubClient(script: Script) {
  let selectCalls = 0
  const inserts: Record<string, unknown>[] = []

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => {
          selectCalls++
          // First select() is the initial lookup; a second (post-race)
          // lookup returns the raced winner.
          const rows =
            selectCalls === 1 ? (script.existingRows ?? []) : [script.racedRow].filter(Boolean)
          return Promise.resolve({ data: rows, error: null })
        },
        insert: (payload: Record<string, unknown>) => {
          inserts.push(payload)
          return builder
        },
        select_after_insert: undefined,
        single: async () => {
          if (script.insertError) return { data: null, error: script.insertError }
          return { data: script.insertedConversation ?? { id: 'conv-new' }, error: null }
        },
      }
      return builder
    },
  }

  return { client: client as unknown as SupabaseClient, inserts }
}

describe('findOrCreateConversation', () => {
  it('returns the existing conversation without inserting', async () => {
    const { client, inserts } = stubClient({
      existingRows: [{ id: 'conv-1', account_id: 'acct-1', contact_id: 'ct-1' }],
    })

    const result = await findOrCreateConversation(client, 'acct-1', 'user-1', 'ct-1')

    expect(result).toEqual({
      conversation: { id: 'conv-1', account_id: 'acct-1', contact_id: 'ct-1' },
      created: false,
    })
    expect(inserts).toHaveLength(0)
  })

  it('creates a new conversation when none exists', async () => {
    const { client, inserts } = stubClient({
      existingRows: [],
      insertedConversation: { id: 'conv-new', account_id: 'acct-1', contact_id: 'ct-1' },
    })

    const result = await findOrCreateConversation(client, 'acct-1', 'user-1', 'ct-1')

    expect(result).toEqual({
      conversation: { id: 'conv-new', account_id: 'acct-1', contact_id: 'ct-1' },
      created: true,
    })
    expect(inserts).toEqual([{ account_id: 'acct-1', user_id: 'user-1', contact_id: 'ct-1' }])
  })

  it('resolves the raced conversation on a unique-violation instead of throwing', async () => {
    const { client } = stubClient({
      existingRows: [],
      insertError: { code: '23505' },
      racedRow: { id: 'conv-raced', account_id: 'acct-1', contact_id: 'ct-1' },
    })

    const result = await findOrCreateConversation(client, 'acct-1', 'user-1', 'ct-1')

    expect(result).toEqual({
      conversation: { id: 'conv-raced', account_id: 'acct-1', contact_id: 'ct-1' },
      created: false,
    })
  })
})
