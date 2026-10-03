import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLaunchToken as haloToken } from '../../src/lib/vircle-chat/simulator'
import { createLaunchToken, LAUNCH_TOKEN_TTL_SECONDS, peekWorkspaceKey, verifyLaunchToken } from '../src/simulator/token'
import { PNG, startHarness, TestClient, WORKSPACE, type Harness } from './helpers'

const SECRET = WORKSPACE.signingSecret
const KEY = WORKSPACE.key

describe('launch tokens', () => {
  it('verify with the secret they were signed with, and not with another', () => {
    const t = createLaunchToken(SECRET, KEY)
    expect(verifyLaunchToken(SECRET, t)).toMatchObject({ ok: true, claims: { key: KEY } })
    expect(verifyLaunchToken('another secret', t)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(peekWorkspaceKey(t)).toBe(KEY)
  })

  it('live five minutes: valid at the edge, expired after, and a token that claims a long life is refused', () => {
    const now = 1_800_000_000
    const t = createLaunchToken(SECRET, KEY, now)
    expect(verifyLaunchToken(SECRET, t, now + LAUNCH_TOKEN_TTL_SECONDS - 1).ok).toBe(true)
    expect(verifyLaunchToken(SECRET, t, now + LAUNCH_TOKEN_TTL_SECONDS)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyLaunchToken(SECRET, createLaunchToken(SECRET, KEY, now + 3600), now)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuse a tampered payload, a missing part and junk, without throwing', () => {
    const t = createLaunchToken(SECRET, KEY)
    const [payload, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ k: 'vcw_someoneelse0000000000', exp: 9_999_999_999, n: 'x' })).toString('base64url')
    expect(verifyLaunchToken(SECRET, `${forged}.${sig}`).ok).toBe(false)
    for (const junk of ['', 'abc', `${payload}`, `${payload}.${sig}.extra`, '..', 'bm90IGpzb24.deadbeef']) {
      expect(verifyLaunchToken(SECRET, junk).ok).toBe(false)
    }
    expect(peekWorkspaceKey('garbage')).toBeNull()
  })

  it('are the same as the ones Halo makes', () => {
    expect(verifyLaunchToken(SECRET, haloToken(SECRET, KEY))).toMatchObject({ ok: true, claims: { key: KEY } })
  })
})

let h: Harness
const clients: TestClient[] = []

beforeEach(async () => {
  h = await startHarness({ cfg: { simulator: { enabled: true } } })
})
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await h.close()
})

