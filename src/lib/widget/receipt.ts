// ============================================================
// Web Widget v2 — delivery / read receipts from the widget.
// Pure helpers for POST /api/widget/receipt.
// ============================================================

export type ReceiptStatus = 'delivered' | 'read'

export const RECEIPT_MAX_IDS = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The statuses a message may currently have for `target` to be applied.
 * Forward only: 'delivered' upgrades just 'sent'; 'read' upgrades 'sent' and
 * 'delivered'. Anything else (read, sending, failed) is left alone, so a
 * receipt can never downgrade a status.
 */
export function receiptFromStatuses(target: ReceiptStatus): string[] {
  return target === 'delivered' ? ['sent'] : ['sent', 'delivered']
}

/** Pure form of the same rule, for tests and callers that already hold the row. */
export function nextReceiptStatus(current: string, target: ReceiptStatus): string {
  return receiptFromStatuses(target).includes(current) ? target : current
}

export type ReceiptParse =
  | { ok: true; value: { conversationId: string; messageIds: string[]; status: ReceiptStatus } }
  | { ok: false; error: string }

export function parseReceiptBody(raw: unknown): ReceiptParse {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid request body' }
  const b = raw as Record<string, unknown>
  const conversationId = typeof b.conversationId === 'string' ? b.conversationId : ''
  if (!conversationId) return { ok: false, error: 'conversationId is required' }
  if (b.status !== 'delivered' && b.status !== 'read') {
    return { ok: false, error: "status must be 'delivered' or 'read'" }
  }
  if (!Array.isArray(b.messageIds) || b.messageIds.length === 0) {
    return { ok: false, error: 'messageIds must be a non-empty array' }
  }
  if (b.messageIds.length > RECEIPT_MAX_IDS) {
    return { ok: false, error: `messageIds is limited to ${RECEIPT_MAX_IDS} per request` }
  }
  const ids = b.messageIds.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x))
  if (ids.length !== b.messageIds.length) return { ok: false, error: 'messageIds must be message ids' }
  return { ok: true, value: { conversationId, messageIds: [...new Set(ids)], status: b.status } }
}
