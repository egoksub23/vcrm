// Older messages for the app: the `history` frame, Halo's answer checked field by field, and files in older messages
// (docs/vircle-chat-contract.md, section 3.5; docs/vircle-chat-app-protocol.md, section 7).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { historyFileId } from '../src/history'
import { signBody } from '../src/signing'
import { connectUser, PNG, startHarness, TestClient, WORKSPACE, type Frame, type Harness } from './helpers'

interface Call {
  url: string
  headers: Record<string, string>
  raw: string
  body: Record<string, unknown>
}

let h: Harness
let halo: { calls: Call[]; answer: (call: Call) => Response | Promise<Response> }
let fileFetches: string[]
const clients: TestClient[] = []

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

beforeEach(async () => {
  halo = { calls: [], answer: () => json({ messages: [], more: false, end: 'start' }) }
  fileFetches = []
  h = await startHarness({
    history: {
      fetch: (async (url: string | URL, init?: RequestInit) => {
        const raw = String(init?.body ?? '')
        const call: Call = { url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), raw, body: JSON.parse(raw) }
        halo.calls.push(call)
        return halo.answer(call)
      }) as typeof fetch,
    },
    files: {
      fetch: (async (url: string | URL) => {
        fileFetches.push(String(url))
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } })
      }) as typeof fetch,
    },
  })
})
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await h.close()
})

const user = async (u: Parameters<typeof connectUser>[1] = {}) => {
  const out = await connectUser(h, u)
  clients.push(out.client)
  return out.client
}

/** A message the way Halo's history answer carries it. */
const row = (n: number, extra: Record<string, unknown> = {}) => ({
  server_id: `m_old${n}`,
  direction: n % 2 ? 'out' : 'in',
  kind: 'text',
  text: `older message ${n}`,
  sent_at: new Date(Date.UTC(2026, 8, 1, 10, n)).toISOString(),
  status: 'read',
  sender: { name: n % 2 ? 'Aisha from support' : null },
  reply_to: null,
  media: null,
  ...extra,
})

