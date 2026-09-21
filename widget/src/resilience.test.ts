// Regression tests for "the widget went blank / looked like a new session after F5
// and never showed the agent's voice note".
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LocalMessage } from './types'
import {
  historyLooksMissing,
  mergeMessages,
  needsConnect,
  pollDelayMs,
  receiptTargets,
  toWidgetMessage,
  toWidgetMessages,
} from './util'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const CONV = '6837158e-10e4-4e80-997e-e8464498580c'

describe('reconnecting after a failed history load', () => {
  it('connects a conversation that has not fully connected yet', () => {
    expect(needsConnect(CONV, null)).toBe(true)
  })

  it('a failed first attempt leaves connectedId null, so the retry connects again (it used to be skipped)', () => {
    // connectConversation only sets connectedId at its very end; if it threw, it stays null
    // and the next /session response (Try again, or F5) runs it again.
    let connectedId: string | null = null
    expect(needsConnect(CONV, connectedId)).toBe(true)
    connectedId = CONV // history attempted + live channel open
    expect(needsConnect(CONV, connectedId)).toBe(false)
    // a different conversation (guest thread merged into an existing contact) reconnects
    expect(needsConnect('another-conversation', connectedId)).toBe(true)
  })
})

describe('empty history for a returning visitor is an error, not a new chat', () => {
  it('flags an empty result when this browser has shown messages here before', () => {
    expect(historyLooksMissing(0, '2026-09-21T12:57:26.000Z')).toBe(true)
  })
  it('does not flag a genuinely new conversation, or a loaded one', () => {
    expect(historyLooksMissing(0, null)).toBe(false)
    expect(historyLooksMissing(5, '2026-09-21T12:57:26.000Z')).toBe(false)
  })
})

describe('safety-net polling', () => {
  it('polls slowly while live and quickly while the socket is down', () => {
    expect(pollDelayMs({ open: true, visible: true, live: true })).toBe(30_000)
    expect(pollDelayMs({ open: true, visible: true, live: false })).toBe(8_000)
  })
  it('does not poll a closed panel or a hidden tab', () => {
    expect(pollDelayMs({ open: false, visible: true, live: false })).toBeNull()
    expect(pollDelayMs({ open: true, visible: false, live: false })).toBeNull()
  })
})

describe('Realtime / history rows', () => {
  it('a batch with one unusable row keeps the rest', () => {
    const good = { id: 'a', created_at: '2026-09-21T12:00:00Z', sender_type: 'agent', content_type: 'text', content_text: 'hi' }
    const rows = toWidgetMessages([good, { id: 'b' }, null, 'x', { ...good, id: 'c' }])
    expect(rows.map((r) => r.id)).toEqual(['a', 'c'])
    expect(toWidgetMessages(null)).toEqual([])
    expect(toWidgetMessages(undefined)).toEqual([])
  })

  it('a live agent voice note is merged into the list and queued for a delivered receipt', () => {
    const image = toWidgetMessage({
      id: '179c74d6-b491-4d3d-a4b9-936f1c4f3e35',
      sender_type: 'agent',
      content_type: 'image',
      media_url: 'https://x.test/a.jpg',
      status: 'read',
      created_at: '2026-09-21T12:26:51.477662+00:00',
    })!
    const voice = toWidgetMessage({
      id: '5af44fe5-9f0e-495d-adcf-88d42bdd2c47',
      sender_type: 'agent',
      content_type: 'audio',
      content_text: null,
      media_url: 'https://x.test/voice.ogg',
      status: 'sent',
      created_at: '2026-09-21 12:57:26.613614+00',
      is_internal: false,
    })!
    const own = toWidgetMessage({
      id: '90d222c0-6ae2-4bf8-adc7-15cf914e59d8',
      sender_type: 'customer',
      content_type: 'audio',
      media_url: 'https://x.test/mine.ogg',
      status: 'read',
      created_at: '2026-09-21 12:56:51.03963+00',
    })!
    const before: LocalMessage[] = [image, own]
    const after = mergeMessages(before, [voice])
    expect(after.map((m) => m.id)).toEqual([image.id, own.id, voice.id])

    const reported = new Map<string, 'delivered' | 'read'>()
    expect(receiptTargets(after, reported, 'delivered')).toEqual([voice.id])
    expect(receiptTargets(after, reported, 'read')).toEqual([voice.id])
    reported.set(voice.id, 'read')
    expect(receiptTargets(after, reported, 'read')).toEqual([])
  })
})

describe('requests can not hang forever', () => {
  async function loadApi() {
    // api.ts reads document.currentScript at import time and inlines build-time constants.
    vi.stubGlobal('document', { currentScript: null, querySelector: () => null })
    vi.stubGlobal('__SUPABASE_URL__', 'http://localhost:54321')
    vi.stubGlobal('__SUPABASE_ANON_KEY__', 'anon')
    return import('./api')
  }

  it('turns a stalled request into a network error', async () => {
    vi.useFakeTimers()
    const { withTimeout, ApiError } = await loadApi()
    const never = new Promise<never>(() => {})
    const p = withTimeout(never, 1000)
    const settled = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(1001)
    const err = await settled
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'network', status: 0 })
  })

  it('passes a timely result through and clears the timer', async () => {
    vi.useFakeTimers()
    const { withTimeout } = await loadApi()
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42)
    expect(vi.getTimerCount()).toBe(0)
    await expect(withTimeout(Promise.reject(new Error('x')), 1000)).rejects.toThrow('x')
    expect(vi.getTimerCount()).toBe(0)
  })
})
