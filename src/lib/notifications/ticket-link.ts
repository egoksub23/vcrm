import type { Notification } from '@/types'

/**
 * Where a ticket notification opens: the ticket, and for a mention the comment
 * that asked (`c`, migration 095: the ticket view scrolls to it).
 */
export function ticketNotificationHref(n: Pick<Notification, 'ticket_id' | 'comment_id'>): string {
  const params = new URLSearchParams()
  if (n.ticket_id) params.set('t', n.ticket_id)
  if (n.comment_id) params.set('c', n.comment_id)
  return `/tickets?${params.toString()}`
}
