import { describe, expect, it } from 'vitest'

import { makeTranslator } from './i18n'
import { DEFAULT_LIMITS, type LocalMessage } from './types'
import {
  baseMime,
  dayKey,
  dayLabel,
  fileNameFromUrl,
  findUnread,
  formatBytes,
  formatDuration,
  groupMessages,
  guessMime,
  isPlausibleEmail,
  isPlausiblePhone,
  isStatusUpgrade,
  kindForMime,
  mergeMessages,
  normalizePhone,
  receiptTargets,
  splitLinks,
  tickState,
  validateFile,
} from './util'

const t = makeTranslator('en')

/** Local-time ISO string so day grouping is independent of the machine's timezone. */
function at(y: number, mo: number, d: number, h = 12, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString()
}

function msg(over: Partial<LocalMessage> & { id: string }): LocalMessage {
  return {
    sender_type: 'customer',
    content_text: 'hi',
    created_at: at(2026, 9, 21),
    status: 'sent',
    ...over,
  }
}

describe('formatting', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(16 * 1024 * 1024)).toBe('16 MB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(-1)).toBe('')
  })

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(75)).toBe('1:15')
    expect(formatDuration(299.9)).toBe('4:59')
    expect(formatDuration(NaN)).toBe('0:00')
    expect(formatDuration(-3)).toBe('0:00')
  })
})

describe('phone and email checks', () => {
  it('normalises phone numbers', () => {
    expect(normalizePhone(' +60 12-345 6789 ')).toBe('+60123456789')
    expect(normalizePhone('(012) 345 6789')).toBe('0123456789')
  })
  it('accepts plausible numbers only', () => {
    expect(isPlausiblePhone('+60 12 345 6789')).toBe(true)
    expect(isPlausiblePhone('12345')).toBe(false)
    expect(isPlausiblePhone('1234567890123456')).toBe(false)
  })
  it('checks emails', () => {
    expect(isPlausibleEmail('a@b.co')).toBe(true)
    expect(isPlausibleEmail('a@b')).toBe(false)
    expect(isPlausibleEmail('a b@c.com')).toBe(false)
  })
})

describe('file validation', () => {
  const limits = DEFAULT_LIMITS
  it('normalises mime types', () => {
    expect(baseMime('Audio/OGG; codecs=opus')).toBe('audio/ogg')
    expect(baseMime('image/jpg')).toBe('image/jpeg')
  })
  it('guesses a type from the extension when the browser gives none', () => {
    expect(guessMime({ name: 'Report.PDF', type: '' })).toBe('application/pdf')
    expect(guessMime({ name: 'noext', type: '' })).toBe('')
    expect(guessMime({ name: 'a.png', type: 'image/png' })).toBe('image/png')
  })
  it('maps mime to media kind', () => {
    expect(kindForMime('image/png')).toBe('image')
    expect(kindForMime('video/mp4')).toBe('video')
    expect(kindForMime('audio/ogg')).toBe('audio')
    expect(kindForMime('application/pdf')).toBe('document')
  })
  it('accepts an allowed file', () => {
    expect(validateFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 }, limits)).toEqual({
      ok: true,
      mime: 'image/jpeg',
      kind: 'image',
    })
  })
  it('rejects empty, disallowed and oversized files', () => {
    expect(validateFile({ name: 'a.jpg', type: 'image/jpeg', size: 0 }, limits)).toEqual({ ok: false, reason: 'empty' })
    expect(validateFile({ name: 'a.heic', type: 'image/heic', size: 10 }, limits)).toEqual({ ok: false, reason: 'type' })
    expect(validateFile({ name: 'a.webm', type: 'audio/webm', size: 10 }, limits)).toEqual({ ok: false, reason: 'type' })
    expect(
      validateFile({ name: 'a.mp4', type: 'video/mp4', size: limits.maxFileBytes + 1 }, limits),
    ).toEqual({ ok: false, reason: 'too_large' })
    expect(validateFile({ name: 'a.mp4', type: 'video/mp4', size: limits.maxFileBytes }, limits).ok).toBe(true)
  })
  it('honours the limits the server sent', () => {
    const custom = { maxFileBytes: 100, maxVoiceSeconds: 60, allowedMimeTypes: ['application/pdf'] }
    expect(validateFile({ name: 'a.jpg', type: 'image/jpeg', size: 10 }, custom).ok).toBe(false)
    expect(validateFile({ name: 'a.pdf', type: 'application/pdf', size: 101 }, custom)).toEqual({
      ok: false,
      reason: 'too_large',
    })
  })
  it('recovers a file name from a stored URL', () => {
    expect(
      fileNameFromUrl(
        'https://x.supabase.co/storage/v1/object/public/chat-media/account-1/widget/c1/3f2a9b1c-1111-2222-3333-444455556666-Report%20Q3.pdf',
      ),
    ).toBe('Report Q3.pdf')
    expect(fileNameFromUrl('https://x/y/1726900000000-photo.jpg?t=1')).toBe('photo.jpg')
  })
})

