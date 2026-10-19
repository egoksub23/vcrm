import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from './fake-db'

const h = vi.hoisted(() => ({ getFacebookPost: vi.fn(), getInstagramMedia: vi.fn(), mirror: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => (s === 'bad' ? (() => { throw new Error('bad key') })() : `dec:${s}`) }))
vi.mock('./meta-comments', () => ({ getFacebookPost: h.getFacebookPost, getInstagramMedia: h.getInstagramMedia }))
vi.mock('./mirror-post-media', async (importOriginal) => ({ ...(await importOriginal<typeof import('./mirror-post-media')>()), mirrorPostMedia: h.mirror }))

import { refreshPostMedia } from './refresh-post-media'

const ACCT = 'acct-1'
const DEAD = 'https://scontent-kul2-1.cdninstagram.com/v/old.jpg?oe=68F0A1B2'
const FRESH = 'https://scontent-kul2-1.cdninstagram.com/v/new.jpg?oe=69999999'
const OURS = `https://halo.test/storage/v1/object/public/public-assets/account-${ACCT}/comment-posts/instagram-abc.jpg`

const seed = (post: Record<string, unknown> = {}) =>
  makeFakeDb({
    comment_posts: [{ id: 'post-1', account_id: ACCT, provider: 'instagram', channel_ref_id: 'IG', external_post_id: 'M1', media_url: DEAD, ...post }],
    messenger_config: [{ account_id: ACCT, page_id: 'PAGE', page_access_token: 'enc-fb', status: 'connected' }],
    instagram_config: [{ account_id: ACCT, ig_business_account_id: 'IG', page_access_token: 'enc-ig', status: 'connected' }],
  })

beforeEach(() => {
  h.getFacebookPost.mockReset()
  h.getInstagramMedia.mockReset().mockResolvedValue({ thumbnail_url: FRESH })
  h.mirror.mockReset().mockResolvedValue(OURS)
})

describe('refreshPostMedia', () => {
  it('asks Meta again with the workspace token, keeps a copy, and points the post at it', async () => {
    const f = seed()
    const r = await refreshPostMedia(f.db, ACCT, 'post-1')
    expect(h.getInstagramMedia).toHaveBeenCalledWith({ mediaId: 'M1', token: 'dec:enc-ig' })
    expect(h.mirror).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCT, provider: 'instagram', externalPostId: 'M1', sourceUrl: FRESH }))
    expect(r).toEqual({ ok: true, mediaUrl: OURS, changed: true })
    expect(f.tables.comment_posts[0].media_url).toBe(OURS)
  })

  it('uses the Facebook page token for a Facebook post, and its picture field', async () => {
    h.getFacebookPost.mockResolvedValue({ full_picture: 'https://scontent.xx.fbcdn.net/new.jpg' })
    const f = seed({ provider: 'facebook', channel_ref_id: 'PAGE', external_post_id: 'PAGE_9' })
    await refreshPostMedia(f.db, ACCT, 'post-1')
    expect(h.getFacebookPost).toHaveBeenCalledWith({ postId: 'PAGE_9', token: 'dec:enc-fb' })
    expect(h.mirror).toHaveBeenCalledWith(expect.objectContaining({ provider: 'facebook', sourceUrl: 'https://scontent.xx.fbcdn.net/new.jpg' }))
  })

  it('does not ask Meta when the post already points at our own copy', async () => {
    const f = seed({ media_url: OURS })
    expect(await refreshPostMedia(f.db, ACCT, 'post-1')).toEqual({ ok: true, mediaUrl: OURS, changed: false })
    expect(h.getInstagramMedia).not.toHaveBeenCalled()
    expect(h.mirror).not.toHaveBeenCalled()
  })

  it('still stores the fresh link when a copy cannot be made, so the picture shows for a while', async () => {
    h.mirror.mockResolvedValue(null)
    const f = seed()
    expect(await refreshPostMedia(f.db, ACCT, 'post-1')).toEqual({ ok: true, mediaUrl: FRESH, changed: true })
    expect(f.tables.comment_posts[0].media_url).toBe(FRESH)
  })

  it("says why it could not, and leaves the post as it was: another workspace's post, a provider it cannot repair, no page, a post Meta no longer has", async () => {
    expect(await refreshPostMedia(seed().db, 'acct-2', 'post-1')).toEqual({ ok: false, reason: 'not_found' })
    expect(await refreshPostMedia(seed().db, ACCT, 'nope')).toEqual({ ok: false, reason: 'not_found' })
    expect(await refreshPostMedia(seed({ provider: 'tiktok' }).db, ACCT, 'post-1')).toEqual({ ok: false, reason: 'unsupported' })

    const noPage = seed({ channel_ref_id: 'SOME-OTHER-IG' })
    expect(await refreshPostMedia(noPage.db, ACCT, 'post-1')).toEqual({ ok: false, reason: 'not_connected' })
    const unreadable = makeFakeDb({
      comment_posts: [{ id: 'post-1', account_id: ACCT, provider: 'instagram', channel_ref_id: 'IG', external_post_id: 'M1', media_url: DEAD }],
      instagram_config: [{ account_id: ACCT, ig_business_account_id: 'IG', page_access_token: 'bad', status: 'connected' }],
    })
    expect(await refreshPostMedia(unreadable.db, ACCT, 'post-1')).toEqual({ ok: false, reason: 'not_connected' })

    h.getInstagramMedia.mockResolvedValue(null)
    const gone = seed()
    expect(await refreshPostMedia(gone.db, ACCT, 'post-1')).toEqual({ ok: false, reason: 'unavailable' })
    expect(gone.tables.comment_posts[0].media_url).toBe(DEAD)
  })

  it('does not use a disconnected page', async () => {
    const f = makeFakeDb({
      comment_posts: [{ id: 'post-1', account_id: ACCT, provider: 'instagram', channel_ref_id: 'IG', external_post_id: 'M1', media_url: DEAD }],
      instagram_config: [{ account_id: ACCT, ig_business_account_id: 'IG', page_access_token: 'enc-ig', status: 'disconnected' }],
    })
    expect(await refreshPostMedia(f.db, ACCT, 'post-1')).toEqual({ ok: false, reason: 'not_connected' })
    expect(h.getInstagramMedia).not.toHaveBeenCalled()
  })
})
