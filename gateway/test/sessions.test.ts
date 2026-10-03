import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHarness, type Harness } from './helpers'

let h: Harness

beforeAll(async () => {
  h = await startHarness()
})
afterAll(async () => {
  await h.close()
})

const post = (path: string, body: unknown, key: string | null = h.sessionsKey) =>
  fetch(`${h.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error

describe('GET /healthz', () => {
  it('answers without authentication', async () => {
    const res = await fetch(`${h.url}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, connections: 0 })
  })
})

describe('POST /v1/sessions', () => {
  it('creates the user and the conversation, and answers with a one-time token', async () => {
    const res = await post('/v1/sessions', { user: { wallet_id: 'W-1', name: 'Aisha', phone: '+60111', email: 'Aisha@Example.com' } })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { token: string; expires_at: string; ws_path: string; conversation_id: string }
    expect(body.token).toMatch(/^vcs_/)
    expect(body.ws_path).toBe('/ws')
    expect(body.conversation_id).toMatch(/^c_/)
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(body.expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 61_000)

    const subject = await h.subject('W-1')
    expect(subject.user).toMatchObject({ name: 'Aisha', phone: '+60111', email: 'aisha@example.com' })
    expect(subject.conversation.id).toBe(body.conversation_id)
  })

  it('returns the same conversation for the same user every time', async () => {
    const a = await h.session({ wallet_id: 'W-same' })
    const b = await h.session({ wallet_id: 'W-same' })
    expect(b.conversation_id).toBe(a.conversation_id)
    expect(b.token).not.toBe(a.token)
  })

  it('refuses a missing, malformed or wrong sessions key', async () => {
    for (const key of [null, 'nope', h.workspace.workspace_key]) {
      const res = await post('/v1/sessions', { user: { wallet_id: 'W-x' } }, key)
      expect(res.status).toBe(401)
      expect((await errorOf(res)).code).toBe('unauthorized')
    }
  })

  it('does not accept Halo\'s API token as a sessions key', async () => {
    const res = await post('/v1/sessions', { user: { wallet_id: 'W-x' } }, 'vct_halo_token')
    expect(res.status).toBe(401)
  })

  it('needs a wallet id, and a valid email', async () => {
    expect((await post('/v1/sessions', {})).status).toBe(400)
    expect((await post('/v1/sessions', { user: {} })).status).toBe(400)
    expect((await post('/v1/sessions', { user: { wallet_id: '  ' } })).status).toBe(400)
    const badEmail = await post('/v1/sessions', { user: { wallet_id: 'W-e', email: 'not-an-email' } })
    expect(badEmail.status).toBe(400)
    expect((await errorOf(badEmail)).message).toMatch(/email/)
  })

  it('refuses a body that is not JSON', async () => {
    const res = await post('/v1/sessions', '{broken')
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('bad_request')
  })

  it('refuses an oversized body', async () => {
    const res = await post('/v1/sessions', { user: { wallet_id: 'W-big', name: 'x'.repeat(100_000) } })
    expect(res.status).toBe(413)
  })

  it('answers an unknown route with the standard error shape', async () => {
    const res = await fetch(`${h.url}/v1/nothing`)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('not_found')
  })
})
