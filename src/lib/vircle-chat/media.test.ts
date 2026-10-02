import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ pinned: vi.fn(), mirror: vi.fn() }))
vi.mock('@/lib/net/safe-fetch', () => ({ pinnedFetch: h.pinned }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  mirrorInboundMedia: h.mirror,
}))

import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'

import { downloadGatewayFile, guessMimeType, mimeMatchesKind, mirrorUserFile } from './media'

beforeEach(() => {
  h.pinned.mockReset()
  h.mirror.mockReset()
})

describe('mimeMatchesKind', () => {
  it('requires the declared type to fit the kind', () => {
    expect(mimeMatchesKind('image', 'image/png')).toBe(true)
    expect(mimeMatchesKind('image', 'IMAGE/JPEG; charset=x')).toBe(true)
    expect(mimeMatchesKind('image', 'application/pdf')).toBe(false)
    expect(mimeMatchesKind('video', 'video/mp4')).toBe(true)
    expect(mimeMatchesKind('audio', 'audio/ogg')).toBe(true)
    expect(mimeMatchesKind('audio', 'image/png')).toBe(false)
    expect(mimeMatchesKind('document', 'application/pdf')).toBe(true)
    expect(mimeMatchesKind('image', 'nonsense')).toBe(false)
  })
})

describe('guessMimeType', () => {
  it('reads the extension of a name or an address, ignoring a query', () => {
    expect(guessMimeType('photo.PNG')).toBe('image/png')
    expect(guessMimeType('https://x.example/a/b/report.pdf?token=1#x')).toBe('application/pdf')
    expect(guessMimeType('voice.ogg')).toBe('audio/ogg')
  })
  it('falls back to a generic download', () => {
    expect(guessMimeType('noextension')).toBe('application/octet-stream')
    expect(guessMimeType('thing.xyz')).toBe('application/octet-stream')
    expect(guessMimeType(null)).toBe('application/octet-stream')
  })
})

describe('downloadGatewayFile', () => {
  const stream = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch)
        c.close()
      },
    })

  it('returns the bytes and the content type through the address-checking fetch', async () => {
    h.pinned.mockResolvedValue(new Response(stream([new Uint8Array([1, 2]), new Uint8Array([3])]), { headers: { 'content-type': 'image/png' } }))
    const out = await downloadGatewayFile({ downloadUrl: 'https://files.example/a', accessToken: '' })
    expect([...out.buffer]).toEqual([1, 2, 3])
    expect(out.contentType).toBe('image/png')
    expect(h.pinned.mock.calls[0][0]).toBe('https://files.example/a')
  })

  it('refuses a failed download, and one declared over the size limit before reading it', async () => {
    h.pinned.mockResolvedValueOnce(new Response('x', { status: 404 }))
    await expect(downloadGatewayFile({ downloadUrl: 'https://files.example/a', accessToken: '' })).rejects.toThrow(/404/)
    h.pinned.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(MEDIA_MAX_BYTES + 1) } }))
    await expect(downloadGatewayFile({ downloadUrl: 'https://files.example/a', accessToken: '' })).rejects.toThrow(/size limit/)
  })

  it('stops reading once the body outgrows the limit, whatever it declared', async () => {
    const big = new Uint8Array(MEDIA_MAX_BYTES)
    h.pinned.mockResolvedValue(new Response(stream([big, new Uint8Array(10)])))
    await expect(downloadGatewayFile({ downloadUrl: 'https://files.example/a', accessToken: '' })).rejects.toThrow(/size limit/)
  })

  it('passes a refused (private) address on as a failure', async () => {
    h.pinned.mockRejectedValue(new Error('Refusing to connect to a non-public address'))
    await expect(downloadGatewayFile({ downloadUrl: 'https://internal.example/a', accessToken: '' })).rejects.toThrow(/non-public/)
  })
})

describe('mirrorUserFile', () => {
  const media = { url: 'https://files.example/a', mimeType: 'image/png', fileName: 'a.png', sizeBytes: 10 }

  it('copies the file under a path built from plain characters of the gateway id', async () => {
    h.mirror.mockResolvedValue('https://x/storage/v1/object/public/chat-media/account-a/inbound/vc-m_77-a.png')
    const out = await mirrorUserFile({ storage: {} as never, accountId: 'a', serverId: 'm/77 ../x', kind: 'image', media, sentAt: '2026-10-02T09:15:00Z' })
    expect(out).toContain('/chat-media/')
    const args = h.mirror.mock.calls[0][0]
    expect(args.mediaId).toBe('vc-m77x')
    expect(args.downloadUrl).toBe('https://files.example/a')
    expect(args.messageTimestamp).toBe(1790932500)
    expect(args.download).toBe(downloadGatewayFile)
  })

  it('refuses a file whose type does not fit the message type, without fetching it', async () => {
    const out = await mirrorUserFile({ storage: {} as never, accountId: 'a', serverId: 'm1', kind: 'image', media: { ...media, mimeType: 'application/x-msdownload' }, sentAt: null })
    expect(out).toBeNull()
    expect(h.mirror).not.toHaveBeenCalled()
  })

  it('returns null when the copy itself fails', async () => {
    h.mirror.mockResolvedValue(null)
    expect(await mirrorUserFile({ storage: {} as never, accountId: 'a', serverId: 'm1', kind: 'image', media, sentAt: null })).toBeNull()
  })
})
