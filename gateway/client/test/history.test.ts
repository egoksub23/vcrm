// fetchHistory (1.1.0) against the REAL gateway, with a stand-in for Halo's history address.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { ChatError, VircleChatClient, type ChatMessage, type ClientOptions } from '../src'
import { PNG, startHarness, type Harness } from '../../test/helpers'

let h: Harness
let clients: VircleChatClient[] = []
let asked: Record<string, any>[] = []
let answer: (body: Record<string, any>) => Response | Promise<Response>

const FAST = { minMs: 20, maxMs: 80, factor: 2, jitter: 0 }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  server_id: `m_old${n}`,
  direction: n % 2 ? 'out' : 'in',
  kind: 'text',
  text: `older ${n}`,
  sent_at: new Date(Date.UTC(2026, 8, 1, 10, n)).toISOString(),
  status: 'read',
  sender: { name: n % 2 ? 'Aisha from support' : null },
  reply_to: null,
  media: null,
  ...extra,
})

beforeEach(async () => {
  clients = []
  asked = []
  answer = () => json({ messages: [], more: false, end: 'start' })
  h = await startHarness({
    history: {
      fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        asked.push(body)
        return answer(body)
      }) as unknown as typeof fetch,
    },
    files: {
      fetch: (async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } })) as unknown as typeof fetch,
    },
  })
})
afterEach(async () => {
  clients.forEach((c) => c.stop())
  await h.close()
})

function make(wallet: string, extra: Partial<ClientOptions> = {}): VircleChatClient {
  const c = new VircleChatClient({
    deviceId: `dev-${wallet}`,
    baseUrl: h.url,
    WebSocket: WebSocket as never,
    getSession: async () => ({ token: (await h.session({ wallet_id: wallet, name: 'Aisha', phone: '+60123456789' })).token, wsPath: '/ws' }),
    backoff: FAST,
    listenToEnvironment: false,
    ...extra,
  })
  clients.push(c)
  return c
}
const online = async (c: VircleChatClient) => {
  await c.start()
  await vi.waitFor(() => expect(c.getSnapshot().state).toBe('online'), { timeout: 5000, interval: 10 })
}
const failure = async (p: Promise<unknown>): Promise<ChatError> => {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ChatError)
    return err as ChatError
  }
  throw new Error('expected a ChatError')
}

/** A WebSocket whose welcome does not list `features`, as an older gateway's does not. */
function oldGatewayWS(): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string) {
      super(url)
      const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!
      Object.defineProperty(this, 'onmessage', {
        configurable: true,
        get: () => desc.get!.call(this),
        set: (fn: ((ev: { data: unknown }) => void) | null) =>
          desc.set!.call(this, fn ? (ev: { data: unknown }) => {
            const f = JSON.parse(String(ev.data))
            if (f.type === 'welcome') delete f.features
            fn({ data: JSON.stringify(f) })
          } : fn),
      })
    }
  } as unknown as typeof WebSocket
}

