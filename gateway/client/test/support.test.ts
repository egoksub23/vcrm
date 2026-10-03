import { describe, expect, it, vi } from 'vitest'

import { ALLOWED_MIME_TYPES, backoffDelay, DEFAULT_BACKOFF, kindOfMime, localStorageStore, memoryStore } from '../src'
import { Emitter } from '../src/support'
import type { StoredState } from '../src/types'

const state = (over: Partial<StoredState> = {}): StoredState => ({ v: 1, conversationId: 'c_1', lastSeq: 3, messages: [], pending: [], ...over })

describe('the reconnect delay', () => {
  it('doubles from one second up to the ceiling', () => {
    const o = { ...DEFAULT_BACKOFF, jitter: 0 }
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, o))).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
  })

  it('is spread by the jitter: never more than a third either way, and never the same for everyone', () => {
    const lows = backoffDelay(3, DEFAULT_BACKOFF, () => 0)
    const highs = backoffDelay(3, DEFAULT_BACKOFF, () => 1)
    expect(lows).toBe(Math.round(8000 * 0.7))
    expect(highs).toBe(Math.round(8000 * 1.3))
    const spread = new Set(Array.from({ length: 50 }, () => backoffDelay(3, DEFAULT_BACKOFF)))
    expect(spread.size).toBeGreaterThan(10)
    for (const v of spread) expect(v).toBeGreaterThanOrEqual(5600), expect(v).toBeLessThanOrEqual(10_400)
  })

  it('treats a negative attempt as the first', () => {
    expect(backoffDelay(-5, { ...DEFAULT_BACKOFF, jitter: 0 })).toBe(1000)
  })
})

describe('file types', () => {
  it('maps a type to the kind of message, and refuses the rest', () => {
    expect(kindOfMime('image/png')).toBe('image')
    expect(kindOfMime('Image/JPEG; charset=x')).toBe('image')
    expect(kindOfMime('video/mp4')).toBe('video')
    expect(kindOfMime('audio/ogg')).toBe('audio')
    expect(kindOfMime('application/pdf')).toBe('document')
    expect(kindOfMime('image/gif')).toBeNull()
    expect(kindOfMime('application/x-msdownload')).toBeNull()
    expect(ALLOWED_MIME_TYPES).toHaveLength(18)
  })
})

describe('the stores', () => {
  it('memory keeps a copy, not the object', async () => {
    const s = memoryStore()
    expect(await s.load()).toBeNull()
    const st = state()
    await s.save(st)
    st.lastSeq = 99
    expect((await s.load())?.lastSeq).toBe(3)
    await s.clear()
    expect(await s.load()).toBeNull()
  })

  it('localStorage keeps it under the key and survives a new store object', async () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }
    await localStorageStore('chat:W1', storage).save(state({ lastSeq: 7 }))
    expect([...data.keys()]).toEqual(['chat:W1'])
    expect((await localStorageStore('chat:W1', storage).load())?.lastSeq).toBe(7)
    expect(await localStorageStore('chat:W2', storage).load()).toBeNull()
    await localStorageStore('chat:W1', storage).clear()
    expect(data.size).toBe(0)
  })

  it('never throws: broken JSON, a full disk and a blocked storage all read as "nothing"', async () => {
    const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('blocked') } }
    const s = localStorageStore('k', broken)
    expect(await s.load()).toBeNull()
    await expect(s.save(state())).resolves.toBeUndefined()
    await expect(s.clear()).resolves.toBeUndefined()
    expect(await localStorageStore('k', undefined).load()).toBeNull()
    const wrongShape = { getItem: () => JSON.stringify({ v: 2, messages: [] }), setItem: () => undefined, removeItem: () => undefined }
    expect(await localStorageStore('k', wrongShape).load()).toBeNull()
  })
})

describe('the emitter', () => {
  it('calls listeners, lets one leave, and survives a listener that throws', () => {
    const e = new Emitter<{ a: number }>()
    const seen: number[] = []
    const off = e.on('a', (n) => seen.push(n))
    e.on('a', () => {
      throw new Error('bad listener')
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    e.emit('a', 1)
    off()
    e.emit('a', 2)
    expect(seen).toEqual([1])
    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })
})
