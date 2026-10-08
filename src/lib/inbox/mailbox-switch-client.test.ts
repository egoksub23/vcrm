import { describe, expect, it } from 'vitest'

import { patchMailboxSwitch, sendLine } from './mailbox-switch-client'

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('what the answer to a switch means for the screen', () => {
  it('sends the switch as one PATCH with a JSON body', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fetcher = (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response('{"success":true}', { status: 200 }))) as unknown as typeof fetch
    expect(await patchMailboxSwitch('/api/account/channels/email', { inbox_enabled: false }, fetcher)).toEqual({ ok: true, note: 'none' })
    expect(seen!.url).toBe('/api/account/channels/email')
    expect(seen!.init.method).toBe('PATCH')
    expect(JSON.parse(String(seen!.init.body))).toEqual({ inbox_enabled: false })
  })

  it('says when the provider could not be told to stop (the inbox is off anyway), and when Gmail push is not set up', async () => {
    expect(await patchMailboxSwitch('/x', { inbox_enabled: false }, answer(200, { success: true, subscription: 'stop_failed' }))).toEqual({ ok: true, note: 'stop_failed' })
    expect(await patchMailboxSwitch('/x', { inbox_enabled: false }, answer(200, { success: true, watch: 'stop_failed' }))).toEqual({ ok: true, note: 'stop_failed' })
    expect(await patchMailboxSwitch('/x', { inbox_enabled: true }, answer(200, { success: true, watch: 'not_configured' }))).toEqual({ ok: true, note: 'no_push' })
    expect(await patchMailboxSwitch('/x', { inbox_enabled: true }, answer(200, { success: true, subscription: 'started' }))).toEqual({ ok: true, note: 'none' })
  })

  it('maps the server\'s refusals to words the screen translates, and anything else to a plain failure', async () => {
    expect(await patchMailboxSwitch('/x', { inbox_enabled: true }, answer(409, { code: 'needs_reconnect', error: 'x' }))).toEqual({ ok: false, reason: 'needs_reconnect' })
    expect(await patchMailboxSwitch('/x', { inbox_enabled: true }, answer(502, { code: 'subscription_failed' }))).toEqual({ ok: false, reason: 'start_failed' })
    expect(await patchMailboxSwitch('/x', { inbox_enabled: true }, answer(502, { code: 'watch_failed' }))).toEqual({ ok: false, reason: 'start_failed' })
    expect(await patchMailboxSwitch('/x', { inbox_enabled: true }, answer(404, { code: 'not_connected' }))).toEqual({ ok: false, reason: 'not_connected' })
    expect(await patchMailboxSwitch('/x', { enabled: false }, answer(500, { error: 'boom' }))).toEqual({ ok: false, reason: 'failed' })
    expect(await patchMailboxSwitch('/x', { enabled: false }, answer(403, 'not json'))).toEqual({ ok: false, reason: 'failed' })
  })

  it('treats a network failure as a plain failure', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await patchMailboxSwitch('/x', { enabled: true }, down)).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('the "send Halo emails" line', () => {
  it('says used whatever the inbox does, and names the pause or the reconnect when that is why not', () => {
    expect(sendLine({ status: 'connected', needs_reauth: false, enabled: true })).toBe('used')
    expect(sendLine({})).toBe('used')
    expect(sendLine({ status: 'connected', needs_reauth: false, enabled: false })).toBe('paused')
    expect(sendLine({ status: 'connected', needs_reauth: true, enabled: true })).toBe('reconnect')
    expect(sendLine({ status: 'error', needs_reauth: false, enabled: true })).toBe('reconnect')
    // a mailbox that needs reconnecting is named as that first, as on the server
    expect(sendLine({ status: 'connected', needs_reauth: true, enabled: false })).toBe('reconnect')
  })
})
