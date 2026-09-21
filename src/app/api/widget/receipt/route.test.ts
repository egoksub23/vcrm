import { beforeEach, describe, expect, it, vi } from 'vitest'

const owned = vi.fn()
const calls: { method: string; args: unknown[] }[] = []
let updated: { id: string }[] = []

// Records the filter chain so the test can prove what the UPDATE is scoped to.
function messagesQuery() {
  const q: Record<string, unknown> = {}
  for (const m of ['update', 'eq', 'in', 'or']) {
    q[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return q
    }
  }
  q.select = async () => ({ data: updated, error: null })
  return q
}

vi.mock('@/lib/widget/visitor-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/visitor-auth')>('@/lib/widget/visitor-auth')
  return {
    ...actual,
    authenticateVisitorRequest: vi.fn(async () => ({
      ok: true,
      ctx: {
        admin: { from: () => messagesQuery() },
        visitorId: 'visitor-1',
        accountId: 'acc-1',
        contactId: 'contact-1',
        widgetConfigId: 'cfg-1',
        corsOrigin: 'https://site.example',
      },
    })),
    loadOwnedConversation: (...a: unknown[]) => owned(...a),
  }
})

import { POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'

function call(body: unknown) {
  return POST(
    new Request('https://crm.example/api/widget/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site.example', Authorization: 'Bearer x' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  calls.length = 0
  updated = [{ id: ID }]
  owned.mockReset()
  owned.mockResolvedValue({ id: 'conv-1', account_id: 'acc-1', contact_id: 'contact-1', status: 'open' })
})

const filter = (method: string, col: string) => calls.find((c) => c.method === method && c.args[0] === col)?.args

describe('POST /api/widget/receipt', () => {
  it('"read" upgrades only sent / delivered agent+bot web-widget messages of the visitor\'s conversation', async () => {
    const res = await call({ conversationId: 'conv-1', messageIds: [ID], status: 'read' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 1 })
    expect(calls.find((c) => c.method === 'update')?.args[0]).toEqual({ status: 'read' })
    expect(filter('eq', 'conversation_id')?.[1]).toBe('conv-1')
    expect(filter('in', 'id')?.[1]).toEqual([ID])
    expect(filter('in', 'sender_type')?.[1]).toEqual(['agent', 'bot'])
    expect(filter('eq', 'channel_type')?.[1]).toBe('web_widget')
    expect(filter('in', 'status')?.[1]).toEqual(['sent', 'delivered'])
    expect(calls.find((c) => c.method === 'or')?.args[0]).toContain('is_internal')
  })

  it('"delivered" only upgrades sent (a read message is never downgraded)', async () => {
    await call({ conversationId: 'conv-1', messageIds: [ID], status: 'delivered' })
    expect(filter('in', 'status')?.[1]).toEqual(['sent'])
  })

  it('404s on a conversation that is not the visitor\'s and updates nothing', async () => {
    owned.mockResolvedValue(null)
    const res = await call({ conversationId: 'conv-x', messageIds: [ID], status: 'read' })
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('400s on a bad body', async () => {
    for (const body of [{}, { conversationId: 'c', messageIds: ['nope'], status: 'read' }, { conversationId: 'c', messageIds: [ID], status: 'sent' }]) {
      const res = await call(body)
      expect(res.status).toBe(400)
    }
  })
})