describe('links in text', () => {
  it('splits text around http(s) links and keeps trailing punctuation outside', () => {
    expect(splitLinks('see https://vircle.app/help, thanks')).toEqual([
      { text: 'see ' },
      { text: 'https://vircle.app/help', href: 'https://vircle.app/help' },
      { text: ', thanks' },
    ])
  })
  it('leaves plain text and non-http schemes alone', () => {
    expect(splitLinks('hello')).toEqual([{ text: 'hello' }])
    expect(splitLinks('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }])
  })
})

describe('tick state', () => {
  it('is null for agent and bot messages', () => {
    expect(tickState(msg({ id: 'a', sender_type: 'agent' }))).toBeNull()
    expect(tickState(msg({ id: 'b', sender_type: 'bot' }))).toBeNull()
  })
  it('walks pending -> sent -> delivered -> read', () => {
    expect(tickState(msg({ id: 'a', pending: true }))).toBe('pending')
    expect(tickState(msg({ id: 'a', status: 'sent' }))).toBe('sent')
    expect(tickState(msg({ id: 'a', status: 'delivered' }))).toBe('delivered')
    expect(tickState(msg({ id: 'a', status: 'read' }))).toBe('read')
  })
  it('shows failure, and treats unknown statuses as sent', () => {
    expect(tickState(msg({ id: 'a', failed: true, pending: true }))).toBe('failed')
    expect(tickState(msg({ id: 'a', status: 'queued' }))).toBe('sent')
    expect(tickState(msg({ id: 'a', status: null }))).toBe('sent')
  })
  it('never lets a status go backwards', () => {
    expect(isStatusUpgrade('read', 'delivered')).toBe(false)
    expect(isStatusUpgrade('delivered', 'sent')).toBe(false)
    expect(isStatusUpgrade('sent', 'read')).toBe(true)
    expect(isStatusUpgrade('sent', 'sent')).toBe(true)
  })
})

describe('mergeMessages', () => {
  it('dedupes by id, sorts oldest first and keeps pending sends last', () => {
    const existing = [
      msg({ id: 'm2', created_at: at(2026, 9, 21, 10, 5) }),
      msg({ id: 'temp-1', created_at: at(2026, 9, 21, 9, 0), pending: true }),
    ]
    const merged = mergeMessages(existing, [
      msg({ id: 'm1', created_at: at(2026, 9, 21, 10, 0) }),
      msg({ id: 'm2', created_at: at(2026, 9, 21, 10, 5), status: 'delivered' }),
    ])
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'temp-1'])
    expect(merged[1].status).toBe('delivered')
  })
  it('keeps local-only fields when the server row arrives', () => {
    const merged = mergeMessages(
      [msg({ id: 'm1', localUrl: 'blob:abc', content_type: 'image' })],
      [msg({ id: 'm1', media_url: 'https://cdn/x.png', content_type: 'image' })],
    )
    expect(merged[0].localUrl).toBe('blob:abc')
    expect(merged[0].media_url).toBe('https://cdn/x.png')
  })
  it('does not roll a read tick back to sent on a stale row', () => {
    const merged = mergeMessages([msg({ id: 'm1', status: 'read' })], [msg({ id: 'm1', status: 'sent' })])
    expect(merged[0].status).toBe('read')
  })
})

