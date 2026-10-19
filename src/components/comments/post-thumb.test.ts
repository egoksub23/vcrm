import { describe, it, expect, vi } from 'vitest'

import { repairPostPicture } from './post-thumb'

const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('repairing a dead post picture', () => {
  it('asks the server once for the post and returns the new link', async () => {
    const f = ok({ media_url: 'https://halo.test/storage/v1/object/public/public-assets/account-a/comment-posts/x.jpg', changed: true })
    expect(await repairPostPicture('post-a', f)).toBe('https://halo.test/storage/v1/object/public/public-assets/account-a/comment-posts/x.jpg')
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('/api/comments/posts/post-a/refresh-media')
    expect(init.method).toBe('POST')
  })

  it('is asked once per post however many places draw it: the list and the open thread share one repair', async () => {
    const f = ok({ media_url: 'https://x/y.jpg' })
    const [a, b] = await Promise.all([repairPostPicture('post-b', f), repairPostPicture('post-b', f)])
    expect(a).toBe(b)
    expect(await repairPostPicture('post-b', f)).toBe('https://x/y.jpg')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('gives up quietly, and does not ask again, for a post Meta no longer has', async () => {
    const f = ok({ error: 'The picture is not available.', reason: 'unavailable' }, 409)
    expect(await repairPostPicture('post-c', f)).toBeNull()
    expect(await repairPostPicture('post-c', f)).toBeNull()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('treats a network failure or an answer with no link as "no picture"', async () => {
    expect(await repairPostPicture('post-d', vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
    expect(await repairPostPicture('post-e', ok({ media_url: '' }))).toBeNull()
    expect(await repairPostPicture('post-f', ok({ nothing: true }))).toBeNull()
    expect(await repairPostPicture('post-g', vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch)).toBeNull()
  })

  it('encodes the post id into the path', async () => {
    const f = ok({ media_url: 'https://x/z.jpg' })
    await repairPostPicture('a/b?c', f)
    expect((f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]).toBe('/api/comments/posts/a%2Fb%3Fc/refresh-media')
  })
})
