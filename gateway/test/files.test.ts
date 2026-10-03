import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { baseMime, mimeMatchesKind, sniffMatches } from '../src/files'
import {
  allowLocalFetch,
  connectUser,
  JPEG,
  OGG,
  PDF,
  PNG,
  startFileServer,
  startHarness,
  TestClient,
  uploadFile,
  WORKSPACE,
  type FileServer,
  type Harness,
} from './helpers'

let h: Harness
let fileServer: FileServer | null = null
const clients: TestClient[] = []
/** Milliseconds added to the file service's clock. */
let skew = 0

async function start(opts: Parameters<typeof startHarness>[0] = {}) {
  skew = 0
  h = await startHarness({ cfg: allowLocalFetch(), files: { now: () => Date.now() + skew }, ...opts })
}
beforeEach(async () => start())
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await fileServer?.close()
  fileServer = null
  await h.close()
})

const user = async (u: Parameters<typeof connectUser>[1] = {}, hello: Record<string, unknown> = {}) => {
  const out = await connectUser(h, u, hello)
  clients.push(out.client)
  return out.client
}

describe('what a file may be', () => {
  it('knows the kinds: an image is an image, a document is anything else on the list', () => {
    expect(mimeMatchesKind('image', 'image/png')).toBe(true)
    expect(mimeMatchesKind('image', 'application/pdf')).toBe(false)
    expect(mimeMatchesKind('audio', 'audio/ogg')).toBe(true)
    expect(mimeMatchesKind('video', 'video/mp4')).toBe(true)
    expect(mimeMatchesKind('document', 'application/pdf')).toBe(true)
    expect(mimeMatchesKind('document', 'image/png')).toBe(false)
    expect(mimeMatchesKind('image', 'image/gif')).toBe(false) // not on Halo's list
    expect(baseMime('Audio/OGG; codecs=opus')).toBe('audio/ogg')
  })

  it('checks the first bytes for the formats that have an unmistakable start', () => {
    expect(sniffMatches('image/png', PNG)).toBe(true)
    expect(sniffMatches('image/png', JPEG)).toBe(false)
    expect(sniffMatches('image/jpeg', JPEG)).toBe(true)
    expect(sniffMatches('application/pdf', PDF)).toBe(true)
    expect(sniffMatches('application/pdf', Buffer.from('<html><script>'))).toBe(false)
    expect(sniffMatches('audio/ogg', OGG)).toBe(true)
    expect(sniffMatches('text/plain', Buffer.from('anything'))).toBe(true)
  })
})

