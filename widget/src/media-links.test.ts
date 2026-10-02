// The chat-media bucket is private: the widget swaps each stored media url for a
// short-lived signed link at the data layer, so the bubbles keep rendering `media_url`.
import { describe, expect, it, vi } from 'vitest'

import {
  applyMediaLinks,
  createMediaLinkResolver,
  MEDIA_LINK_TTL_MS,
  mediaUrlsToResolve,
  resolveMessageMedia,
} from './media-links'
import type { LocalMessage, WidgetMessage } from './types'
import { mergeMessages } from './util'

const HOST = 'https://x.supabase.co/storage/v1/object/public/chat-media'
const RAW_A = `${HOST}/account-a1/widget/conv-1/aaa-photo.jpg`
const RAW_B = `${HOST}/account-a1/agent/bbb-voice.ogg`
const SIGNED_A = 'https://x.supabase.co/storage/v1/object/sign/chat-media/account-a1/widget/conv-1/aaa-photo.jpg?token=A'
const SIGNED_B = 'https://x.supabase.co/storage/v1/object/sign/chat-media/account-a1/agent/bbb-voice.ogg?token=B'

const msg = (over: Partial<WidgetMessage> = {}): WidgetMessage => ({
  id: 'm1',
  sender_type: 'agent',
  content_text: null,
  content_type: 'image',
  media_url: RAW_A,
  status: 'sent',
  created_at: '2026-10-01T10:00:00Z',
  ...over,
})

function fakeServer(links: Record<string, string> = { [RAW_A]: SIGNED_A, [RAW_B]: SIGNED_B }) {
  return vi.fn(async (_conv: string, urls: string[]) => {
    const out: Record<string, string> = {}
    for (const u of urls) if (links[u]) out[u] = links[u]
    return out
  })
}