async function login(token = createLaunchToken(SECRET, KEY)) {
  const res = await fetch(`${h.url}/simulator/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  return { res, body: (await res.json()) as { session?: string; workspace?: { key: string; name: string }; error?: { message: string } } }
}
async function api(session: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${h.url}/simulator/api${path}`, {
    method,
    headers: { 'x-sim-session': session, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
async function loggedIn() {
  const { body } = await login()
  return body.session!
}
/** Open a test user's app, as the page does: a connect token from the simulator, then hello. */
async function openApp(s: string, wallet: string) {
  const { body } = await api(s, '/connect-token', 'POST', { wallet_id: wallet })
  const client = await TestClient.connect(h.gw.port, body.ws_path)
  clients.push(client)
  client.hello(body.token)
  await client.next('welcome')
  return client
}

describe('the page', () => {
  it('serves the page and its script and styles, with a policy that allows only its own script', async () => {
    for (const [path, type] of [['/simulator', 'text/html'], ['/simulator/app.js', 'text/javascript'], ['/simulator/client.js', 'text/javascript'], ['/simulator/app.css', 'text/css']] as const) {
      const res = await fetch(`${h.url}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(type)
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect((await res.text()).length).toBeGreaterThan(200)
    }
  })

  it('is not there when the simulator is switched off', async () => {
    await h.close()
    h = await startHarness()
    expect((await fetch(`${h.url}/simulator`)).status).toBe(404)
    expect((await fetch(`${h.url}/simulator/api/config`)).status).toBe(404)
  })
})

describe('logging in', () => {
  it('gives a session for a valid launch token, and names the workspace', async () => {
    const { res, body } = await login()
    expect(res.status).toBe(200)
    expect(body.workspace).toEqual({ key: KEY, name: 'Vircle' })
    expect((await api(body.session!, '/config')).status).toBe(200)
  })

  it('accepts a token once', async () => {
    const t = createLaunchToken(SECRET, KEY)
    expect((await login(t)).res.status).toBe(200)
    expect((await login(t)).res.status).toBe(401)
  })

  it('refuses an expired token, one signed with the wrong secret, and one for an unknown workspace, all with the same answer', async () => {
    const answers: (string | undefined)[] = []
    for (const t of [
      createLaunchToken(SECRET, KEY, Math.floor(Date.now() / 1000) - 3600),
      createLaunchToken('wrong secret', KEY),
      createLaunchToken(SECRET, 'vcw_doesnotexist00000000'),
      'junk',
    ]) {
      const { res, body } = await login(t)
      expect(res.status).toBe(401)
      answers.push(body.error?.message)
    }
    expect(new Set(answers).size).toBe(1)
  })

  it('needs the session header on every other call', async () => {
    for (const session of ['', 'nope']) {
      expect((await api(session, '/users')).status).toBe(401)
      expect((await api(session, '/users', 'POST', {})).status).toBe(401)
    }
  })
})

describe('test users', () => {
  it('are created flagged as simulated, with a visible name, a phone and an email', async () => {
    const s = await loggedIn()
    const { status, body } = await api(s, '/users', 'POST', { name: 'Aisha' })
    expect(status).toBe(201)
    expect(body).toMatchObject({ wallet_id: expect.stringMatching(/^sim_[0-9a-f]{8}$/), name: 'Aisha (sim)', phone: expect.stringMatching(/^\+6012/), email: expect.stringContaining('@sim.example.com') })
    const subject = await h.subject(body.wallet_id)
    expect(subject.user.simulated).toBe(true)
    expect((await api(s, '/users')).body.users).toHaveLength(1)
  })

  it('cannot reach a real user, by any call', async () => {
    const s = await loggedIn()
    await h.session({ wallet_id: 'W-real', name: 'Real Customer' }) // made the normal way, not simulated
    for (const [path, method, body] of [
      ['/connect-token', 'POST', { wallet_id: 'W-real' }],
      ['/agent-message', 'POST', { wallet_id: 'W-real', text: 'hi' }],
      ['/push?wallet_id=W-real', 'GET', undefined],
      ['/messages?wallet_id=W-real', 'GET', undefined],
    ] as const) {
      expect((await api(s, path, method, body)).status).toBe(404)
    }
    expect((await h.subject('W-real')).conversation.last_seq).toBe(0)
  })

  it('"forget" removes the simulator users and leaves real users alone', async () => {
    const s = await loggedIn()
    await api(s, '/users', 'POST', {})
    await h.session({ wallet_id: 'W-real2' })
    expect((await api(s, '/reset', 'POST', {})).body.removed).toBe(1)
    expect((await api(s, '/users')).body.users).toEqual([])
    expect((await h.subject('W-real2')).user.wallet_id).toBe('W-real2')
  })
})

describe('chatting through the simulator', () => {
  const simUser = async (s: string) => (await api(s, '/users', 'POST', { name: 'Chat' })).body as { wallet_id: string; phone: string }

  it('an agent message reaches an open app; one to a closed app raises a push on the simulator mock, never the real adapter', async () => {
    const s = await loggedIn()
    const u = await simUser(s)
    const closed = await api(s, '/agent-message', 'POST', { wallet_id: u.wallet_id, text: 'anyone there?' })
    expect(closed.status).toBe(202)
    expect(closed.body.delivery).toBe('push')
    expect(h.push.sent).toEqual([]) // the real (here: the harness) adapter was not used
    const pushes = (await api(s, `/push?wallet_id=${u.wallet_id}`)).body
    expect(pushes.alerts).toHaveLength(1)
    expect(pushes.alerts[0]).toMatchObject({ title: 'Vircle', body: 'You have a new message', phone: u.phone, result: 'sent' })

    const client = await openApp(s, u.wallet_id)
    client.send({ type: 'resume', last_seq: 0 })
    expect((await client.next('deliver')).text).toBe('anyone there?')
    const open = await api(s, '/agent-message', 'POST', { wallet_id: u.wallet_id, text: 'and now?' })
    expect(open.body.delivery).toBe('socket')
    expect((await client.next('deliver')).text).toBe('and now?')
  })

  it('shows the agent each message with the status the app reported', async () => {
    const s = await loggedIn()
    const u = await simUser(s)
    const client = await openApp(s, u.wallet_id)
    const sent = await api(s, '/agent-message', 'POST', { wallet_id: u.wallet_id, text: 'status check' })
    await client.next('deliver')
    client.send({ type: 'receipt', up_to_seq: sent.body.seq, status: 'read' })
    await vi.waitFor(async () => {
      const m = (await api(s, `/messages?wallet_id=${u.wallet_id}`)).body.messages as { status: string; delivery: string }[]
      expect(m[0]).toMatchObject({ status: 'read', delivery: 'socket' })
    })
  })

  it('refuses an empty or over-long agent message', async () => {
    const s = await loggedIn()
    const u = await simUser(s)
    expect((await api(s, '/agent-message', 'POST', { wallet_id: u.wallet_id, text: '  ' })).status).toBe(400)
    expect((await api(s, '/agent-message', 'POST', { wallet_id: u.wallet_id, text: 'x'.repeat(4001) })).body.error.code).toBe('message_too_long')
  })
})

describe('the calls to Halo', () => {
  it('lists the events with their state, and the summary names the user and the text', async () => {
    const s = await loggedIn()
    const u = (await api(s, '/users', 'POST', {})).body
    const client = await openApp(s, u.wallet_id)
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'hello Halo' })
    await client.next('ack')
    const { events } = (await api(s, '/events')).body
    expect(events[0]).toMatchObject({ kind: 'message.inbound', state: 'waiting', attempts: 0, summary: `${u.wallet_id}: hello Halo` })
  })

  it('shows an event as retrying with its error while Halo is switched off, and sends it when Halo is back', async () => {
    await h.close()
    const reached: string[] = []
    h = await startHarness({
      cfg: { simulator: { enabled: true } },
      dispatcher: {
        fetch: (async (url: string) => {
          reached.push(url)
          return new Response('{"ok":true}', { status: 200 })
        }) as unknown as typeof fetch,
        log: () => undefined,
      },
    })
    const s = await loggedIn()
    const u = (await api(s, '/users', 'POST', {})).body
    expect((await api(s, '/halo-offline', 'POST', { offline: true })).body.offline).toBe(true)
    expect((await api(s, '/config')).body.halo.offline).toBe(true)

    const client = await openApp(s, u.wallet_id)
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'while Halo is down' })
    await client.next('ack')

    await vi.waitFor(async () => {
      const ev = (await api(s, '/events')).body.events[0]
      expect(ev).toMatchObject({ state: 'retrying', attempts: 1 })
      expect(ev.last_error).toMatch(/could not be reached/)
    })
    expect(reached).toEqual([]) // nothing reached the pretend Halo

    await api(s, '/halo-offline', 'POST', { offline: false })
    await vi.waitFor(async () => expect((await api(s, '/events')).body.events[0].state).toBe('sent'), { timeout: 5000 })
    expect(reached).toHaveLength(1)
  })

  it('replays an old event to Halo without changing its state, and reports what Halo answered', async () => {
    await h.close()
    h = await startHarness({
      cfg: { simulator: { enabled: true } },
      dispatcher: {
        fetch: (async () => new Response('{"ok":true,"duplicate":true}', { status: 200 })) as unknown as typeof fetch,
        log: () => undefined,
      },
    })
    const s = await loggedIn()
    const u = (await api(s, '/users', 'POST', {})).body
    const client = await openApp(s, u.wallet_id)
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'replay me' })
    await client.next('ack')
    await vi.waitFor(async () => expect((await api(s, '/events')).body.events[0].state).toBe('sent'))
    const id = (await api(s, '/events')).body.events[0].id
    const replay = await api(s, '/replay-event', 'POST', { event_id: id })
    expect(replay.body).toMatchObject({ outcome: 'ok', http_status: 200 })
    expect(replay.body.answer).toContain('duplicate')
    expect((await api(s, '/events')).body.events[0].attempts).toBe(1) // the replay is not an attempt
    expect((await api(s, '/replay-event', 'POST', { event_id: 'evt_nope' })).status).toBe(404)
  })
})

describe('files, replies, ticks and typing through the simulator', () => {
  const simUser = async (s: string) => (await api(s, '/users', 'POST', { name: 'Feature' })).body as { wallet_id: string }

  it('the agent sends a file: it reaches the open app, and the agent view shows it with a link', async () => {
    const s = await loggedIn()
    const u = await simUser(s)
    const client = await openApp(s, u.wallet_id)
    const res = await fetch(`${h.url}/simulator/api/agent-file`, {
      method: 'POST',
      headers: { 'x-sim-session': s, 'x-wallet-id': u.wallet_id, 'content-type': 'image/png', 'x-file-name': encodeURIComponent('form.png'), 'x-caption': encodeURIComponent('the form') },
      body: PNG,
    })
    expect(res.status).toBe(202)
    expect(((await res.json()) as { delivery: string }).delivery).toBe('socket')
    expect(await client.next('deliver')).toMatchObject({ kind: 'image', text: 'the form', media: { file_name: 'form.png', mime_type: 'image/png' } })
    const m = ((await api(s, `/messages?wallet_id=${u.wallet_id}`)).body.messages as { kind: string; media: { url: string } }[])[0]!
    expect(m.kind).toBe('image')
    expect(Buffer.from(await (await fetch(m.media.url)).arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('refuses a file type that is not allowed, and a file for a user that is not a test user', async () => {
    const s = await loggedIn()
    const u = await simUser(s)
    const send = (headers: Record<string, string>) => fetch(`${h.url}/simulator/api/agent-file`, { method: 'POST', headers: { 'x-sim-session': s, ...headers }, body: PNG })
    expect((await send({ 'x-wallet-id': u.wallet_id, 'content-type': 'image/gif' })).status).toBe(400)
    await h.session({ wallet_id: 'W-real-file' })
    expect((await send({ 'x-wallet-id': 'W-real-file', 'content-type': 'image/png' })).status).toBe(404)
  })

  it('"mark read" does what Halo does: the app sees its messages as read', async () => {
    const s = await loggedIn()
    const u = await simUser(s)
    const client = await openApp(s, u.wallet_id)
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'is anyone there' })
    await client.next('ack')
    const r = await api(s, '/agent-read', 'POST', { wallet_id: u.wallet_id })
    expect(r.body.updated).toBe(1)
    expect(await client.next('receipt', (f) => f.status === 'read')).toMatchObject({ messages: [{ seq: 1 }] })
    expect((await api(s, '/agent-read', 'POST', { wallet_id: u.wallet_id })).body.updated).toBe(0)
  })

  it('shows "support is typing" in the app, and quotes a reply', async () => {
    const s = await loggedIn()
    const u = await simUser(s)
    const client = await openApp(s, u.wallet_id)
    expect((await api(s, '/agent-typing', 'POST', { wallet_id: u.wallet_id })).body.delivered_to).toBe(1)
    expect(await client.next('typing')).toMatchObject({ from: 'support' })
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'my question' })
    const asked = await client.next('ack')
    await api(s, '/agent-message', 'POST', { wallet_id: u.wallet_id, text: 'the answer', reply_to_server_id: asked.server_id })
    expect((await client.next('deliver', (f) => f.direction === 'out')).reply_to).toMatchObject({ server_id: asked.server_id, text: 'my question', from: 'you' })
  })
})

