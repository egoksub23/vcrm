// The client library against the REAL gateway (in-process Postgres, a real WebSocket server), not against a stand-in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { VircleChatClient, memoryStore, type ClientOptions, type ChatMessage, type ChatStore } from '../src'
import { allowLocalFetch, JPEG, OGG, PNG, startFileServer, startHarness, WORKSPACE, type FileServer, type Harness } from '../../test/helpers'

let h: Harness
let clients: VircleChatClient[] = []
let sessions = 0
let halo: { status: number; hits: Record<string, any>[] }
let fileServer: FileServer | null = null

const FAST = { minMs: 20, maxMs: 80, factor: 2, jitter: 0 }

async function start(opts: Parameters<typeof startHarness>[0] = {}) {
  halo = { status: 200, hits: [] }
  h = await startHarness({
    cfg: allowLocalFetch(),
    dispatcher: {
      fetch: (async (_url: string, init: RequestInit) => {
        halo.hits.push(JSON.parse(String(init.body)))
        return new Response('{"ok":true}', { status: halo.status })
      }) as unknown as typeof fetch,
      log: () => undefined,
    },
    ...opts,
  })
}

/** A client wired to the harness: a fresh session from the gateway before every connection, as the app's backend would give. */
function make(wallet: string, extra: Partial<ClientOptions> = {}): VircleChatClient {
  const c = new VircleChatClient({
    deviceId: `dev-${wallet}`,
    baseUrl: h.url,
    WebSocket: WebSocket as never,
    getSession: async () => {
      sessions++
      const s = await h.session({ wallet_id: wallet, name: 'Aisha', phone: '+60123456789' })
      return { token: s.token, wsPath: '/ws' }
    },
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
const texts = (c: VircleChatClient) => c.getSnapshot().messages.map((m) => m.text)
const fromHalo = async (wallet: string, text: string, extra: Record<string, unknown> = {}) => {
  const res = await fetch(`${h.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${WORKSPACE.apiToken}`, 'content-type': 'application/json', 'idempotency-key': `k-${Math.random()}` },
    body: JSON.stringify({ recipient: { wallet_id: wallet, name: 'Aisha', phone: '+60123456789' }, type: 'text', text, sender: { name: 'Support' }, ...extra }),
  })
  expect(res.status).toBe(202)
  return (await res.json()) as { server_id: string; seq: number }
}
const haloCall = (path: string, body: unknown) =>
  fetch(`${h.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${WORKSPACE.apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** A WebSocket that hides the frames a test chooses from the client, as a flaky network might. */
function filteredWS(hide: (frame: { type?: string }) => boolean): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string) {
      super(url)
      const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!
      Object.defineProperty(this, 'onmessage', {
        configurable: true,
        get: () => desc.get!.call(this),
        set: (fn: ((ev: { data: unknown }) => void) | null) =>
          desc.set!.call(this, fn ? (ev: { data: unknown }) => (hide(JSON.parse(String(ev.data))) ? undefined : fn(ev)) : fn),
      })
    }
  } as unknown as typeof WebSocket
}
const settled = expect.stringMatching(/^(sent|delivered|read)$/)
const png = () => ({ blob: new Blob([PNG], { type: 'image/png' }), name: 'shot.png' })

beforeEach(async () => {
  sessions = 0
  clients = []
  await start()
})
afterEach(async () => {
  clients.forEach((c) => c.stop())
  await fileServer?.close()
  fileServer = null
  await h.close()
})

describe('connecting', () => {
  it('goes from idle to connecting to online, learns the limits and the conversation, and reports it loaded', async () => {
    const c = make('W-conn')
    const states: string[] = []
    c.on('state', (s) => states.push(s))
    expect(c.getSnapshot().state).toBe('idle')
    await online(c)
    await vi.waitFor(() => expect(c.getSnapshot().loaded).toBe(true))
    expect(states).toEqual(['connecting', 'online'])
    expect(c.getSnapshot()).toMatchObject({ limits: { textMax: 4000, captionMax: 1024, fileMaxBytes: 16 * 1024 * 1024 }, conversationId: expect.stringMatching(/^c_/), lastSeq: 0, lastError: null })
  })

  it('tells subscribers once per turn however many things changed, and hands out a new snapshot object only when something changed', async () => {
    const c = make('W-snap')
    const calls = vi.fn()
    c.subscribe(calls)
    const a = c.getSnapshot()
    expect(c.getSnapshot()).toBe(a)
    await online(c)
    expect(calls.mock.calls.length).toBeGreaterThan(0)
    expect(c.getSnapshot()).not.toBe(a)
    const b = c.getSnapshot()
    expect(c.getSnapshot()).toBe(b)
  })

  it('shows what support already wrote, in order, and keeps the highest number', async () => {
    await fromHalo('W-hist', 'one')
    await fromHalo('W-hist', 'two')
    await fromHalo('W-hist', 'three')
    const c = make('W-hist')
    await online(c)
    await vi.waitFor(() => expect(texts(c)).toEqual(['one', 'two', 'three']))
    expect(c.getSnapshot().messages.map((m) => [m.seq, m.mine, m.sender, m.status])).toEqual([[1, false, 'Support', 'sent'], [2, false, 'Support', 'sent'], [3, false, 'Support', 'sent']])
    expect(c.getSnapshot().lastSeq).toBe(3)
  })

  it('shows a message that arrives while the screen is open, once', async () => {
    const c = make('W-live')
    await online(c)
    const seen: string[] = []
    c.on('message', ({ message, change }) => seen.push(`${change}:${message.text}`))
    await fromHalo('W-live', 'hello there')
    await vi.waitFor(() => expect(texts(c)).toEqual(['hello there']))
    expect(seen).toEqual(['added:hello there'])
  })

  it('a second client on the same store takes up where the first left off, asking only for what it missed', async () => {
    const store = memoryStore()
    await fromHalo('W-resume', 'before')
    const first = make('W-resume', { store })
    await online(first)
    await vi.waitFor(() => expect(texts(first)).toEqual(['before']))
    first.stop()
    await fromHalo('W-resume', 'while away')

    const wire: Record<string, unknown>[] = []
    const second = make('W-resume', { store })
    second.on('wire', ({ direction, frame }) => direction === 'in' && wire.push(frame))
    await second.start()
    // the kept history is on screen before the connection is up
    expect(texts(second)).toEqual(['before'])
    await vi.waitFor(() => expect(texts(second)).toEqual(['before', 'while away']))
    expect(wire.filter((f) => f.type === 'deliver')).toHaveLength(1)
  })
})

describe('staying connected', () => {
  it('reconnects after the gateway restarts, and fetches the messages sent in the gap', async () => {
    const c = make('W-restart')
    await online(c)
    h.gw.hub.closeAll(1012, 'service restart')
    await vi.waitFor(() => expect(c.getSnapshot().state).not.toBe('online'), { timeout: 2000, interval: 5 }).catch(() => undefined)
    await fromHalo('W-restart', 'sent in the gap')
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('online'), { timeout: 5000, interval: 10 })
    await vi.waitFor(() => expect(texts(c)).toEqual(['sent in the gap']))
    expect(sessions).toBeGreaterThanOrEqual(2)
  })

  it('keeps trying while the session cannot be had, shows why, and connects once it can', async () => {
    let failures = 2
    const c = make('W-session', {
      getSession: async () => {
        if (failures-- > 0) throw new Error('backend is down')
        const s = await h.session({ wallet_id: 'W-session' })
        return { token: s.token, wsPath: '/ws' }
      },
    })
    await c.start()
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('offline'))
    expect(c.getSnapshot()).toMatchObject({ lastError: { code: 'session_failed', message: 'backend is down' }, nextAttemptAt: expect.any(Number) })
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('online'), { timeout: 5000, interval: 10 })
    expect(c.getSnapshot().lastError).toBeNull()
  })

  it('asks for a new session when the token is refused', async () => {
    let first = true
    const c = make('W-refused', {
      getSession: async () => {
        if (first) {
          first = false
          return { token: 'vcs_not_a_real_token', wsPath: '/ws' }
        }
        const s = await h.session({ wallet_id: 'W-refused' })
        return { token: s.token, wsPath: '/ws' }
      },
    })
    await online(c)
    expect(first).toBe(false)
  })

  it('waits the scheduled time, but connects at once on reconnectNow()', async () => {
    let up = false
    const c = make('W-now', {
      backoff: { minMs: 60_000, maxMs: 60_000, factor: 1, jitter: 0 },
      getSession: async () => {
        if (!up) throw new Error('no network')
        const s = await h.session({ wallet_id: 'W-now' })
        return { token: s.token, wsPath: '/ws' }
      },
    })
    await c.start()
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('offline'))
    up = true
    c.reconnectNow()
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('online'), { timeout: 3000, interval: 10 })
  })

  it('stops for good when another connection of the same device takes over, and does not fight', async () => {
    const a = make('W-twin', { deviceId: 'the-same-device' })
    await online(a)
    const b = make('W-twin', { deviceId: 'the-same-device' })
    await online(b)
    await vi.waitFor(() => expect(a.getSnapshot().state).toBe('replaced'), { timeout: 3000, interval: 10 })
    expect(a.getSnapshot().lastError?.code).toBe('replaced')
    const sessionsBefore = sessions
    await new Promise((r) => setTimeout(r, 300))
    expect(sessions).toBe(sessionsBefore) // no reconnect attempts
    expect(b.getSnapshot().state).toBe('online')
  })

  it('does not reconnect after stop(), and starts again with start()', async () => {
    const c = make('W-stop')
    await online(c)
    c.stop()
    expect(c.getSnapshot().state).toBe('stopped')
    const n = sessions
    await new Promise((r) => setTimeout(r, 200))
    expect(sessions).toBe(n)
    await online(c)
    expect(c.getSnapshot().state).toBe('online')
  })
})

describe('sending text', () => {
  it('shows the message at once as sending, then as sent with its place in the conversation', async () => {
    const c = make('W-send')
    await online(c)
    const states: string[] = []
    c.on('message', ({ message }) => states.push(message.status))
    const p = c.sendText('  hello support  ')
    const [mine] = c.getSnapshot().messages
    expect(mine).toMatchObject({ mine: true, text: 'hello support', status: 'sending', seq: null, serverId: null })
    const stored = await p
    expect(stored).toMatchObject({ status: settled, seq: 1, serverId: expect.stringMatching(/^m_/), id: mine!.id })
    expect(states).toContain('sent')
    expect(c.getSnapshot().messages).toHaveLength(1)
    const s = await h.subject('W-send')
    expect((await h.gw.store.listAfter(s.conversation.id, 0, 5)).map((m) => m.text)).toEqual(['hello support'])
  })

  it('refuses an empty or over-long message before sending anything', async () => {
    const c = make('W-bad')
    await online(c)
    await expect(c.sendText('   ')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(c.sendText('x'.repeat(4001))).rejects.toMatchObject({ code: 'message_too_long' })
    expect(c.getSnapshot().messages).toEqual([])
  })

  it('holds messages written offline and sends them in order when the connection comes', async () => {
    let up = false
    const c = make('W-offline', {
      getSession: async () => {
        if (!up) throw new Error('no network')
        const s = await h.session({ wallet_id: 'W-offline' })
        return { token: s.token, wsPath: '/ws' }
      },
    })
    await c.start()
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('offline'))
    const sent = [c.sendText('first'), c.sendText('second'), c.sendText('third')]
    expect(c.getSnapshot().messages.map((m) => m.status)).toEqual(['sending', 'sending', 'sending'])
    up = true
    c.reconnectNow()
    const done = await Promise.all(sent)
    expect(done.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(texts(c)).toEqual(['first', 'second', 'third'])
  })

  it('sends a message written before the app was closed, once, after the next launch', async () => {
    const store = memoryStore()
    let up = false
    const session = async () => {
      if (!up) throw new Error('no network')
      const s = await h.session({ wallet_id: 'W-relaunch' })
      return { token: s.token, wsPath: '/ws' }
    }
    const first = make('W-relaunch', { store, getSession: session })
    await first.start()
    await vi.waitFor(() => expect(first.getSnapshot().state).toBe('offline'))
    void first.sendText('written offline').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 400)) // the store writes shortly after
    first.stop()

    up = true
    const second = make('W-relaunch', { store, getSession: session })
    await second.start()
    expect(second.getSnapshot().messages).toMatchObject([{ text: 'written offline', status: 'sending', mine: true }])
    await vi.waitFor(() => expect(second.getSnapshot().messages[0]?.status).toMatch(/^(sent|delivered)$/), { timeout: 5000, interval: 10 })
    const s = await h.subject('W-relaunch')
    expect((await h.gw.store.listAfter(s.conversation.id, 0, 5)).map((m) => m.text)).toEqual(['written offline'])
  })

  it('does not store a message twice when the acknowledgement was lost and the app sends it again', async () => {
    let dropAcks = true
    const LossyWS = filteredWS((f) => dropAcks && f.type === 'ack')
    const c = make('W-lost-ack', { WebSocket: LossyWS as never })
    await online(c)
    const p = c.sendText('did this arrive?')
    const s = await h.subject('W-lost-ack')
    await vi.waitFor(async () => expect(await h.gw.store.listAfter(s.conversation.id, 0, 5)).toHaveLength(1))
    expect(c.getSnapshot().messages[0]?.status).toBe('sending') // the app never heard
    dropAcks = false
    h.gw.hub.closeAll(1012, 'restart') // the connection goes; on the next one the app sends it again with the same id
    const stored = await p
    expect(stored.status).toMatch(/^(sent|delivered)$/)
    expect(await h.gw.store.listAfter(s.conversation.id, 0, 5)).toHaveLength(1)
    expect(c.getSnapshot().messages).toHaveLength(1)
  })

  it('sends faster than the gateway allows, and every message still gets through, after the wait it named', async () => {
    await h.close()
    await start({ cfg: { ...allowLocalFetch(), sendRateLimit: { limit: 2, windowMs: 1000 } } })
    const c = make('W-fast')
    await online(c)
    const done = await Promise.all(['a', 'b', 'c', 'd'].map((t) => c.sendText(t)))
    expect(done.map((m) => m.text)).toEqual(['a', 'b', 'c', 'd'])
    expect(done.every((m) => m.status === 'sent' || m.status === 'delivered')).toBe(true)
  })

  it('quotes a message of support\'s, and shows a quote that support sends', async () => {
    const c = make('W-quote')
    await online(c)
    const asked = await fromHalo('W-quote', 'Which account?')
    await vi.waitFor(() => expect(texts(c)).toEqual(['Which account?']))
    const question = c.getSnapshot().messages[0]!
    const mine = await c.sendText('The savings one', { replyTo: question })
    expect(mine.replyTo).toEqual({ serverId: asked.server_id, kind: 'text', text: 'Which account?', from: 'support' })
    await fromHalo('W-quote', 'Done', { reply_to_server_id: mine.serverId })
    await vi.waitFor(() => expect(c.getSnapshot().messages.at(-1)?.replyTo).toMatchObject({ text: 'The savings one', from: 'you' }))
    await vi.waitFor(() => expect(halo.hits.find((e) => e.event === 'message.inbound')?.message.reply_to_server_id).toBe(asked.server_id))
  })
})

describe('ticks', () => {
  it('tells the gateway every message from support arrived, and not that it was read while the screen is closed', async () => {
    const c = make('W-ack')
    await online(c)
    const m = await fromHalo('W-ack', 'please read')
    const s = await h.subject('W-ack')
    await vi.waitFor(async () => expect((await h.gw.store.getMessage(m.server_id))?.status).toBe('delivered'))
    await new Promise((r) => setTimeout(r, 150))
    expect((await h.gw.store.getMessage(m.server_id))?.status).toBe('delivered')
    expect(s.user.wallet_id).toBe('W-ack')
  })

  it('reports "read" while the chat screen is open, and when it is opened later', async () => {
    const c = make('W-read-screen')
    await online(c)
    c.setScreenOpen(true)
    const a = await fromHalo('W-read-screen', 'while open')
    await vi.waitFor(async () => expect((await h.gw.store.getMessage(a.server_id))?.status).toBe('read'))
    c.setScreenOpen(false)
    const b = await fromHalo('W-read-screen', 'while closed')
    await vi.waitFor(async () => expect((await h.gw.store.getMessage(b.server_id))?.status).toBe('delivered'))
    c.setScreenOpen(true)
    await vi.waitFor(async () => expect((await h.gw.store.getMessage(b.server_id))?.status).toBe('read'))
  })

  it('does not acknowledge when told not to', async () => {
    const c = make('W-noack', { autoAcknowledge: false })
    await online(c)
    const m = await fromHalo('W-noack', 'quiet')
    await vi.waitFor(() => expect(texts(c)).toEqual(['quiet']))
    await new Promise((r) => setTimeout(r, 200))
    expect((await h.gw.store.getMessage(m.server_id))?.status).toBe('sent')
  })

  it('moves the user\'s own message from sent to delivered once Halo has it, and to read when an agent reads it', async () => {
    const c = make('W-own-ticks')
    await online(c)
    const mine = await c.sendText('is anybody there')
    await vi.waitFor(() => expect(c.getSnapshot().messages[0]?.status).toBe('delivered'), { timeout: 5000, interval: 10 })
    const res = await haloCall('/v1/receipts', { recipient: { wallet_id: 'W-own-ticks' }, status: 'read', server_ids: [mine.serverId] })
    expect(await res.json()).toEqual({ updated: 1 })
    await vi.waitFor(() => expect(c.getSnapshot().messages[0]?.status).toBe('read'))
  })

  it('shows the ticks of an old message the app was not connected for: the status is in the replay', async () => {
    const store = memoryStore()
    const a = make('W-ticks-replay', { store })
    await online(a)
    const mine = await a.sendText('read me later')
    await vi.waitFor(() => expect(a.getSnapshot().messages[0]?.status).toBe('delivered'))
    a.stop()
    await haloCall('/v1/receipts', { recipient: { wallet_id: 'W-ticks-replay' }, status: 'read', server_ids: [mine.serverId] })
    const b = make('W-ticks-replay', { store })
    await online(b)
    await vi.waitFor(() => expect(b.getSnapshot().messages[0]?.status).toBe('read'))
    expect(b.getSnapshot().messages).toHaveLength(1)
  })
})

describe('typing', () => {
  it('sends the user\'s typing at most every 2.5 seconds', async () => {
    let t = 1_000_000
    const c = make('W-typing', { now: () => t })
    await online(c)
    const out: string[] = []
    c.on('wire', ({ direction, frame }) => direction === 'out' && frame.type === 'typing' && out.push('typing'))
    for (let i = 0; i < 10; i++) c.typing()
    expect(out).toHaveLength(1)
    t += 2600
    c.typing()
    expect(out).toHaveLength(2)
    await vi.waitFor(() => expect(halo.hits.filter((e) => e.event === 'user.typing').length).toBeGreaterThan(0))
  })

  it('shows support typing, and clears it when the answer arrives', async () => {
    const c = make('W-typing-in')
    await online(c)
    const seen: boolean[] = []
    c.on('typing', (on) => seen.push(on))
    await haloCall('/v1/typing', { recipient: { wallet_id: 'W-typing-in' } })
    await vi.waitFor(() => expect(c.getSnapshot().supportTyping).toBe(true))
    await fromHalo('W-typing-in', 'here is the answer')
    await vi.waitFor(() => expect(c.getSnapshot().supportTyping).toBe(false))
    expect(seen).toEqual([true, false])
  })

  it('does not send while offline', async () => {
    const c = make('W-typing-off', { getSession: async () => { throw new Error('down') } })
    await c.start()
    const out: unknown[] = []
    c.on('wire', ({ direction }) => direction === 'out' && out.push(1))
    c.typing()
    expect(out).toEqual([])
  })
})

describe('files', () => {
  it('uploads a photo, shows it at once, and sends the message when the file is up', async () => {
    const c = make('W-photo')
    await online(c)
    const p = c.sendFile(png(), { caption: 'my receipt' })
    const shown = c.getSnapshot().messages[0]!
    expect(shown).toMatchObject({ kind: 'image', text: 'my receipt', status: 'sending', media: { mimeType: 'image/png', fileName: 'shot.png', sizeBytes: PNG.length, fileId: null } })
    const stored = await p
    expect(stored).toMatchObject({ status: settled, seq: 1, media: { fileId: expect.stringMatching(/^f_/) } })
    await vi.waitFor(() => expect(halo.hits.find((e) => e.event === 'message.inbound')).toBeDefined())
    const event = halo.hits.find((e) => e.event === 'message.inbound')!
    expect(event.message).toMatchObject({ type: 'image', text: 'my receipt', media: { mime_type: 'image/png', file_name: 'shot.png', size_bytes: PNG.length } })
    expect(Buffer.from(await (await fetch(event.message.media.url)).arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('sends a voice note with its length', async () => {
    const c = make('W-voice')
    await online(c)
    const stored = await c.sendFile({ blob: new Blob([OGG], { type: 'audio/ogg' }), name: 'note.ogg' }, { durationSeconds: 12.4 })
    expect(stored.kind).toBe('audio')
    expect(stored.media?.durationSeconds).toBe(12)
    await vi.waitFor(() => expect(halo.hits.find((e) => e.event === 'message.inbound')?.message.media.duration_seconds).toBe(12))
  })

  it('refuses before uploading: a type that is not allowed, an empty file, too large a file, a voice note over five minutes, a long caption', async () => {
    await h.close()
    await start({ cfg: { ...allowLocalFetch(), limits: { textMax: 4000, captionMax: 20, fileMaxBytes: 500 } } })
    const c = make('W-refuse-file')
    await online(c)
    const blob = (type: string, bytes = 100) => ({ blob: new Blob([Buffer.alloc(bytes, 1)], { type }), name: 'f' })
    await expect(c.sendFile(blob('image/gif'))).rejects.toMatchObject({ code: 'file_type_not_allowed' })
    await expect(c.sendFile({ blob: new Blob([], { type: 'image/png' }) })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(c.sendFile(blob('image/png', 501))).rejects.toMatchObject({ code: 'file_too_large' })
    await expect(c.sendFile(blob('audio/ogg'), { durationSeconds: 301 })).rejects.toMatchObject({ code: 'file_too_large' })
    await expect(c.sendFile(blob('image/png'), { caption: 'x'.repeat(21) })).rejects.toMatchObject({ code: 'message_too_long' })
    expect(c.getSnapshot().messages).toEqual([])
  })

  it('marks a file the gateway refuses as failed, with the reason, and lets it be discarded', async () => {
    const c = make('W-fake-png')
    await online(c)
    const fake = { blob: new Blob([Buffer.from('<html>not an image</html>'.padEnd(130, ' '))], { type: 'image/png' }), name: 'fake.png' }
    await expect(c.sendFile(fake)).rejects.toMatchObject({ code: 'file_type_not_allowed' })
    const m = c.getSnapshot().messages[0]!
    expect(m).toMatchObject({ status: 'failed', error: { code: 'file_type_not_allowed' } })
    c.discard(m.id)
    expect(c.getSnapshot().messages).toEqual([])
  })

  it('waits for the connection, uploads, and then sends', async () => {
    let up = false
    const c = make('W-photo-off', {
      getSession: async () => {
        if (!up) throw new Error('no network')
        const s = await h.session({ wallet_id: 'W-photo-off' })
        return { token: s.token, wsPath: '/ws' }
      },
    })
    await c.start()
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('offline'))
    const p = c.sendFile({ blob: new Blob([JPEG], { type: 'image/jpeg' }), name: 'late.jpg' })
    up = true
    c.reconnectNow()
    expect((await p).status).toMatch(/^(sent|delivered)$/)
  })

  it('shows a file support sends, and asks for a new link when the one it has has expired', async () => {
    fileServer = await startFileServer({ '/form.png': { type: 'image/png', body: PNG } })
    const c = make('W-from-support')
    await online(c)
    await fromHalo('W-from-support', 'the form', { type: 'image', media: { url: fileServer.url('/form.png'), mime_type: 'image/png', file_name: 'form.png', size_bytes: PNG.length } })
    await vi.waitFor(() => expect(c.getSnapshot().messages).toHaveLength(1))
    const m = c.getSnapshot().messages[0]!
    expect(m).toMatchObject({ mine: false, kind: 'image', text: 'the form', media: { mimeType: 'image/png', fileName: 'form.png', url: expect.stringContaining('/v1/files/') } })
    const url = await c.getMediaUrl(m.id)
    expect(url).toBe(m.media!.url) // still good: no request
    expect(Buffer.from(await (await fetch(url)).arrayBuffer()).equals(PNG)).toBe(true)

    m.media!.expiresAt = Date.now() - 1000 // expired
    const fresh = await c.getMediaUrl(m.id)
    expect(fresh).toContain('/v1/files/')
    expect(m.media!.expiresAt).toBeGreaterThan(Date.now())
    expect((await fetch(fresh)).status).toBe(200)
  })

  it('has no link to give for a message without a file, or a file that is still being uploaded', async () => {
    const c = make('W-nolink')
    await online(c)
    const t = await c.sendText('plain')
    await expect(c.getMediaUrl(t.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(c.getMediaUrl('nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('keeping the connection honest', () => {
  it('closes a connection that stops answering its pings, and connects again', async () => {
    await h.close()
    await start({ cfg: { ...allowLocalFetch(), heartbeatSeconds: 1 } })
    let mute = true
    const DeafWS = filteredWS((f) => mute && f.type === 'pong')
    const c = make('W-deaf', { WebSocket: DeafWS as never, pongTimeoutMs: 300 })
    await online(c)
    const before = sessions
    await vi.waitFor(() => expect(sessions).toBeGreaterThan(before), { timeout: 6000, interval: 50 })
    mute = false
    await vi.waitFor(() => expect(c.getSnapshot().state).toBe('online'), { timeout: 6000, interval: 20 })
    // and it is useful again
    await expect(c.sendText('back')).resolves.toMatchObject({ status: settled })
  })

  it('can be told to delay or swallow what it sends (for the simulator\'s fault buttons)', async () => {
    let swallow = true
    const c = make('W-swallow', { interceptSend: (f) => (swallow && f.type === 'receipt' ? 'drop' : 'send') })
    await online(c)
    const m = await fromHalo('W-swallow', 'no tick please')
    await vi.waitFor(() => expect(texts(c)).toEqual(['no tick please']))
    await new Promise((r) => setTimeout(r, 200))
    expect((await h.gw.store.getMessage(m.server_id))?.status).toBe('sent')
    swallow = false
  })
})

describe('keeping things on the device', () => {
  it('keeps the conversation without the pending and failed ones, and forgets it on request', async () => {
    const store: ChatStore = memoryStore()
    const c = make('W-keep', { store })
    await online(c)
    await fromHalo('W-keep', 'kept')
    await vi.waitFor(() => expect(texts(c)).toEqual(['kept']))
    await new Promise((r) => setTimeout(r, 450))
    const saved = await store.load()
    expect(saved).toMatchObject({ v: 1, lastSeq: 1, conversationId: expect.stringMatching(/^c_/), messages: [{ text: 'kept' }], pending: [] })
    await c.clearLocal()
    expect(await store.load()).toBeNull()
    expect(c.getSnapshot()).toMatchObject({ messages: [], lastSeq: 0, loaded: false })
  })

  it('starts the conversation again if the stored one is not the user\'s', async () => {
    const store = memoryStore()
    await store.save({ v: 1, conversationId: 'c_someone_else', lastSeq: 40, pending: [], messages: [{ id: 'm_old', serverId: 'm_old', seq: 40, mine: false, kind: 'text', text: 'stale', media: null, replyTo: null, sender: 'Support', sentAt: 1, status: 'sent', error: null } as ChatMessage] })
    await fromHalo('W-other-user', 'fresh')
    const c = make('W-other-user', { store })
    await online(c)
    await vi.waitFor(() => expect(texts(c)).toEqual(['fresh']))
    expect(c.getSnapshot().conversationId).not.toBe('c_someone_else')
  })
})