describe('day dividers', () => {
  const now = new Date(2026, 8, 21, 15, 0)

  it('labels today, yesterday and older days', () => {
    expect(dayLabel(at(2026, 9, 21, 8), now, 'en', t)).toBe('Today')
    expect(dayLabel(at(2026, 9, 20, 23), now, 'en', t)).toBe('Yesterday')
    const older = dayLabel(at(2026, 9, 18), now, 'en', t)
    expect(older).not.toBe('Today')
    expect(older).not.toBe('Yesterday')
    expect(older.length).toBeGreaterThan(0)
    expect(dayLabel(at(2025, 1, 5), now, 'en', t)).toContain('2025')
  })

  it('localises Today', () => {
    expect(dayLabel(at(2026, 9, 21), now, 'ms', makeTranslator('ms'))).toBe('Hari ini')
    expect(dayLabel(at(2026, 9, 21), now, 'zh', makeTranslator('zh'))).toBe('今天')
  })

  it('inserts one divider per calendar day', () => {
    const items = groupMessages(
      [
        msg({ id: 'a', created_at: at(2026, 9, 20, 9) }),
        msg({ id: 'b', created_at: at(2026, 9, 20, 18) }),
        msg({ id: 'c', created_at: at(2026, 9, 21, 9) }),
      ],
      { locale: 'en', now, t },
    )
    expect(items.map((i) => i.type)).toEqual(['day', 'message', 'message', 'day', 'message'])
    expect(items[0]).toMatchObject({ type: 'day', label: 'Yesterday' })
    expect(items[3]).toMatchObject({ type: 'day', label: 'Today' })
    expect(dayKey(new Date(2026, 8, 5))).toBe('2026-09-05')
  })

  it('places the unread marker before the first unseen agent message', () => {
    const messages = [
      msg({ id: 'a', sender_type: 'agent', created_at: at(2026, 9, 21, 9) }),
      msg({ id: 'b', sender_type: 'customer', created_at: at(2026, 9, 21, 10) }),
      msg({ id: 'c', sender_type: 'agent', created_at: at(2026, 9, 21, 11) }),
      msg({ id: 'd', sender_type: 'agent', created_at: at(2026, 9, 21, 12) }),
    ]
    const unread = findUnread(messages, at(2026, 9, 21, 10, 30))
    expect(unread).toEqual({ firstId: 'c', count: 2 })
    const items = groupMessages(messages, { locale: 'en', now, t, unread })
    expect(items.map((i) => i.type)).toEqual(['day', 'message', 'message', 'unread', 'message', 'message'])
  })

  it('has no marker for a first visit, or when everything was seen', () => {
    const messages = [msg({ id: 'a', sender_type: 'agent', created_at: at(2026, 9, 21, 9) })]
    expect(findUnread(messages, null)).toBeNull()
    expect(findUnread(messages, at(2026, 9, 21, 9))).toBeNull()
    expect(findUnread([msg({ id: 'x', sender_type: 'customer', created_at: at(2026, 9, 21, 9) })], at(2026, 9, 20))).toBeNull()
  })
})

describe('receiptTargets', () => {
  const list = [
    msg({ id: 'a1', sender_type: 'agent', status: 'sent' }),
    msg({ id: 'a2', sender_type: 'agent', status: 'delivered' }),
    msg({ id: 'a3', sender_type: 'bot', status: 'read' }),
    msg({ id: 'c1', sender_type: 'customer', status: 'sent' }),
    msg({ id: 'temp-1', sender_type: 'agent', pending: true }),
  ]

  it('reports delivered only for agent/bot rows that are behind', () => {
    expect(receiptTargets(list, new Map(), 'delivered')).toEqual(['a1'])
  })
  it('reports read for everything not yet read, never for the visitor\'s own messages', () => {
    expect(receiptTargets(list, new Map(), 'read')).toEqual(['a1', 'a2'])
  })
  it('does not double-report or downgrade within a session', () => {
    const reported = new Map<string, 'delivered' | 'read'>([
      ['a1', 'read'],
      ['a2', 'delivered'],
    ])
    expect(receiptTargets(list, reported, 'delivered')).toEqual([])
    expect(receiptTargets(list, reported, 'read')).toEqual(['a2'])
  })
})
