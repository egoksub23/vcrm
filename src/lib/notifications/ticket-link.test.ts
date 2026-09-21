import { describe, expect, it } from 'vitest'

import { ticketNotificationHref } from './ticket-link'

describe('ticketNotificationHref', () => {
  it('opens the ticket', () => {
    expect(ticketNotificationHref({ ticket_id: 't1' })).toBe('/tickets?t=t1')
  })
  it('opens the comment a mention is about', () => {
    expect(ticketNotificationHref({ ticket_id: 't1', comment_id: 'c9' })).toBe('/tickets?t=t1&c=c9')
  })
})
