import { describe, it, expect, vi } from 'vitest'
import {
  isAllowedPostMediaUrl,
  isMirroredPostMedia,
  keepPostMedia,
  mirrorPostMedia,
  postMediaFileName,
  POST_MEDIA_MAX_BYTES,
} from './mirror-post-media'

const ACCT = '11111111-1111-1111-1111-111111111111'
const SOURCE = 'https://scontent-kul2-1.cdninstagram.com/v/t51/pic.jpg?oe=68F0A1B2&oh=sig'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

function storage(over: { uploadError?: { message: string } | null } = {}) {
  const uploads: { bucket: string; path: string; type: string; upsert: boolean; bytes: number }[] = []
  const db = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Uint8Array, opts: { contentType: string; upsert: boolean }) => {
          uploads.push({ bucket, path, type: opts.contentType, upsert: opts.upsert, bytes: body.byteLength })
          return { error: over.uploadError ?? null }
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://halo.test/storage/v1/object/public/${bucket}/${path}` } }),
      }),
    },
  } as never
  return { db, uploads }
}

const reply = (body: Uint8Array | string, type = 'image/jpeg', extra: Record<string, string> = {}) =>
  vi.fn(async () => new Response(body as BodyInit, { status: 200, headers: { 'content-type': type, ...extra } })) as unknown as typeof fetch

describe('which links are fetched', () => {
  it("only opens https links on Meta's picture hosts", () => {
    expect(isAllowedPostMediaUrl(SOURCE)).toBe(true)
    expect(isAllowedPostMediaUrl('https://scontent-kul2-1.xx.fbcdn.net/v/t15/a.jpg')).toBe(true)
    expect(isAllowedPostMediaUrl('https://lookaside.facebook.com/x.jpg')).toBe(true)
    // a server-side fetch must never be steerable at an internal address or someone else's host
    for (const bad of [
      'http://scontent.cdninstagram.com/a.jpg',
      'https://evil.example.com/a.jpg',
      'https://cdninstagram.com.evil.example.com/a.jpg',
      'https://notfbcdn.net/a.jpg',
      'https://user:pw@scontent.cdninstagram.com/a.jpg',
      'http://169.254.169.254/latest/meta-data',
      'https://localhost/a.jpg',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) expect(isAllowedPostMediaUrl(bad), bad).toBe(false)
  })
})

describe('the name of a copy', () => {
  it('is the same for the same post, differs between posts and providers, and cannot collide on a long id', () => {
    const a = postMediaFileName('facebook', '123456789012345_987654321098765', 'image/jpeg')
    expect(a).toBe(postMediaFileName('facebook', '123456789012345_987654321098765', 'image/jpeg'))
    expect(a).not.toBe(postMediaFileName('facebook', '123456789012345_987654321098766', 'image/jpeg'))
    expect(a).not.toBe(postMediaFileName('instagram', '123456789012345_987654321098765', 'image/jpeg'))
    expect(a).toMatch(/^facebook-[0-9a-f]{24}\.jpg$/)
    // short enough that the path builder's 40-character cap keeps all of it
    expect(a.replace(/\.[^.]+$/, '').length).toBeLessThanOrEqual(40)
  })
})

describe('keeping a copy', () => {
  it('stores the picture under the workspace, in the public bucket, overwriting any earlier copy, and returns the stored link', async () => {
    const s = storage()
    const url = await mirrorPostMedia({ db: s.db, accountId: ACCT, provider: 'instagram', externalPostId: '1789', sourceUrl: SOURCE, fetchImpl: reply(JPEG) })
    expect(s.uploads).toHaveLength(1)
    expect(s.uploads[0]).toMatchObject({ bucket: 'public-assets', type: 'image/jpeg', upsert: true, bytes: JPEG.byteLength })
    expect(s.uploads[0].path).toMatch(new RegExp(`^account-${ACCT}/comment-posts/instagram-[0-9a-f]{24}\\.jpg$`))
    expect(url).toBe(`https://halo.test/storage/v1/object/public/public-assets/${s.uploads[0].path}`)
    expect(isMirroredPostMedia(url, ACCT)).toBe(true)
    // another workspace's copy, an expiring Meta link and nothing at all are not "ours"
    expect(isMirroredPostMedia(url, '22222222-2222-2222-2222-222222222222')).toBe(false)
    expect(isMirroredPostMedia(SOURCE, ACCT)).toBe(false)
    expect(isMirroredPostMedia(null, ACCT)).toBe(false)
  })

  it('does not follow a redirect, so a link on an allowed host cannot send the server somewhere else', async () => {
    const f = reply(JPEG)
    await mirrorPostMedia({ db: storage().db, accountId: ACCT, provider: 'facebook', externalPostId: 'p', sourceUrl: SOURCE, fetchImpl: f })
    expect((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].redirect).toBe('error')
  })

  it('skips anything that is not a picture, is empty, or is too big — without uploading', async () => {
    for (const f of [
      reply('<html>', 'text/html'),
      reply(JPEG, 'video/mp4'),
      reply(new Uint8Array(0)),
      reply(new Uint8Array(POST_MEDIA_MAX_BYTES + 1)),
      reply(JPEG, 'image/jpeg', { 'content-length': String(POST_MEDIA_MAX_BYTES + 1) }),
      vi.fn(async () => new Response('gone', { status: 403 })) as unknown as typeof fetch,
      vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch,
    ]) {
      const s = storage()
      expect(await mirrorPostMedia({ db: s.db, accountId: ACCT, provider: 'facebook', externalPostId: 'p', sourceUrl: SOURCE, fetchImpl: f })).toBeNull()
      expect(s.uploads).toHaveLength(0)
    }
  })

  it('returns null, and never throws, when the upload is refused or the storage is missing', async () => {
    const s = storage({ uploadError: { message: 'mime type not allowed' } })
    expect(await mirrorPostMedia({ db: s.db, accountId: ACCT, provider: 'facebook', externalPostId: 'p', sourceUrl: SOURCE, fetchImpl: reply(JPEG) })).toBeNull()
    expect(await mirrorPostMedia({ db: {} as never, accountId: ACCT, provider: 'facebook', externalPostId: 'p', sourceUrl: SOURCE, fetchImpl: reply(JPEG) })).toBeNull()
  })

  it('never fetches a link from a host that is not Meta, nor when there is no link', async () => {
    const f = reply(JPEG)
    expect(await mirrorPostMedia({ db: storage().db, accountId: ACCT, provider: 'facebook', externalPostId: 'p', sourceUrl: 'https://evil.example.com/a.jpg', fetchImpl: f })).toBeNull()
    expect(await mirrorPostMedia({ db: storage().db, accountId: ACCT, provider: 'facebook', externalPostId: 'p', sourceUrl: null, fetchImpl: f })).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it("falls back to Meta's own link when a copy cannot be made, so a webhook never ends up with less than it had", async () => {
    const down = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    expect(await keepPostMedia({ db: storage().db, accountId: ACCT, provider: 'instagram', externalPostId: 'p', sourceUrl: SOURCE, fetchImpl: down })).toBe(SOURCE)
    expect(await keepPostMedia({ db: storage().db, accountId: ACCT, provider: 'instagram', externalPostId: 'p', sourceUrl: null })).toBeNull()
  })
})