describe('asking for an upload slot', () => {
  /** The slot, or the error, whichever the gateway answers. */
  const ask = async (frame: Record<string, unknown>) => {
    const client = await user()
    client.send({ type: 'upload_request', request_id: 'r1', ...frame })
    for (let i = 0; i < 300; i++) {
      const at = client.frames.findIndex((f) => f.type === 'error' || f.type === 'upload_slot')
      if (at >= 0) return client.frames.splice(at, 1)[0]!
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('no answer to the upload request')
  }
  const good = { kind: 'image', file_name: 'a.png', mime_type: 'image/png', size_bytes: 1000 }

  it('gives a signed address, the file id, when it expires and how much it may hold', async () => {
    const slot = await ask(good)
    expect(slot).toMatchObject({ type: 'upload_slot', request_id: 'r1', file_id: expect.stringMatching(/^f_/), max_bytes: 1000 })
    expect(slot.upload_url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${h.gw.port}/v1/uploads/f_[0-9a-f]+\\?exp=\\d+&sig=[0-9a-f]{64}$`))
    expect(new Date(slot.expires_at as string).getTime()).toBeGreaterThan(Date.now())
  })

  it('refuses a type that is not allowed, a kind that does not fit, a file that is too large and a bad size', async () => {
    expect(await ask({ ...good, mime_type: 'image/gif' })).toMatchObject({ type: 'error', code: 'file_type_not_allowed', request_id: 'r1' })
    expect(await ask({ ...good, mime_type: 'application/pdf' })).toMatchObject({ code: 'file_type_not_allowed' })
    expect(await ask({ ...good, size_bytes: 16 * 1024 * 1024 + 1 })).toMatchObject({ code: 'file_too_large' })
    expect(await ask({ ...good, size_bytes: 0 })).toMatchObject({ code: 'bad_request' })
    expect(await ask({ ...good, size_bytes: 'big' })).toMatchObject({ code: 'bad_request' })
    expect(await ask({ ...good, kind: 'sticker' })).toMatchObject({ code: 'bad_request' })
  })

  it('refuses a voice note longer than five minutes and accepts exactly five', async () => {
    const voice = { kind: 'audio', mime_type: 'audio/ogg', size_bytes: 5000 }
    expect(await ask({ ...voice, duration_seconds: 301 })).toMatchObject({ code: 'file_too_large' })
    expect(await ask({ ...voice, duration_seconds: 300 })).toMatchObject({ type: 'upload_slot' })
    expect(await ask({ ...voice, duration_seconds: -1 })).toMatchObject({ code: 'bad_request' })
  })

  it('limits how many slots one user may ask for', async () => {
    const client = await user()
    for (let i = 0; i < 20; i++) {
      client.send({ type: 'upload_request', request_id: `r${i}`, ...good })
      await client.next('upload_slot')
    }
    client.send({ type: 'upload_request', request_id: 'r-over', ...good })
    expect(await client.next('error')).toMatchObject({ code: 'rate_limited', request_id: 'r-over' })
  })
})

describe('uploading the bytes', () => {
  it('stores a good file, and says so', async () => {
    const client = await user({ wallet_id: 'W-up' })
    const { slot, res } = await uploadFile(client, { kind: 'image', mime: 'image/png', name: 'shot.png', bytes: PNG })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ file_id: slot.file_id, size_bytes: PNG.length })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const { rows } = await h.db.query<{ status: string; size_bytes: number }>('SELECT status, size_bytes FROM files WHERE id = $1', [slot.file_id])
    expect(rows[0]).toMatchObject({ status: 'ready', size_bytes: PNG.length })
  })

  it('refuses the wrong Content-Type, the wrong size, more bytes than declared, and content that is not the declared type', async () => {
    const client = await user()
    const err = async (tweak: Parameters<typeof uploadFile>[2], f = { kind: 'image', mime: 'image/png', bytes: PNG }) => {
      const { res } = await uploadFile(client, f, tweak)
      return [res.status, ((await res.json()) as { error: { code: string } }).error.code] as const
    }
    expect(await err({ contentType: 'image/jpeg' })).toEqual([415, 'file_type_not_allowed'])
    expect(await err({ body: PNG.subarray(0, 50) })).toEqual([400, 'size_mismatch'])
    expect(await err({ body: Buffer.concat([PNG, Buffer.alloc(10)]) })).toEqual([413, 'file_too_large'])
    expect(await err({}, { kind: 'image', mime: 'image/png', bytes: Buffer.from('<html>not a picture</html>'.padEnd(130, ' ')) })).toEqual([415, 'file_type_not_allowed'])
  })

  it('accepts a file once only', async () => {
    const client = await user()
    const { slot } = await uploadFile(client, { kind: 'image', mime: 'image/png', bytes: PNG })
    const again = await fetch(slot.upload_url as string, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG })
    expect(again.status).toBe(409)
  })

  it('refuses a forged or altered address, and one that has expired', async () => {
    const client = await user()
    client.send({ type: 'upload_request', request_id: 'r', kind: 'image', mime_type: 'image/png', size_bytes: PNG.length })
    const slot = await client.next('upload_slot')
    const url = new URL(slot.upload_url as string)
    const put = (u: string) => fetch(u, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG })

    url.searchParams.set('sig', '0'.repeat(64))
    expect((await put(url.toString())).status).toBe(401)
    const other = new URL(slot.upload_url as string)
    other.pathname = '/v1/uploads/f_someoneelsesfile0000'
    expect((await put(other.toString())).status).toBe(401)

    skew += 16 * 60_000 // past the 15-minute slot
    expect((await put(slot.upload_url as string)).status).toBe(410)
  })

  it('answers the browser preflight for an upload and for a file', async () => {
    for (const path of ['/v1/uploads/f_x', '/v1/files/f_x']) {
      const res = await fetch(`${h.url}${path}`, { method: 'OPTIONS', headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'PUT' } })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-methods')).toContain('PUT')
    }
  })

  it('cleans up slots nobody used', async () => {
    const client = await user()
    client.send({ type: 'upload_request', request_id: 'r', kind: 'image', mime_type: 'image/png', size_bytes: 10 })
    await client.next('upload_slot')
    skew += 3 * 3600_000
    expect(await h.gw.files.purgeStalePending()).toBe(1)
  })
})

describe('sending a file from the app', () => {
  async function sendFile(client: TestClient, f: Parameters<typeof uploadFile>[1], extra: Record<string, unknown> = {}, clientId = `c-${Math.random()}`) {
    const { slot, res } = await uploadFile(client, f)
    expect(res.status).toBe(201)
    client.send({ type: 'send', client_id: clientId, kind: f.kind, media: { file_id: slot.file_id }, ...extra })
    return { slot, clientId }
  }

  it('is acknowledged, stored with its file, and tells Halo with a signed link Halo can fetch', async () => {
    const client = await user({ wallet_id: 'W-send-file' })
    const { slot } = await sendFile(client, { kind: 'image', mime: 'image/png', name: 'receipt.png', bytes: PNG }, { text: 'my receipt' })
    const ack = await client.next('ack')
    expect(ack.seq).toBe(1)

    const stored = await h.gw.store.getMessage(ack.server_id as string)
    expect(stored).toMatchObject({ type: 'image', text: 'my receipt', direction: 'in', media: { file_id: slot.file_id, mime_type: 'image/png', file_name: 'receipt.png', size_bytes: PNG.length } })

    // the outbox keeps only the file's id; the link is made when the event is sent
    const [event] = await h.gw.store.pendingEvents(h.workspace.id)
    expect((event!.payload as { message: { media: { file_id: string } } }).message.media.file_id).toBe(slot.file_id)
    const sent = h.gw.files.signEventMedia(event!.payload) as { message: { media: Record<string, unknown> } }
    expect(sent.message.media).toMatchObject({ mime_type: 'image/png', file_name: 'receipt.png', size_bytes: PNG.length })
    expect(sent.message.media.file_id).toBeUndefined()
    const got = await fetch(sent.message.media.url as string)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('carries a voice note\'s length to Halo', async () => {
    const client = await user()
    await sendFile(client, { kind: 'audio', mime: 'audio/ogg', name: 'note.ogg', bytes: OGG, durationSeconds: 12 })
    await client.next('ack')
    const [event] = await h.gw.store.pendingEvents(h.workspace.id)
    const signed = h.gw.files.signEventMedia(event!.payload) as { message: { type: string; media: Record<string, unknown> } }
    expect(signed.message).toMatchObject({ type: 'audio', media: { mime_type: 'audio/ogg', duration_seconds: 12 } })
  })

  it('shows on the user\'s other devices with a link to the file', async () => {
    const phone = await user({ wallet_id: 'W-two-dev' }, { device_id: 'phone' })
    const tablet = await user({ wallet_id: 'W-two-dev' }, { device_id: 'tablet' })
    await sendFile(phone, { kind: 'image', mime: 'image/jpeg', name: 'x.jpg', bytes: JPEG })
    const seen = await tablet.next('deliver')
    expect(seen).toMatchObject({ kind: 'image', direction: 'in', media: { file_id: expect.stringMatching(/^f_/), mime_type: 'image/jpeg', file_name: 'x.jpg', size_bytes: JPEG.length } })
    const media = seen.media as { url: string; expires_at: string }
    expect(Buffer.from(await (await fetch(media.url)).arrayBuffer()).equals(JPEG)).toBe(true)
  })

  it('refuses a file that was not uploaded, one that belongs to someone else, one used already, and the wrong kind', async () => {
    const a = await user({ wallet_id: 'W-a-file' })
    const b = await user({ wallet_id: 'W-b-file' })
    const { slot } = await uploadFile(a, { kind: 'image', mime: 'image/png', bytes: PNG })

    // not uploaded: ask for a slot and never PUT
    a.send({ type: 'upload_request', request_id: 'x', kind: 'image', mime_type: 'image/png', size_bytes: 10 })
    const empty = await a.next('upload_slot')
    a.send({ type: 'send', client_id: 'c-empty', kind: 'image', media: { file_id: empty.file_id } })
    expect(await a.next('error')).toMatchObject({ code: 'file_not_ready', client_id: 'c-empty' })

    // someone else's
    b.send({ type: 'send', client_id: 'c-steal', kind: 'image', media: { file_id: slot.file_id } })
    expect(await b.next('error')).toMatchObject({ code: 'file_not_found', client_id: 'c-steal' })

    // the wrong kind
    a.send({ type: 'send', client_id: 'c-kind', kind: 'video', media: { file_id: slot.file_id } })
    expect(await a.next('error')).toMatchObject({ code: 'bad_request' })

    // used once, then again under another id
    a.send({ type: 'send', client_id: 'c-1', kind: 'image', media: { file_id: slot.file_id } })
    await a.next('ack')
    a.send({ type: 'send', client_id: 'c-2', kind: 'image', media: { file_id: slot.file_id } })
    expect(await a.next('error')).toMatchObject({ code: 'file_in_use', client_id: 'c-2' })

    // nothing was stored for the refused ones
    const s = await h.subject('W-b-file')
    expect(await h.gw.store.listAfter(s.conversation.id, 0, 10)).toEqual([])
  })

  it('absorbs a retry of the same send without using the file twice', async () => {
    const client = await user()
    const { slot } = await uploadFile(client, { kind: 'image', mime: 'image/png', bytes: PNG })
    const frame = { type: 'send', client_id: 'retry-me', kind: 'image', media: { file_id: slot.file_id } }
    client.send(frame)
    const first = await client.next('ack')
    client.send(frame)
    expect(await client.next('ack')).toMatchObject({ server_id: first.server_id, duplicate: true })
  })

  it('refuses a file message with no file, and a caption that is too long', async () => {
    const client = await user()
    client.send({ type: 'send', client_id: 'c', kind: 'image' })
    expect(await client.next('error')).toMatchObject({ code: 'bad_frame' })
    client.send({ type: 'send', client_id: 'c', kind: 'image', media: { file_id: 'f_x' }, text: 'x'.repeat(1025) })
    expect(await client.next('error')).toMatchObject({ code: 'message_too_long' })
  })

  it('replays a file with a working link, and gives a fresh one when the app asks', async () => {
    const client = await user({ wallet_id: 'W-replay-file' })
    const { slot } = await uploadFile(client, { kind: 'image', mime: 'image/png', bytes: PNG })
    client.send({ type: 'send', client_id: 'c', kind: 'image', media: { file_id: slot.file_id } })
    await client.next('ack')
    client.send({ type: 'resume', last_seq: 0 })
    const replayed = await client.next('deliver')
    expect((replayed.media as { url: string }).url).toContain('/v1/files/')

    client.send({ type: 'file_url', file_id: slot.file_id })
    const fresh = await client.next('file_url')
    expect(fresh.file_id).toBe(slot.file_id)
    expect((await fetch(fresh.url as string)).status).toBe(200)

    // another user's file is not available by asking
    const other = await user({ wallet_id: 'W-other-file' })
    other.send({ type: 'file_url', file_id: slot.file_id })
    expect(await other.next('error')).toMatchObject({ code: 'file_not_found' })
  })
})

describe('serving a file', () => {
  async function stored() {
    const client = await user()
    const { slot } = await uploadFile(client, { kind: 'audio', mime: 'audio/ogg', name: 'voice note.ogg', bytes: OGG })
    return h.gw.files.linkForApp(slot.file_id as string).url
  }

  it('sends the bytes with the right type, a safe disposition, no sniffing, and CORS', async () => {
    const url = await stored()
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/ogg')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''voice%20note.ogg")
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).equals(OGG)).toBe(true)
  })

  it('supports ranges, as iOS needs to play audio and video', async () => {
    const url = await stored()
    const part = await fetch(url, { headers: { range: 'bytes=0-9' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-9/${OGG.length}`)
    expect(Buffer.from(await part.arrayBuffer()).equals(OGG.subarray(0, 10))).toBe(true)
    const tail = await fetch(url, { headers: { range: 'bytes=-20' } })
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer()).equals(OGG.subarray(OGG.length - 20))).toBe(true)
    const open = await fetch(url, { headers: { range: `bytes=${OGG.length - 5}-` } })
    expect(Buffer.from(await open.arrayBuffer()).length).toBe(5)
    expect((await fetch(url, { headers: { range: 'bytes=9999-' } })).status).toBe(416)
  })

  it('shows a document as a download, and a PDF in the page', async () => {
    const client = await user()
    const doc = await uploadFile(client, { kind: 'document', mime: 'text/plain', name: 'notes.txt', bytes: Buffer.from('hello world') })
    const text = await fetch(h.gw.files.linkForApp(doc.slot.file_id as string).url)
    expect(text.headers.get('content-disposition')).toMatch(/^attachment/)
    const pdf = await uploadFile(client, { kind: 'document', mime: 'application/pdf', name: 'a.pdf', bytes: PDF })
    expect((await fetch(h.gw.files.linkForApp(pdf.slot.file_id as string).url)).headers.get('content-disposition')).toMatch(/^inline/)
  })

  it('refuses an altered link, a link for another file, an expired link and an unknown file', async () => {
    const url = await stored()
    const u = new URL(url)
    u.searchParams.set('sig', 'a'.repeat(64))
    expect((await fetch(u)).status).toBe(401)
    const otherFile = new URL(url)
    otherFile.pathname = '/v1/files/f_0000000000000000000'
    expect((await fetch(otherFile)).status).toBe(401)
    const missing = h.gw.files.linkForApp('f_doesnotexist0000000').url
    expect((await fetch(missing)).status).toBe(404)
    skew += 25 * 3600_000
    expect((await fetch(url)).status).toBe(410)
  })
})

