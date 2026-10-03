import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyVircleRead, notifyVircleTyping, throttled, TYPING_SEND_INTERVAL_MS } from './client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('browser calls to the Vircle Chat routes', () => {
  it('posts the conversation id to the read and typing routes', () => {
    notifyVircleRead('cv-1')
    notifyVircleTyping('cv-2')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/vircle-chat/read')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ conversationId: 'cv-1' })
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/vircle-chat/typing')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ conversationId: 'cv-2' })
  })

  it('never throws or surfaces a failure (fire and forget)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(() => notifyVircleRead('cv-1')).not.toThrow()
    await Promise.resolve()
  })
})

describe('throttled', () => {
  it('lets the first call through at once and drops calls inside the interval', () => {
    let t = 1000
    const send = vi.fn()
    const call = throttled(send, 3000, () => t)
    call()
    t += 1000
    call()
    t += 1999
    call()
    expect(send).toHaveBeenCalledTimes(1)
    t += 1
    call() // exactly 3000 ms after the first
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('uses a 3 second interval by default', () => {
    expect(TYPING_SEND_INTERVAL_MS).toBe(3000)
  })
})