const ask = async (c: TestClient, extra: Record<string, unknown> = {}, id = 'r1'): Promise<Frame> => {
  c.send({ type: 'history', request_id: id, before: { sent_at: '2026-10-01T00:00:00Z', server_id: 'm_first' }, ...extra })
  // the answer is a page or an error naming the request: wait for whichever comes
  for (let i = 0; i < 500; i++) {
    const got = c.frames.find((f) => f.request_id === id && (f.type === 'history_page' || f.type === 'error'))
    if (got) return got
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no answer to ${id}`)
}

describe('asking Halo for older messages', () => {
  it('is announced in the welcome, so a client can tell a gateway that has it', async () => {
    const { client, welcome } = await connectUser(h, {})
    clients.push(client)
    expect(welcome.features).toEqual(['history'])
  })

  it('sends one signed request naming the workspace, the person and where the app stopped', async () => {
    const c = await user()
    halo.answer = () => json({ messages: [row(1), row(2), row(3)], more: true })
    const page = await ask(c, { limit: 3, not_before: '2026-08-01T00:00:00Z' })
    expect(page.type).toBe('history_page')

    expect(halo.calls).toHaveLength(1)
    const call = halo.calls[0]!
    // the same address as the webhook with the last segment replaced, and signed with the workspace's secret
    expect(call.url).toBe('https://halo.example.com/api/vircle-chat/history')
    const ts = call.headers['x-vircle-timestamp']!
    expect(call.headers['x-vircle-signature']).toBe(signBody(WORKSPACE.signingSecret, ts, call.raw))
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(10)
    expect(call.body).toMatchObject({
      v: 1,
      workspace_key: WORKSPACE.key,
      wallet_id: 'W123',
      before: { sent_at: '2026-10-01T00:00:00.000Z', server_id: 'm_first' },
      limit: 3,
      not_before: '2026-08-01T00:00:00.000Z',
    })
    expect(typeof call.body.conversation_id).toBe('string')
  })

  it('answers a page oldest first, without sequence numbers, with the fields the app draws', async () => {
    const c = await user()
    halo.answer = () =>
      json({
        messages: [
          row(3, { reply_to: { server_id: 'm_old1', kind: 'text', text: 'x'.repeat(300), from: 'support' } }),
          row(1),
          row(2, { status: 'weird' }),
        ],
        more: true,
      })
    const page = await ask(c, { limit: 30 })
    const ms = page.messages as Frame[]
    expect(ms.map((m) => m.server_id)).toEqual(['m_old1', 'm_old2', 'm_old3'])
    expect(ms[0]).toMatchObject({ type: 'deliver', seq: null, direction: 'out', kind: 'text', text: 'older message 1', status: 'read', sender: { name: 'Aisha from support' } })
    expect(ms[1]).toMatchObject({ direction: 'in', status: 'sent', sender: { name: null } }) // an unknown status reads as "sent"; the user's own message names no sender
    expect((ms[2]!.reply_to as Record<string, unknown>).text).toHaveLength(140)
    expect(page.more).toBe(true)
    expect('end' in page).toBe(false)
  })

  it('says why there is no more: the start of the conversation, or Halo\'s limit', async () => {
    const c = await user()
    halo.answer = () => json({ messages: [row(1)], more: false, end: 'window' })
    expect((await ask(c, {}, 'a')).end).toBe('window')
    halo.answer = () => json({ messages: [row(1)], more: false })
    expect((await ask(c, {}, 'b')).end).toBe('start')
    halo.answer = () => json({ messages: [], more: true }) // "more" with nothing to show cannot be believed
    const empty = await ask(c, {}, 'c')
    expect(empty).toMatchObject({ messages: [], more: false, end: 'start' })
  })

  it('works without the id of a message (the app holds none) and applies the default size', async () => {
    const c = await user()
    c.send({ type: 'history', request_id: 'r9', before: { sent_at: '2026-10-01T00:00:00Z' } })
    await c.next('history_page', (f) => f.request_id === 'r9')
    expect(halo.calls[0]!.body.before).toEqual({ sent_at: '2026-10-01T00:00:00.000Z' })
    expect(halo.calls[0]!.body.limit).toBe(30)
    expect('not_before' in halo.calls[0]!.body).toBe(false)
  })

  it('changes nothing in the gateway: no message, no sequence number, no receipt, no event for Halo', async () => {
    const c = await user()
    const subject = await h.subject('W123')
    halo.answer = () => json({ messages: [row(1), row(2)], more: false })
    await ask(c)
    const after = await h.subject('W123')
    expect(after.conversation.last_seq).toBe(subject.conversation.last_seq)
    expect(await h.gw.store.listAfter(subject.conversation.id, 0, 100)).toHaveLength(0)
    const { rows } = await h.db.query('SELECT 1 FROM outbox_events')
    expect(rows).toHaveLength(0)
  })
})

describe('a request the gateway refuses before asking Halo', () => {
  it.each([
    ['no time', { before: {} }],
    ['a time that is not one', { before: { sent_at: 'yesterday' } }],
    ['a year nobody means', { before: { sent_at: '1970-01-01T00:00:00Z' } }],
    ['a message id that is not an id', { before: { sent_at: '2026-10-01T00:00:00Z', server_id: 5 } }],
    ['a limit over 50', { limit: 51 }],
    ['a limit of zero', { limit: 0 }],
    ['a limit that is text', { limit: '30' }],
    ['a not_before that is not a time', { not_before: 'soon' }],
  ])('%s -> bad_request naming the request', async (_name, extra) => {
    const c = await user()
    const reply = await ask(c, extra, 'rx')
    expect(reply).toMatchObject({ type: 'error', code: 'bad_request', request_id: 'rx' })
    expect(halo.calls).toHaveLength(0)
  })

  it('asks Halo for at most ten pages a minute per person', async () => {
    const c = await user()
    for (let i = 0; i < 10; i++) expect((await ask(c, {}, `p${i}`)).type).toBe('history_page')
    const eleventh = await ask(c, {}, 'p10')
    expect(eleventh).toMatchObject({ type: 'error', code: 'rate_limited', request_id: 'p10' })
    expect(Number(eleventh.retry_after)).toBeGreaterThan(0)
    expect(halo.calls).toHaveLength(10)
  })
})

describe('when Halo cannot answer', () => {
  it.each([
    ['is down (500)', () => json({ error: 'x' }, 500), 'history_unavailable'],
    ['refuses the signature (401)', () => json({ error: 'Invalid signature' }, 401), 'history_unavailable'],
    ['is too busy (429, retry after 7)', () => json({ error: 'slow' }, 429, { 'retry-after': '7' }), 'rate_limited'],
    ['has no such endpoint (404)', () => json({ error: 'nope' }, 404), 'history_disabled'],
    ['answers nonsense', () => new Response('<html>oops</html>', { status: 200 }), 'history_unavailable'],
  ])('%s -> %s', async (_name, answer, code) => {
    const c = await user()
    halo.answer = answer
    const reply = await ask(c)
    expect(reply).toMatchObject({ type: 'error', code, request_id: 'r1' })
  })

  it('names the wait Halo asked for', async () => {
    const c = await user()
    halo.answer = () => json({ error: 'slow' }, 429, { 'retry-after': '7' })
    expect((await ask(c)).retry_after).toBe(7)
  })

  it('reports an unreachable Halo, and the connection stays usable', async () => {
    const c = await user()
    halo.answer = () => {
      throw new Error('socket hang up')
    }
    expect(await ask(c)).toMatchObject({ type: 'error', code: 'history_unavailable', request_id: 'r1' })
    c.send({ type: 'ping', t: 1 })
    expect((await c.next('pong')).type).toBe('pong')
  })

  it('shows an empty page for a workspace Halo has paused', async () => {
    const c = await user()
    halo.answer = () => json({ ok: true, ignored: 'paused' })
    expect(await ask(c)).toMatchObject({ type: 'history_page', messages: [], more: false, end: 'window' })
  })
})

describe('what Halo says is not believed unchecked', () => {
  it('drops a row that fails the checks and keeps the rest', async () => {
    const c = await user()
    halo.answer = () =>
      json({
        messages: [
          row(1),
          row(2, { server_id: '../../etc/passwd' }),
          row(3, { sent_at: 'not a time' }),
          row(4, { kind: 'location' }),
          row(5, { direction: 'sideways' }),
          row(6, { text: null }), // text with nothing in it
          row(1), // the same message twice
          'a string',
          null,
          row(7),
        ],
        more: false,
      })
    const page = await ask(c)
    expect((page.messages as Frame[]).map((m) => m.server_id)).toEqual(['m_old1', 'm_old7'])
  })

  it('never returns more than the page asked for', async () => {
    const c = await user()
    halo.answer = () => json({ messages: Array.from({ length: 20 }, (_v, i) => row(i + 1)), more: true })
    expect(((await ask(c, { limit: 5 })).messages as Frame[]).length).toBe(5)
  })

  it('shortens a text over the limit and turns a file with nothing behind it into a note', async () => {
    const c = await user()
    halo.answer = () => json({ messages: [row(1, { text: 'y'.repeat(9000) }), row(2, { kind: 'image', text: 'my receipt', media: null }), row(3, { kind: 'image', text: null, media: null })], more: false })
    const ms = (await ask(c)).messages as Frame[]
    expect(String(ms[0]!.text)).toHaveLength(4000)
    expect(ms[1]).toMatchObject({ kind: 'text', media: null })
    expect(String(ms[1]!.text)).toContain('my receipt')
    expect(String(ms[1]!.text)).toContain('[Attachment not available]')
    expect(ms[2]).toMatchObject({ kind: 'text', text: '[Attachment not available]' })
  })
})

describe('a file in an older message', () => {
  const photo = (n: number) => row(n, { kind: 'image', text: 'a photo', media: { mime_type: 'image/png', file_name: 'receipt.png', size_bytes: 128 } })
  const download = (kind = 'image') => json({ media: { download_url: 'https://files.example.com/a.png?token=t', kind, mime_type: 'image/png', file_name: 'receipt.png', size_bytes: 128 } })

  async function pageWithPhoto(c: TestClient) {
    halo.answer = () => json({ messages: [photo(1)], more: false })
    const page = await ask(c)
    return (page.messages as Frame[])[0]!.media as Record<string, unknown>
  }

  it('is named in the page with this gateway\'s link, and nothing is fetched yet', async () => {
    const c = await user()
    const media = await pageWithPhoto(c)
    const subject = await h.subject('W123')
    expect(media.file_id).toBe(historyFileId(subject.user.id, 'm_old1'))
    expect(String(media.url)).toContain(`/v1/files/${String(media.file_id)}?exp=`)
    expect(media).toMatchObject({ mime_type: 'image/png', file_name: 'receipt.png', size_bytes: 128 })
    expect(fileFetches).toHaveLength(0)
    expect(halo.calls).toHaveLength(1) // the page only: no request for the file
  })

  it('is fetched from Halo when the link is first opened, then served from here', async () => {
    const c = await user()
    const media = await pageWithPhoto(c)
    halo.answer = () => download()
    const first = await fetch(String(media.url))
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await first.arrayBuffer()).equals(PNG)).toBe(true)
    expect(halo.calls[1]!.body).toMatchObject({ file_for: 'm_old1', wallet_id: 'W123', workspace_key: WORKSPACE.key })
    expect(fileFetches).toEqual(['https://files.example.com/a.png?token=t'])

    const second = await fetch(String(media.url))
    expect(second.status).toBe(200)
    expect(halo.calls).toHaveLength(2) // no second trip to Halo
    expect(fileFetches).toHaveLength(1)
  })

  it('is fetched once when it is opened twice at the same moment', async () => {
    const c = await user()
    const media = await pageWithPhoto(c)
    halo.answer = async () => {
      await new Promise((r) => setTimeout(r, 50))
      return download()
    }
    const [a, b] = await Promise.all([fetch(String(media.url)), fetch(String(media.url))])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(fileFetches).toHaveLength(1)
  })

  it('answers 404 when Halo no longer has it, and 503 when Halo cannot be reached', async () => {
    const c = await user()
    const media = await pageWithPhoto(c)
    halo.answer = () => json({ error: 'not_found' }, 404)
    expect((await fetch(String(media.url))).status).toBe(404)
    halo.answer = () => json({ error: 'x' }, 500)
    const down = await fetch(String(media.url))
    expect(down.status).toBe(503)
    expect(down.headers.get('retry-after')).toBe('5')
  })

  it('is refused when what Halo sends is not a picture, or the type does not match', async () => {
    const c = await user()
    const media = await pageWithPhoto(c)
    halo.answer = () => json({ media: { download_url: 'https://files.example.com/a.png', kind: 'image', mime_type: 'image/jpeg', file_name: 'a.jpg', size_bytes: 128 } })
    // the bytes are a PNG but Halo said JPEG: the content check refuses it
    expect([400, 404, 500]).toContain((await fetch(String(media.url))).status)
  })

  it('gets a fresh link on request for the person\'s own file, never for someone else\'s', async () => {
    const c = await user()
    const media = await pageWithPhoto(c)
    c.send({ type: 'file_url', file_id: media.file_id })
    const fresh = await c.next('file_url')
    expect(String(fresh.url)).toContain(`/v1/files/${String(media.file_id)}?exp=`)

    const other = await user({ wallet_id: 'W999' })
    other.send({ type: 'file_url', file_id: media.file_id })
    expect(await other.next('error')).toMatchObject({ code: 'file_not_found' })
  })

  it('cannot be opened with a link nobody signed', async () => {
    const c = await user()
    const media = await pageWithPhoto(c)
    const forged = String(media.url).replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64))
    expect((await fetch(forged)).status).toBe(401)
    expect(halo.calls).toHaveLength(1)
  })
})