describe('a file from Halo', () => {
  const post = (body: unknown, key = `k-${Math.random()}`) =>
    fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKSPACE.apiToken}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    })
  const msg = (media: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    recipient: { wallet_id: 'W-from-halo', name: 'Aisha', phone: '+60123456789' },
    type: 'image',
    text: 'Here is the form',
    media,
    sender: { name: 'Support' },
    ...extra,
  })

  it('is fetched, kept, and delivered to the app with a link to the gateway\'s copy', async () => {
    fileServer = await startFileServer({ '/form.png': { type: 'image/png', body: PNG } })
    const client = await user({ wallet_id: 'W-from-halo' })
    const res = await post(msg({ url: fileServer.url('/form.png'), mime_type: 'image/png', file_name: 'form.png', size_bytes: PNG.length }))
    expect(res.status).toBe(202)
    const answer = (await res.json()) as { delivery: string; server_id: string }
    expect(answer.delivery).toBe('socket')
    const frame = await client.next('deliver')
    expect(frame).toMatchObject({ server_id: answer.server_id, direction: 'out', kind: 'image', text: 'Here is the form', media: { mime_type: 'image/png', file_name: 'form.png', size_bytes: PNG.length } })
    const got = await fetch((frame.media as { url: string }).url)
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('does not fetch the file again for a repeated Idempotency-Key', async () => {
    fileServer = await startFileServer({ '/a.png': { type: 'image/png', body: PNG } })
    const body = msg({ url: fileServer.url('/a.png'), mime_type: 'image/png' })
    const first = await (await post(body, 'same-key')).json()
    const second = await (await post(body, 'same-key')).json()
    expect(second).toEqual(first)
    expect(fileServer.hits['/a.png']).toBe(1)
  })

  it('carries a voice note\'s length to the app', async () => {
    fileServer = await startFileServer({ '/v.ogg': { type: 'audio/ogg', body: OGG } })
    const client = await user({ wallet_id: 'W-from-halo' })
    const res = await post(msg({ url: fileServer.url('/v.ogg'), mime_type: 'audio/ogg', duration_seconds: 7 }, { type: 'audio', text: undefined }))
    expect(res.status).toBe(202)
    expect(await client.next('deliver')).toMatchObject({ kind: 'audio', media: { duration_seconds: 7 } })
  })

  it('answers invalid_media when the address fails, answers badly, or sends nothing', async () => {
    fileServer = await startFileServer({ '/empty.png': { type: 'image/png', body: Buffer.alloc(0) }, '/boom.png': { status: 500, body: PNG } })
    const refused = async (media: Record<string, unknown>) => {
      const res = await post(msg(media))
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: { code: string } }).error.code
    }
    expect(await refused({ url: fileServer.url('/missing.png'), mime_type: 'image/png' })).toBe('invalid_media')
    expect(await refused({ url: fileServer.url('/boom.png'), mime_type: 'image/png' })).toBe('invalid_media')
    expect(await refused({ url: fileServer.url('/empty.png'), mime_type: 'image/png' })).toBe('invalid_media')
    expect(await refused({ url: 'not a url', mime_type: 'image/png' })).toBe('invalid_media')
    expect(await refused({ url: 'http://127.0.0.1:1/x.png', mime_type: 'image/png' })).toBe('invalid_media')
  })

  it('refuses a type that is not allowed, one that does not fit the kind, content that is not that type, and a file that is too large', async () => {
    fileServer = await startFileServer({
      '/a.gif': { type: 'image/gif', body: Buffer.from('GIF89a') },
      '/fake.png': { type: 'image/png', body: Buffer.from('<html>' + 'x'.repeat(100)) },
      '/big.png': { type: 'image/png', body: Buffer.concat([PNG, Buffer.alloc(5000)]) },
    })
    const code = async (media: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const res = await post(msg(media, extra))
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: { code: string } }).error.code
    }
    expect(await code({ url: fileServer.url('/a.gif'), mime_type: 'image/gif' })).toBe('invalid_media')
    expect(await code({ url: fileServer.url('/a.gif'), mime_type: 'image/png' }, { type: 'video' })).toBe('invalid_media')
    expect(await code({ url: fileServer.url('/fake.png'), mime_type: 'image/png' })).toBe('invalid_media')
    await h.close()
    await start({ cfg: { ...allowLocalFetch(), limits: { textMax: 4000, captionMax: 1024, fileMaxBytes: 1000 } } })
    expect(await code({ url: fileServer.url('/big.png'), mime_type: 'image/png' })).toBe('invalid_media')
  })

  it('refuses addresses that are not https or are private, unless the gateway is set to allow them', async () => {
    await h.close()
    await start({ cfg: {} }) // the default settings: no fetches from http or private addresses
    const res = await post(msg({ url: 'http://example.com/a.png', mime_type: 'image/png' }))
    expect(res.status).toBe(400)
    for (const url of ['https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://10.0.0.5/a.png', 'https://192.168.1.1/a.png', 'https://169.254.169.254/latest', 'https://[::1]/a.png']) {
      const r = await post(msg({ url, mime_type: 'image/png' }))
      expect(r.status, url).toBe(400)
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('invalid_media')
    }
  })

  it('needs media.url and media.mime_type', async () => {
    expect((await post(msg({ mime_type: 'image/png' }))).status).toBe(400)
    expect((await post({ recipient: { wallet_id: 'W-x' }, type: 'image', text: 'no media' })).status).toBe(400)
  })

  it('stores nothing for a refused file, not even the user', async () => {
    fileServer = await startFileServer({})
    await post({ ...msg({ url: fileServer.url('/missing.png'), mime_type: 'image/png' }), recipient: { wallet_id: 'W-never-created' } })
    expect(await h.gw.store.findSubjectByWallet(h.workspace, 'W-never-created')).toBeNull()
  })
})
