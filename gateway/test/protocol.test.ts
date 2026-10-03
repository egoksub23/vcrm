import { describe, expect, it } from 'vitest'

import { testConfig } from '../src/config'
import { parseClientFrame } from '../src/protocol'
import { decryptSecret, encryptSecret, sha256Hex } from '../src/crypto'
import { Hub, type LiveConnection } from '../src/hub'
import { loadConfig } from '../src/config'

const limits = testConfig().limits
const parse = (v: unknown) => parseClientFrame(typeof v === 'string' ? v : JSON.stringify(v), limits)
const fail = (v: unknown) => {
  const r = parse(v)
  if (r.ok) throw new Error('expected the frame to be refused')
  return r
}

describe('parseClientFrame: hello', () => {
  const hello = { type: 'hello', v: 1, token: 'vcs_abc', device_id: 'dev-1' }

  it('accepts a minimal hello and a full one', () => {
    expect(parse(hello)).toEqual({ ok: true, frame: { type: 'hello', v: 1, token: 'vcs_abc', deviceId: 'dev-1', appVersion: null, lastSeq: null } })
    expect(parse({ ...hello, app_version: '2.4.1', last_seq: 17 })).toMatchObject({ ok: true, frame: { appVersion: '2.4.1', lastSeq: 17 } })
  })

  it('refuses another protocol version, a missing token or device, and a bad last_seq', () => {
    expect(fail({ ...hello, v: 2 }).code).toBe('unsupported_version')
    expect(fail({ ...hello, token: '' }).code).toBe('bad_frame')
    expect(fail({ ...hello, device_id: undefined }).code).toBe('bad_frame')
    expect(fail({ ...hello, last_seq: -1 }).code).toBe('bad_frame')
    expect(fail({ ...hello, last_seq: 1.5 }).code).toBe('bad_frame')
    expect(fail({ ...hello, last_seq: '3' }).code).toBe('bad_frame')
  })
})

describe('parseClientFrame: send', () => {
  it('accepts a text message and trims it', () => {
    expect(parse({ type: 'send', client_id: 'c1', kind: 'text', text: '  hi  ' })).toEqual({
      ok: true,
      frame: { type: 'send', clientId: 'c1', messageType: 'text', text: 'hi', media: null, replyTo: null },
    })
  })

  it('needs a client id, a known kind, and text for a text message', () => {
    expect(fail({ type: 'send', kind: 'text', text: 'x' }).code).toBe('bad_frame')
    expect(fail({ type: 'send', client_id: 'c', kind: 'sticker', text: 'x' }).code).toBe('bad_frame')
    expect(fail({ type: 'send', client_id: 'c', kind: 'text' }).code).toBe('bad_frame')
    expect(fail({ type: 'send', client_id: 'c', kind: 'text', text: '   ' }).code).toBe('bad_frame')
  })

  it('refuses text over the limit and accepts text at the limit', () => {
    expect(fail({ type: 'send', client_id: 'c', kind: 'text', text: 'x'.repeat(limits.textMax + 1) }).code).toBe('message_too_long')
    expect(parse({ type: 'send', client_id: 'c', kind: 'text', text: 'x'.repeat(limits.textMax) }).ok).toBe(true)
  })

  it('needs media for a file message, and limits its caption', () => {
    expect(fail({ type: 'send', client_id: 'c', kind: 'image' }).code).toBe('bad_frame')
    expect(fail({ type: 'send', client_id: 'c', kind: 'image', media: { file_id: 'f1' }, text: 'x'.repeat(limits.captionMax + 1) }).code).toBe('message_too_long')
    expect(parse({ type: 'send', client_id: 'c', kind: 'image', media: { file_id: 'f1' }, text: 'a caption' })).toMatchObject({
      ok: true,
      frame: { messageType: 'image', text: 'a caption', media: { fileId: 'f1' }, replyTo: null },
    })
    // a file message names an uploaded file; a bare object with no id is not one
    expect(fail({ type: 'send', client_id: 'c', kind: 'image', media: { url: 'https://x/y.png' } }).code).toBe('bad_frame')
  })

  it('reads a reply, and refuses one that is not an id', () => {
    expect(parse({ type: 'send', client_id: 'c', kind: 'text', text: 'yes', reply_to: 'm_77' })).toMatchObject({ ok: true, frame: { replyTo: 'm_77' } })
    expect(fail({ type: 'send', client_id: 'c', kind: 'text', text: 'yes', reply_to: 77 }).code).toBe('bad_frame')
    expect(fail({ type: 'send', client_id: 'c', kind: 'text', text: 'yes', reply_to: '' }).code).toBe('bad_frame')
  })
})

describe('parseClientFrame: files', () => {
  it('reads an upload request, leaving the checks of the file itself to the file service', () => {
    expect(parse({ type: 'upload_request', request_id: 'r1', kind: 'audio', file_name: 'n.ogg', mime_type: 'audio/ogg', size_bytes: 900, duration_seconds: 4 })).toEqual({
      ok: true,
      frame: { type: 'upload_request', requestId: 'r1', kind: 'audio', fileName: 'n.ogg', mimeType: 'audio/ogg', sizeBytes: 900, durationSeconds: 4 },
    })
    expect(fail({ type: 'upload_request', kind: 'image' }).code).toBe('bad_frame')
  })

  it('reads a request for a fresh link', () => {
    expect(parse({ type: 'file_url', file_id: 'f_1' })).toEqual({ ok: true, frame: { type: 'file_url', fileId: 'f_1' } })
    expect(fail({ type: 'file_url' }).code).toBe('bad_frame')
  })
})