describe('fetchHistory', () => {
  const before = { sentAt: Date.UTC(2026, 9, 1), serverId: 'm_first' }

  it('asks for the page named by the cursor and gives back messages the app can draw, oldest first', async () => {
    const c = make('W-hist')
    await online(c)
    answer = () => json({ messages: [row(2), row(1, { reply_to: { server_id: 'm_old0', kind: 'text', text: 'quoted', from: 'you' } })], more: true })
    const page = await c.fetchHistory({ before, limit: 2, notBefore: Date.UTC(2026, 7, 1) })

    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ before: { sent_at: '2026-10-01T00:00:00.000Z', server_id: 'm_first' }, limit: 2, not_before: '2026-08-01T00:00:00.000Z' })
    expect(page.more).toBe(true)
    expect(page.end).toBeNull()
    expect(page.messages.map((m) => m.serverId)).toEqual(['m_old1', 'm_old2'])
    expect(page.messages[0]).toMatchObject({
      id: 'm_old1',
      seq: null,
      mine: false,
      kind: 'text',
      text: 'older 1',
      sender: 'Aisha from support',
      status: 'sent',
      replyTo: { serverId: 'm_old0', kind: 'text', text: 'quoted', from: 'you' },
      error: null,
    })
    expect(page.messages[0]!.sentAt).toBe(Date.UTC(2026, 8, 1, 10, 1))
    // the user's own older message keeps its tick
    expect(page.messages[1]).toMatchObject({ mine: true, status: 'read', sender: null })
  })

  it('leaves the library\'s own list alone: nothing is added, nothing is unread, no receipt is sent', async () => {
    const c = make('W-hist-list')
    await online(c)
    const before0 = c.getSnapshot()
    const frames: string[] = []
    c.on('wire', (w) => w.direction === 'out' && frames.push(String(w.frame.type)))
    answer = () => json({ messages: [row(1), row(3)], more: false })
    await c.fetchHistory({ before })
    const after = c.getSnapshot()
    expect(after.messages).toEqual(before0.messages)
    expect(after.unreadCount).toBe(0)
    expect(after.lastSeq).toBe(before0.lastSeq)
    await new Promise((r) => setTimeout(r, 120))
    expect(frames).toEqual(['history'])
  })

  it('works without the id of a message and uses the default size', async () => {
    const c = make('W-hist-noid')
    await online(c)
    await c.fetchHistory({ before: { sentAt: Date.UTC(2026, 9, 1) } })
    expect(asked[0]!.before).toEqual({ sent_at: '2026-10-01T00:00:00.000Z' })
    expect(asked[0]!.limit).toBe(30)
  })

  it('tells why there is no more', async () => {
    const c = make('W-hist-end')
    await online(c)
    answer = () => json({ messages: [row(1)], more: false, end: 'window' })
    expect(await c.fetchHistory({ before })).toMatchObject({ more: false, end: 'window' })
    answer = () => json({ messages: [row(1)], more: false })
    expect(await c.fetchHistory({ before })).toMatchObject({ more: false, end: 'start' })
    answer = () => json({ messages: [], more: false, end: 'start' })
    expect(await c.fetchHistory({ before })).toEqual({ messages: [], more: false, end: 'start' })
  })

  it('can be asked twice at once without the answers mixing', async () => {
    const c = make('W-hist-twice')
    await online(c)
    answer = async (body) => {
      if (body.before.server_id === 'm_slow') await new Promise((r) => setTimeout(r, 80))
      return json({ messages: [row(body.before.server_id === 'm_slow' ? 1 : 2)], more: false })
    }
    const [slow, fast] = await Promise.all([c.fetchHistory({ before: { sentAt: Date.UTC(2026, 9, 1), serverId: 'm_slow' } }), c.fetchHistory({ before: { sentAt: Date.UTC(2026, 9, 1), serverId: 'm_fast' } })])
    expect(slow.messages[0]!.serverId).toBe('m_old1')
    expect(fast.messages[0]!.serverId).toBe('m_old2')
  })

  describe('when it cannot', () => {
    it('refuses a cursor that is not a time before anything is sent', async () => {
      const c = make('W-hist-bad')
      await online(c)
      const err = await failure(c.fetchHistory({ before: { sentAt: Number.NaN } }))
      expect(err.code).toBe('bad_request')
      expect(asked).toHaveLength(0)
    })

    it('says bad_request when the gateway refuses the limit', async () => {
      const c = make('W-hist-limit')
      await online(c)
      expect((await failure(c.fetchHistory({ before, limit: 500 }))).code).toBe('bad_request')
      expect(asked).toHaveLength(0)
    })

    it('says history_disabled at once on a gateway that does not offer it, without waiting for a timeout', async () => {
      const c = make('W-hist-oldgw', { WebSocket: oldGatewayWS() as never })
      await online(c)
      const started = Date.now()
      expect((await failure(c.fetchHistory({ before }))).code).toBe('history_disabled')
      expect(Date.now() - started).toBeLessThan(1000)
      expect(asked).toHaveLength(0)
    })

    it('says offline when not connected', async () => {
      const c = make('W-hist-offline')
      expect((await failure(c.fetchHistory({ before }))).code).toBe('offline')
    })

    it.each([
      ['Halo is down', () => json({ error: 'x' }, 500), 'history_unavailable'],
      ['Halo has no such address', () => json({ error: 'x' }, 404), 'history_disabled'],
      ['Halo is too busy', () => json({ error: 'x' }, 429, { 'retry-after': '7' }), 'rate_limited'],
    ])('names the reason when %s', async (_name, reply, code) => {
      const c = make(`W-hist-${code}`)
      await online(c)
      answer = reply
      const err = await failure(c.fetchHistory({ before }))
      expect(err.code).toBe(code)
      if (code === 'rate_limited') expect(err.retryAfterSeconds).toBe(7)
      if (code === 'history_unavailable') expect(err.retryAfterSeconds).toBeGreaterThan(0)
      // the connection is still good
      expect(c.getSnapshot().state).toBe('online')
      answer = () => json({ messages: [row(1)], more: false })
      expect((await c.fetchHistory({ before })).messages).toHaveLength(1)
    })

    it('stops waiting when the connection drops', async () => {
      const c = make('W-hist-drop')
      await online(c)
      answer = () => new Promise<Response>(() => undefined)
      const pending = failure(c.fetchHistory({ before }))
      await vi.waitFor(() => expect(asked).toHaveLength(1))
      c.stop()
      expect((await pending).code).toBe('stopped')
    })

    it('gives up after the configured wait', async () => {
      const c = make('W-hist-slow', { historyTimeoutMs: 150 })
      await online(c)
      answer = () => new Promise<Response>(() => undefined)
      expect((await failure(c.fetchHistory({ before }))).code).toBe('timeout')
    })
  })

  describe('a file in an older message', () => {
    const photo = row(1, { kind: 'image', text: 'a photo', media: { mime_type: 'image/png', file_name: 'receipt.png', size_bytes: 128 } })

    async function pageWithPhoto(c: VircleChatClient): Promise<ChatMessage> {
      answer = () => json({ messages: [photo], more: false })
      return (await c.fetchHistory({ before })).messages[0]!
    }

    it('comes with an address that works, and is fetched from Halo when first opened', async () => {
      const c = make('W-hist-file')
      await online(c)
      const m = await pageWithPhoto(c)
      expect(m.media).toMatchObject({ mimeType: 'image/png', fileName: 'receipt.png', sizeBytes: 128 })
      expect(m.media!.fileId).toMatch(/^h_u_/)
      const url = await c.getMediaUrl(m)
      expect(url).toBe(m.media!.url)
      answer = () => json({ media: { download_url: 'https://files.example.com/a.png', kind: 'image', mime_type: 'image/png', file_name: 'receipt.png', size_bytes: 128 } })
      const res = await fetch(url)
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    })

    it('gets a fresh address, in place, when the one it came with has run out', async () => {
      const c = make('W-hist-file2')
      await online(c)
      const m = await pageWithPhoto(c)
      const old = m.media!.url
      m.media!.expiresAt = Date.now() - 1000
      const url = await c.getMediaUrl(m)
      expect(url).toContain(`/v1/files/${m.media!.fileId}?`)
      expect(m.media!.expiresAt!).toBeGreaterThan(Date.now())
      expect(typeof old).toBe('string')
      // and the library's own list never learned of it
      expect(c.getSnapshot().messages).toHaveLength(0)
    })
  })
})