describe('applyMediaLinks / resolveMessageMedia', () => {
  it('replaces media_url with the signed link and keeps the stored url in rawMediaUrl', async () => {
    const fetchLinks = fakeServer()
    const resolver = createMediaLinkResolver(fetchLinks)
    const [out] = await resolveMessageMedia('conv-1', [msg()], resolver)
    expect(out.media_url).toBe(SIGNED_A)
    expect(out.rawMediaUrl).toBe(RAW_A)
    expect(fetchLinks).toHaveBeenCalledWith('conv-1', [RAW_A])
  })

  it('asks once for a batch, asks for each distinct url once, and never for text or non-private urls', async () => {
    const fetchLinks = fakeServer()
    const resolver = createMediaLinkResolver(fetchLinks)
    const rows = [
      msg({ id: '1' }),
      msg({ id: '2' }), // same file again
      msg({ id: '3', media_url: RAW_B, content_type: 'audio' }),
      msg({ id: '4', media_url: null, content_type: 'text', content_text: 'hi' }),
      msg({ id: '5', media_url: 'https://cdn.example/x.png' }),
      msg({ id: '6', media_url: 'https://x.supabase.co/storage/v1/object/public/public-assets/kb/x.png' }),
    ]
    const out = await resolveMessageMedia('conv-1', rows, resolver)
    expect(fetchLinks).toHaveBeenCalledTimes(1)
    expect(fetchLinks.mock.calls[0][1]).toEqual([RAW_A, RAW_B])
    expect(out.map((m) => m.media_url)).toEqual([
      SIGNED_A,
      SIGNED_A,
      SIGNED_B,
      null,
      'https://cdn.example/x.png',
      'https://x.supabase.co/storage/v1/object/public/public-assets/kb/x.png',
    ])
    expect(out[3].rawMediaUrl).toBeUndefined()
    expect(out[4].rawMediaUrl).toBeUndefined()
  })

  it('splits more than 25 urls into several requests', async () => {
    const urls = Array.from({ length: 60 }, (_, i) => `${HOST}/account-a1/widget/conv-1/${i}.jpg`)
    const fetchLinks = vi.fn(async (_c: string, batch: string[]) => Object.fromEntries(batch.map((u) => [u, `${u}?signed`])))
    const resolver = createMediaLinkResolver(fetchLinks)
    const out = await resolveMessageMedia('conv-1', urls.map((u, i) => msg({ id: `m${i}`, media_url: u })), resolver)
    expect(fetchLinks.mock.calls.map((c) => c[1].length)).toEqual([25, 25, 10])
    expect(out.every((m) => m.media_url?.endsWith('?signed'))).toBe(true)
  })

  it('a message the server would not sign stays renderable with its stored url, and the others still resolve', async () => {
    const resolver = createMediaLinkResolver(fakeServer({ [RAW_B]: SIGNED_B }))
    const out = await resolveMessageMedia(
      'conv-1',
      [msg({ id: '1', content_text: 'look' }), msg({ id: '2', media_url: RAW_B, content_type: 'audio' })],
      resolver,
    )
    expect(out[0]).toMatchObject({ id: '1', content_text: 'look', content_type: 'image', media_url: RAW_A })
    expect(out[0].rawMediaUrl).toBeUndefined()
    expect(out[1].media_url).toBe(SIGNED_B)
  })

  it('a failing link service never rejects and never loses a row', async () => {
    const resolver = createMediaLinkResolver(async () => {
      throw new Error('network down')
    })
    const rows = [msg({ id: '1', media_url: null, content_type: 'text', content_text: 'hello' }), msg({ id: '2' })]
    const out = await resolveMessageMedia('conv-1', rows, resolver)
    expect(out).toEqual(rows)
  })

  it('does not hold the rows back past the wait: a slow service shows them unlinked, the link lands in the cache after', async () => {
    let release: (v: Record<string, string>) => void = () => undefined
    const slow = vi.fn(() => new Promise<Record<string, string>>((r) => (release = r)))
    const resolver = createMediaLinkResolver(slow)
    const rows = [msg()]
    const out = await resolveMessageMedia('conv-1', rows, resolver, 10)
    expect(out).toBe(rows)
    expect(out[0].media_url).toBe(RAW_A)

    release({ [RAW_A]: SIGNED_A })
    await Promise.resolve()
    await Promise.resolve()
    // the next pass (App's relink) finds it without another request
    const links = await resolver.resolve('conv-1', [RAW_A])
    expect(slow).toHaveBeenCalledTimes(1)
    expect(applyMediaLinks(rows, links)[0].media_url).toBe(SIGNED_A)
  })

  it('applyMediaLinks returns the same array when there is nothing to change', () => {
    const rows = [msg({ media_url: null, content_type: 'text' }), msg({ id: '2', media_url: 'https://cdn.example/a.png' })]
    expect(applyMediaLinks(rows, new Map([[RAW_A, SIGNED_A]]))).toBe(rows)
    const linked = applyMediaLinks([msg()], new Map([[RAW_A, SIGNED_A]]))
    expect(applyMediaLinks(linked, new Map([[RAW_A, SIGNED_A]]))).toBe(linked)
  })

  it('applyMediaLinks re-keys on rawMediaUrl, so an already linked message gets its fresh link', () => {
    const linked = applyMediaLinks([msg()], new Map([[RAW_A, SIGNED_A]]))
    const fresh = applyMediaLinks(linked, new Map([[RAW_A, `${SIGNED_A}2`]]))
    expect(fresh[0].media_url).toBe(`${SIGNED_A}2`)
    expect(fresh[0].rawMediaUrl).toBe(RAW_A)
  })

  it('mediaUrlsToResolve lists distinct private stored urls (raw one for an already linked message)', () => {
    const linked = applyMediaLinks([msg({ id: '1' })], new Map([[RAW_A, SIGNED_A]]))
    expect(mediaUrlsToResolve([...linked, msg({ id: '2' }), msg({ id: '3', media_url: 'https://cdn.example/a.png' })])).toEqual([
      RAW_A,
    ])
  })

  it('ignores a "link" that is not an http(s) url', async () => {
    const resolver = createMediaLinkResolver(async () => ({ [RAW_A]: 'javascript:alert(1)' }))
    const [out] = await resolveMessageMedia('conv-1', [msg()], resolver)
    expect(out.media_url).toBe(RAW_A)
  })
})

