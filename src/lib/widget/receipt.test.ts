import { describe, expect, it } from 'vitest'

import { RECEIPT_MAX_IDS, nextReceiptStatus, parseReceiptBody, receiptFromStatuses } from './receipt'

const ID = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

describe('receipt status only moves forward', () => {
  it.each([
    ['sent', 'delivered', 'delivered'],
    ['sent', 'read', 'read'],
    ['delivered', 'read', 'read'],
    ['delivered', 'delivered', 'delivered'],
    ['read', 'delivered', 'read'], // never downgrades read -> delivered
    ['read', 'read', 'read'],
    ['failed', 'read', 'failed'], // failed / sending are left alone
    ['sending', 'delivered', 'sending'],
  ] as const)('%s + %s -> %s', (current, target, expected) => {
    expect(nextReceiptStatus(current, target)).toBe(expected)
  })

  it('the SQL filter never includes read', () => {
    expect(receiptFromStatuses('delivered')).toEqual(['sent'])
    expect(receiptFromStatuses('read')).toEqual(['sent', 'delivered'])
    expect(receiptFromStatuses('delivered')).not.toContain('read')
    expect(receiptFromStatuses('read')).not.toContain('read')
  })
})

describe('parseReceiptBody', () => {
  it('parses a valid body and de-duplicates ids', () => {
    expect(parseReceiptBody({ conversationId: 'c1', messageIds: [ID, ID, ID2], status: 'read' })).toEqual({
      ok: true,
      value: { conversationId: 'c1', messageIds: [ID, ID2], status: 'read' },
    })
  })

  it.each([
    ['null body', null],
    ['no conversation', { messageIds: [ID], status: 'read' }],
    ['bad status', { conversationId: 'c', messageIds: [ID], status: 'sent' }],
    ['no ids', { conversationId: 'c', messageIds: [], status: 'read' }],
    ['ids not an array', { conversationId: 'c', messageIds: ID, status: 'read' }],
    ['non-uuid id', { conversationId: 'c', messageIds: ['x'], status: 'read' }],
    ['too many ids', { conversationId: 'c', messageIds: Array.from({ length: RECEIPT_MAX_IDS + 1 }, () => ID), status: 'read' }],
  ])('rejects %s', (_label, body) => {
    expect(parseReceiptBody(body).ok).toBe(false)
  })
})
