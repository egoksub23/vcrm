import { describe, expect, it } from 'vitest'

import { parseGatewayAccepted, parseGatewayError, parseWebhookEvent, TEXT_MAX, CAPTION_MAX } from './contract'

const inbound = (over: Record<string, unknown> = {}) => ({
  event: 'message.inbound',
  event_id: 'evt_1',
  workspace_key: 'vcw_1',
  user: { wallet_id: 'W123', name: 'Aisha', phone: '+60123456789', email: 'Aisha@Example.com' },
  conversation_id: 'c_1',
  message: { server_id: 'm_1', client_id: 'u-1', seq: 41, type: 'text', text: 'Hi, I cannot top up', sent_at: '2026-10-02T09:15:00Z' },
  ...over,
})

describe('parseWebhookEvent: message.inbound', () => {
  it('reads the example in the contract', () => {
    const r = parseWebhookEvent(inbound())
    expect(r).toMatchObject({
      ok: true,
      event: {
        kind: 'message.inbound',
        eventId: 'evt_1',
        workspaceKey: 'vcw_1',
        conversationId: 'c_1',
        user: { walletId: 'W123', name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' },
        message: { serverId: 'm_1', clientId: 'u-1', seq: 41, type: 'text', text: 'Hi, I cannot top up', sentAt: '2026-10-02T09:15:00.000Z', media: null },
      },
    })
  })

  it('needs the wallet id, event id, workspace key and message id', () => {
    expect(parseWebhookEvent(inbound({ user: { name: 'x' } }))).toEqual({ ok: false, error: 'user.wallet_id is required' })
    expect(parseWebhookEvent(inbound({ event_id: '' }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(inbound({ workspace_key: undefined }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(inbound({ message: { type: 'text', text: 'x' } }))).toMatchObject({ ok: false })
  })

  it('keeps optional user fields optional but checks them when present', () => {
    const r = parseWebhookEvent(inbound({ user: { wallet_id: 'W1' } }))
    expect(r).toMatchObject({ ok: true, event: { user: { name: null, phone: null, email: null } } })
    expect(parseWebhookEvent(inbound({ user: { wallet_id: 'W1', email: 'not an email' } }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(inbound({ user: { wallet_id: 'W1', phone: 123 } }))).toMatchObject({ ok: false })
  })

  it('enforces the text and caption limits', () => {
    const msg = (type: string, text: string, extra = {}) => ({ server_id: 'm', type, text, ...extra })
    expect(parseWebhookEvent(inbound({ message: msg('text', 'a'.repeat(TEXT_MAX)) }))).toMatchObject({ ok: true })
    expect(parseWebhookEvent(inbound({ message: msg('text', 'a'.repeat(TEXT_MAX + 1)) }))).toMatchObject({ ok: false })
    const media = { url: 'https://f.example/a.png', mime_type: 'image/png' }
    expect(parseWebhookEvent(inbound({ message: msg('image', 'a'.repeat(CAPTION_MAX), { media }) }))).toMatchObject({ ok: true })
    expect(parseWebhookEvent(inbound({ message: msg('image', 'a'.repeat(CAPTION_MAX + 1), { media }) }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(inbound({ message: msg('text', '   ') }))).toMatchObject({ ok: false })
  })

  it('needs media for a file message, https only, and drops media on a text message', () => {
    const file = (media?: unknown) => inbound({ message: { server_id: 'm', type: 'image', media } })
    expect(parseWebhookEvent(file())).toMatchObject({ ok: false })
    expect(parseWebhookEvent(file({ url: 'http://f.example/a.png', mime_type: 'image/png' }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(file({ url: 'ftp://f.example/a.png', mime_type: 'image/png' }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(file({ url: 'https://f.example/a.png' }))).toMatchObject({ ok: false })
    const ok = parseWebhookEvent(file({ url: 'https://f.example/a.png', mime_type: 'IMAGE/PNG', file_name: 'a.png', size_bytes: 10 }))
    expect(ok).toMatchObject({ ok: true, event: { message: { media: { mimeType: 'image/png', fileName: 'a.png', sizeBytes: 10 } } } })
    const text = parseWebhookEvent(inbound({ message: { server_id: 'm', type: 'text', text: 'hi', media: { url: 'https://f.example/a.png', mime_type: 'image/png' } } }))
    expect(text).toMatchObject({ ok: true, event: { message: { media: null } } })
  })

  it('rejects an unknown message type and a non-object body', () => {
    expect(parseWebhookEvent(inbound({ message: { server_id: 'm', type: 'sticker', text: 'x' } }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(null)).toMatchObject({ ok: false })
    expect(parseWebhookEvent([])).toMatchObject({ ok: false })
    expect(parseWebhookEvent('x')).toMatchObject({ ok: false })
  })

  it('falls back to null for a bad timestamp instead of failing the message', () => {
    const r = parseWebhookEvent(inbound({ message: { server_id: 'm', type: 'text', text: 'hi', sent_at: 'yesterday' } }))
    expect(r).toMatchObject({ ok: true, event: { message: { sentAt: null } } })
  })
})

describe('parseWebhookEvent: message.receipt and other events', () => {
  const receipt = (over: Record<string, unknown> = {}) => ({
    event: 'message.receipt',
    event_id: 'evt_2',
    workspace_key: 'vcw_1',
    server_id: 'm_78',
    status: 'delivered',
    at: '2026-10-02T09:15:04Z',
    ...over,
  })

  it('reads delivered, read and failed', () => {
    expect(parseWebhookEvent(receipt())).toMatchObject({ ok: true, event: { kind: 'message.receipt', serverId: 'm_78', status: 'delivered', error: null } })
    expect(parseWebhookEvent(receipt({ status: 'read' }))).toMatchObject({ ok: true, event: { status: 'read' } })
    expect(parseWebhookEvent(receipt({ status: 'failed', error: { code: 'blocked', message: 'opted out' } }))).toMatchObject({
      ok: true,
      event: { status: 'failed', error: { code: 'blocked', message: 'opted out' } },
    })
  })

  it('rejects an unknown status or a missing server id', () => {
    expect(parseWebhookEvent(receipt({ status: 'seen' }))).toMatchObject({ ok: false })
    expect(parseWebhookEvent(receipt({ server_id: undefined }))).toMatchObject({ ok: false })
  })

  it('ignores event types it does not know, so the contract can grow', () => {
    expect(parseWebhookEvent({ event: 'user.presence', event_id: 'e', workspace_key: 'w', state: 'online' })).toEqual({
      ok: true,
      ignored: 'user.presence',
    })
  })
})

describe('gateway answers', () => {
  it('reads the 202 body and treats a new delivery value as queued', () => {
    expect(parseGatewayAccepted({ server_id: 'm_78', seq: 42, conversation_id: 'c_1', delivery: 'socket' })).toEqual({
      serverId: 'm_78',
      seq: 42,
      conversationId: 'c_1',
      delivery: 'socket',
    })
    expect(parseGatewayAccepted({ server_id: 'm', delivery: 'carrier_pigeon' })?.delivery).toBe('queued')
    expect(parseGatewayAccepted({ delivery: 'socket' })).toBeNull()
    expect(parseGatewayAccepted(null)).toBeNull()
  })

  it('reads an error body, with a safe default for anything else', () => {
    expect(parseGatewayError({ error: { code: 'user_not_found', message: 'No such user' } })).toEqual({ code: 'user_not_found', message: 'No such user' })
    expect(parseGatewayError('boom')).toMatchObject({ code: 'unknown' })
    expect(parseGatewayError({ error: 'x' })).toMatchObject({ code: 'unknown' })
  })
})
