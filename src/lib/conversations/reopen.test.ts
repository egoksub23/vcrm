import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reopenClosedConversation } from './reopen'

/**
 * Regression cover for issue #409's "closed conversation lockout": an
 * inbound message bumped `unread_count` but never touched `status`, so a
 * closed thread accumulated unread customer messages while still reading
 * as resolved and staying out of the inbox's Open filter.
 *
 * Also covers the session-log write (migration 065): the reopen a
 * customer's message causes gets a `conversation_events` row, so the
 * chat's closed marker isn't followed by a silent, unexplained reopen.
 */

interface Recorded {
  table: string
  op: 'update' | 'insert' | null
  payload: Record<string, unknown> | null
  filters: [string, unknown][]
}

interface StubOptions {
  /** Error from the conversations UPDATE. */
  updateError?: { message: string } | null
  /** Rows the UPDATE reports as changed (`.select('id')`). */
  updatedRows?: { id: string }[]
  /** Error from the conversation_events INSERT. */
  insertError?: { message: string } | null
}

/** Chainable stub shaped like the bit of postgrest this touches. */
function stubClient(opts: StubOptions = {}) {
  const { updateError = null, updatedRows = [{ id: 'conv-1' }], insertError = null } = opts
  const calls: Recorded[] = []

  const client = {
    from(table: string) {
      const rec: Recorded = { table, op: null, payload: null, filters: [] }
      calls.push(rec)
      const builder = {
        update(payload: Record<string, unknown>) {
          rec.op = 'update'
          rec.payload = payload
          return builder
        },
        insert(payload: Record<string, unknown>) {
          rec.op = 'insert'
          rec.payload = payload
          return builder
        },
        select() {
          return builder
        },
        eq(column: string, value: unknown) {
          rec.filters.push([column, value])
          return builder
        },
        then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown) {
          const result =
            rec.op === 'insert'
              ? { data: null, error: insertError }
              : { data: updateError ? null : updatedRows, error: updateError }
          return Promise.resolve(result).then(onFulfilled)
        },
      }
      return builder
    },
  }

  return { client: client as unknown as SupabaseClient, calls }
}

describe('reopenClosedConversation', () => {
  it('flips a closed conversation back to open', async () => {
    const { client, calls } = stubClient()

    const reopened = await reopenClosedConversation(client, {
      id: 'conv-1',
      status: 'closed',
    })

    expect(reopened).toBe(true)
    expect(calls[0].table).toBe('conversations')
    // closed_at (migration 050) must clear on reopen, or a later
    // re-close would inherit this close's stale timestamp.
    expect(calls[0].payload).toMatchObject({ status: 'open', closed_at: null })
    expect(calls[0].payload).toHaveProperty('updated_at')
  })

  it('logs a customer-caused reopen to the session log', async () => {
    const { client, calls } = stubClient()

    await reopenClosedConversation(client, { id: 'conv-1', status: 'closed' })

    expect(calls).toHaveLength(2)
    expect(calls[1].table).toBe('conversation_events')
    expect(calls[1].op).toBe('insert')
    expect(calls[1].payload).toEqual({
      conversation_id: 'conv-1',
      event_type: 'reopened',
      actor_user_id: null,
      metadata: { reason: 'customer_message' },
    })
  })

  it('guards the write on the row still being closed', async () => {
    // The caller read the row earlier in the request. Without this filter,
    // two concurrent inbound deliveries both holding a stale
    // `status: 'closed'` could write 'open' over an agent's re-close.
    const { client, calls } = stubClient()

    await reopenClosedConversation(client, { id: 'conv-1', status: 'closed' })

    expect(calls[0].filters).toEqual([
      ['id', 'conv-1'],
      ['status', 'closed'],
    ])
  })

  it('does not log when a concurrent delivery already reopened the row', async () => {
    // The guarded UPDATE matched nothing, so this call didn't reopen
    // anything — the delivery that did is the one that logs it.
    const { client, calls } = stubClient({ updatedRows: [] })

    const reopened = await reopenClosedConversation(client, { id: 'conv-1', status: 'closed' })

    expect(reopened).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('still reports the reopen when only the log write fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = stubClient({ insertError: { message: 'boom' } })

    await expect(
      reopenClosedConversation(client, { id: 'conv-1', status: 'closed' }),
    ).resolves.toBe(true)

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it.each(['open', 'pending'])(
    'issues no query for a %s conversation',
    async (status) => {
      const { client, calls } = stubClient()

      const reopened = await reopenClosedConversation(client, {
        id: 'conv-1',
        status,
      })

      expect(reopened).toBe(false)
      expect(calls).toEqual([])
    },
  )

  it('issues no query when status is missing', async () => {
    const { client, calls } = stubClient()

    expect(await reopenClosedConversation(client, { id: 'conv-1' })).toBe(false)
    expect(calls).toEqual([])
  })

  it('swallows a failed update so inbound processing continues, and logs nothing', async () => {
    // Throwing here would abort the webhook and make Meta redeliver the
    // message — a worse outcome than a thread that stays closed.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, calls } = stubClient({ updateError: { message: 'permission denied' } })

    await expect(
      reopenClosedConversation(client, { id: 'conv-1', status: 'closed' }),
    ).resolves.toBe(false)

    expect(spy).toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    spy.mockRestore()
  })
})
