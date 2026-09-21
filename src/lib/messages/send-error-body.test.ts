import { describe, expect, it } from 'vitest'

import { SendMessageError } from '@/lib/whatsapp/send-message'
import { sendErrorBody } from './send-error-body'
import { isWhatsappWindowOpen, WHATSAPP_WINDOW_HOURS } from './window'

describe('sendErrorBody', () => {
  it('keeps the old { error } shape for validation errors and adds nothing else', () => {
    const body = sendErrorBody(new SendMessageError('bad_request', 'message_type is required', 400))
    expect(body).toEqual({ error: 'message_type is required', code: 'bad_request' })
  })

  it('names the saved failed message and gives the friendly reason', () => {
    const body = sendErrorBody(
      new SendMessageError('meta_error', 'Meta API error: (#131047) Re-engagement message', 502, {
        failure: { code: 131047, title: 'Re-engagement message', details: null },
        failedMessageId: 'msg-9',
      }),
      'whatsapp',
    )
    expect(body).toMatchObject({
      error: 'Meta API error: (#131047) Re-engagement message',
      code: 'meta_error',
      failed_message_id: 'msg-9',
      failure: {
        code: 131047,
        title: 'Re-engagement message',
        details: null,
        kind: 'window_closed',
        needs_template: true,
      },
    })
    expect((body.failure as { friendly: string }).friendly).toContain('24-hour window')
  })

  it('omits failed_message_id when the failed row could not be saved', () => {
    const body = sendErrorBody(
      new SendMessageError('meta_error', 'x', 502, {
        failure: { code: 190, title: 'expired', details: null },
      }),
    )
    expect('failed_message_id' in body).toBe(false)
    expect((body.failure as { kind: string }).kind).toBe('auth')
  })
})

describe('isWhatsappWindowOpen', () => {
  const now = new Date('2026-09-21T12:00:00Z')
  it('is open within 24 hours of the last customer message', () => {
    expect(isWhatsappWindowOpen('2026-09-21T00:00:01Z', now)).toBe(true)
  })
  it('is closed at and after 24 hours', () => {
    expect(WHATSAPP_WINDOW_HOURS).toBe(24)
    expect(isWhatsappWindowOpen('2026-09-20T12:00:00Z', now)).toBe(false)
    expect(isWhatsappWindowOpen('2026-09-01T12:00:00Z', now)).toBe(false)
  })
  it('is closed when the customer never wrote or the date is bad', () => {
    expect(isWhatsappWindowOpen(null, now)).toBe(false)
    expect(isWhatsappWindowOpen('not a date', now)).toBe(false)
  })
})