describe('parseClientFrame: the rest', () => {
  it('reads receipts, resume, typing and ping', () => {
    expect(parse({ type: 'receipt', up_to_seq: 4, status: 'read' })).toEqual({ ok: true, frame: { type: 'receipt', upToSeq: 4, status: 'read' } })
    expect(fail({ type: 'receipt', up_to_seq: 4, status: 'seen' }).code).toBe('bad_frame')
    expect(fail({ type: 'receipt', status: 'read' }).code).toBe('bad_frame')
    expect(parse({ type: 'resume', last_seq: 0 })).toEqual({ ok: true, frame: { type: 'resume', lastSeq: 0 } })
    expect(fail({ type: 'resume' }).code).toBe('bad_frame')
    expect(parse({ type: 'typing' }).ok).toBe(true)
    expect(parse({ type: 'ping', t: 99 })).toEqual({ ok: true, frame: { type: 'ping', t: 99 } })
  })

  it('refuses anything that is not a JSON object with a known type, without throwing', () => {
    for (const raw of ['not json', '[]', '"hello"', '42', 'null', '{}', '{"type":"explode"}', '{"type":42}']) {
      expect(fail(raw).ok).toBe(false)
    }
  })
})

describe('crypto', () => {
  const key = '11'.repeat(32)

  it('round-trips a secret and never repeats the ciphertext', () => {
    const a = encryptSecret('vcs_secret', key)
    expect(a).not.toContain('vcs_secret')
    expect(decryptSecret(a, key)).toBe('vcs_secret')
    expect(encryptSecret('vcs_secret', key)).not.toBe(a)
  })

  it('refuses the wrong key, a tampered value and a bad key length', () => {
    const sealed = encryptSecret('x', key)
    expect(() => decryptSecret(sealed, '22'.repeat(32))).toThrow()
    const [v, iv, ct, tag] = sealed.split(':')
    expect(() => decryptSecret([v, iv, Buffer.from('tampered').toString('base64url'), tag].join(':'), key)).toThrow()
    expect(() => decryptSecret('garbage', key)).toThrow(/Unrecognised/)
    expect(() => encryptSecret('x', 'abcd')).toThrow(/64 hex/)
    expect(ct).toBeTruthy()
  })

  it('hashes deterministically', () => {
    expect(sha256Hex('a')).toBe(sha256Hex('a'))
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
    expect(sha256Hex('a')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://x', GATEWAY_ENCRYPTION_KEY: 'ab'.repeat(32) }

  it('needs the database and a 64-hex key, and says which is wrong', () => {
    expect(() => loadConfig({ GATEWAY_ENCRYPTION_KEY: base.GATEWAY_ENCRYPTION_KEY })).toThrow(/DATABASE_URL/)
    expect(() => loadConfig({ DATABASE_URL: 'x' })).toThrow(/GATEWAY_ENCRYPTION_KEY/)
    expect(() => loadConfig({ ...base, GATEWAY_ENCRYPTION_KEY: 'short' })).toThrow(/64 hex/)
  })

  it('has sensible defaults and reads overrides', () => {
    expect(loadConfig(base)).toMatchObject({ port: 8090, wsPath: '/ws', sessionTtlSeconds: 60, heartbeatSeconds: 25, maxDevicesPerUser: 3 })
    expect(loadConfig({ ...base, PORT: '9000', TEXT_MAX: '500' })).toMatchObject({ port: 9000, limits: { textMax: 500 } })
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, HEARTBEAT_SECONDS: '0' })).toThrow(/HEARTBEAT_SECONDS/)
  })
})

describe('Hub', () => {
  const conn = (id: string, userId: string, deviceId: string): LiveConnection & { sent: Record<string, unknown>[]; closed: boolean } => {
    const c = {
      id,
      userId,
      deviceId,
      sent: [] as Record<string, unknown>[],
      closed: false,
      send(f: Record<string, unknown>) {
        c.sent.push(f)
      },
      close() {
        c.closed = true
      },
    }
    return c
  }

  it('knows who is online and forgets them when the last connection goes', () => {
    const hub = new Hub(3)
    const a = conn('1', 'u1', 'd1')
    expect(hub.isOnline('u1')).toBe(false)
    hub.add(a)
    expect(hub.isOnline('u1')).toBe(true)
    expect(hub.size).toBe(1)
    hub.remove(a)
    expect(hub.isOnline('u1')).toBe(false)
    expect(hub.size).toBe(0)
  })

  it('replaces the same device, and the oldest when over the device limit', () => {
    const hub = new Hub(2)
    const first = conn('1', 'u1', 'phone')
    hub.add(first)
    expect(hub.add(conn('2', 'u1', 'phone'))).toEqual([first])
    const tablet = conn('3', 'u1', 'tablet')
    hub.add(tablet)
    const evicted = hub.add(conn('4', 'u1', 'watch'))
    expect(evicted.map((c) => c.deviceId)).toEqual(['phone'])
    expect(hub.connectionsOf('u1').map((c) => c.deviceId)).toEqual(['tablet', 'watch'])
  })

  it('sends to every connection of a user but one, and to nobody else', () => {
    const hub = new Hub(3)
    const a = conn('1', 'u1', 'd1')
    const b = conn('2', 'u1', 'd2')
    const other = conn('3', 'u2', 'd1')
    ;[a, b, other].forEach((c) => hub.add(c))
    expect(hub.send('u1', { type: 'x' }, '1')).toBe(1)
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([{ type: 'x' }])
    expect(other.sent).toEqual([])
    expect(hub.send('nobody', { type: 'x' })).toBe(0)
  })

  it('closes everything on closeAll', () => {
    const hub = new Hub(3)
    const a = conn('1', 'u1', 'd1')
    hub.add(a)
    hub.closeAll(1012, 'restart')
    expect(a.closed).toBe(true)
  })
})