describe('mergeMessages keeps a signed link when a raw row arrives', () => {
  const base = (): LocalMessage[] => applyMediaLinks([msg({ status: 'sent' })], new Map([[RAW_A, SIGNED_A]]))

  it('an UPDATE payload (status change) re-sends the raw url and does not clobber the signed one', () => {
    const merged = mergeMessages(base(), [msg({ status: 'read' })])
    expect(merged[0].status).toBe('read')
    expect(merged[0].media_url).toBe(SIGNED_A)
    expect(merged[0].rawMediaUrl).toBe(RAW_A)
  })

  it('a stale raw row (older status) keeps both the tick and the link', () => {
    const delivered = mergeMessages(base(), [msg({ status: 'delivered' })])
    const merged = mergeMessages(delivered, [msg({ status: 'sent' })])
    expect(merged[0].status).toBe('delivered')
    expect(merged[0].media_url).toBe(SIGNED_A)
  })

  it('a resolved row replaces the held link', () => {
    const merged = mergeMessages(base(), [{ ...msg(), media_url: `${SIGNED_A}2`, rawMediaUrl: RAW_A }])
    expect(merged[0].media_url).toBe(`${SIGNED_A}2`)
    expect(merged[0].rawMediaUrl).toBe(RAW_A)
  })

  it('a row for a different file does not inherit the old link', () => {
    const merged = mergeMessages(base(), [msg({ media_url: RAW_B })])
    expect(merged[0].media_url).toBe(RAW_B)
    expect(merged[0].rawMediaUrl).toBeUndefined()
  })

  it('an optimistic local message keeps its blob url when the server row (with a link) arrives', () => {
    const local: LocalMessage = { ...msg({ media_url: null }), localUrl: 'blob:abc', localFileName: 'p.jpg' }
    const merged = mergeMessages([local], [{ ...msg(), media_url: SIGNED_A, rawMediaUrl: RAW_A }])
    expect(merged[0].localUrl).toBe('blob:abc')
    expect(merged[0].media_url).toBe(SIGNED_A)
  })
})

describe('link cache', () => {
  it('a second resolve for the same url is served from the cache (no second request)', async () => {
    const fetchLinks = fakeServer()
    const resolver = createMediaLinkResolver(fetchLinks)
    await resolver.resolve('conv-1', [RAW_A])
    const again = await resolver.resolve('conv-1', [RAW_A, RAW_A])
    expect(again.get(RAW_A)).toBe(SIGNED_A)
    expect(fetchLinks).toHaveBeenCalledTimes(1)
    expect(resolver.peek(RAW_A)).toBe(SIGNED_A)
  })

  it('only the urls not yet held are requested', async () => {
    const fetchLinks = fakeServer()
    const resolver = createMediaLinkResolver(fetchLinks)
    await resolver.resolve('conv-1', [RAW_A])
    await resolver.resolve('conv-1', [RAW_A, RAW_B])
    expect(fetchLinks.mock.calls[1][1]).toEqual([RAW_B])
  })

  it('concurrent callers share one request', async () => {
    const fetchLinks = fakeServer()
    const resolver = createMediaLinkResolver(fetchLinks)
    const [x, y] = await Promise.all([resolver.resolve('conv-1', [RAW_A]), resolver.resolve('conv-1', [RAW_A])])
    expect(fetchLinks).toHaveBeenCalledTimes(1)
    expect(x.get(RAW_A)).toBe(SIGNED_A)
    expect(y.get(RAW_A)).toBe(SIGNED_A)
  })

  it('a link is dropped a few minutes before the server lets it lapse (4h - 5min), then fetched again', async () => {
    let t = 1_000_000
    const fetchLinks = fakeServer()
    const resolver = createMediaLinkResolver(fetchLinks, { now: () => t })
    expect(MEDIA_LINK_TTL_MS).toBe((4 * 60 - 5) * 60 * 1000)
    await resolver.resolve('conv-1', [RAW_A])
    t += MEDIA_LINK_TTL_MS - 1
    await resolver.resolve('conv-1', [RAW_A])
    expect(fetchLinks).toHaveBeenCalledTimes(1)
    t += 2
    expect(resolver.peek(RAW_A)).toBeNull()
    await resolver.resolve('conv-1', [RAW_A])
    expect(fetchLinks).toHaveBeenCalledTimes(2)
  })

  it('a url that could not be linked is not hammered: it waits out a short back-off, then tries again', async () => {
    let t = 5_000
    const fetchLinks = fakeServer({})
    const resolver = createMediaLinkResolver(fetchLinks, { now: () => t, failureBackoffMs: 60_000 })
    expect((await resolver.resolve('conv-1', [RAW_A])).size).toBe(0)
    await resolver.resolve('conv-1', [RAW_A])
    expect(fetchLinks).toHaveBeenCalledTimes(1)
    t += 60_001
    await resolver.resolve('conv-1', [RAW_A])
    expect(fetchLinks).toHaveBeenCalledTimes(2)
  })

  it('a thrown request leaves no stuck in-flight entry', async () => {
    let t = 0
    const fetchLinks = vi
      .fn<(c: string, u: string[]) => Promise<Record<string, string>>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ [RAW_A]: SIGNED_A })
    const resolver = createMediaLinkResolver(fetchLinks, { now: () => t, failureBackoffMs: 10 })
    expect((await resolver.resolve('conv-1', [RAW_A])).size).toBe(0)
    t = 11
    expect((await resolver.resolve('conv-1', [RAW_A])).get(RAW_A)).toBe(SIGNED_A)
  })
})
