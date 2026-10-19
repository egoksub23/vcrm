import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from './fake-db'

const h = vi.hoisted(() => ({ getFacebookPost: vi.fn(), getInstagramMedia: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}` }))
vi.mock('./meta-comments', () => ({
  getFacebookPost: h.getFacebookPost,
  getInstagramMedia: h.getInstagramMedia,
}))

import { hasCommentChanges, processMetaCommentChanges } from './meta-webhook'

const ACCT = 'acct-1'
const seed = () =>
  makeFakeDb({
    messenger_config: [{ account_id: ACCT, page_id: 'PAGE', page_access_token: 'enc-fb', status: 'connected', enabled: true }],
    instagram_config: [{ account_id: ACCT, page_id: 'PAGE', ig_business_account_id: 'IG', page_access_token: 'enc-ig', status: 'connected', enabled: true }],
  })

const fbEntry = (value: Record<string, unknown>, time = 1758300000) => ({
  id: 'PAGE',
  time,
  changes: [{ field: 'feed', value: { item: 'comment', ...value } }],
})

beforeEach(() => {
  h.getFacebookPost.mockReset()
  h.getInstagramMedia.mockReset()
  h.getFacebookPost.mockResolvedValue({ message: 'Big sale', permalink_url: 'https://fb/p', full_picture: 'https://img', is_published: true })
  h.getInstagramMedia.mockResolvedValue({ caption: 'Behind the scenes', permalink: 'https://ig/p', thumbnail_url: 'https://thumb' })
})

describe('hasCommentChanges', () => {
  it('sees feed and comment fields, and ignores plain message events', () => {
    expect(hasCommentChanges({ id: 'x', changes: [{ field: 'feed' }] })).toBe(true)
    expect(hasCommentChanges({ id: 'x', changes: [{ field: 'comments' }] })).toBe(true)
    expect(hasCommentChanges({ id: 'x', changes: [{ field: 'live_comments' }] })).toBe(true)
    expect(hasCommentChanges({ id: 'x', changes: [{ field: 'mention' }] })).toBe(false)
    expect(hasCommentChanges({ id: 'x' })).toBe(false)
  })
})

describe('Facebook feed comments', () => {
  it('stores a new comment with the post context', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', fbEntry({
      verb: 'add', comment_id: 'P_1', post_id: 'PAGE_9', parent_id: 'PAGE_9',
      from: { id: 'u1', name: 'Aisha' }, message: 'How much?', created_time: 1758300000,
    }))
    expect(f.tables.comments).toHaveLength(1)
    expect(f.tables.comments[0]).toMatchObject({
      provider: 'facebook', external_comment_id: 'P_1', text: 'How much?', author_name: 'Aisha',
      author_external_id: 'u1', direction: 'inbound', parent_external_id: null,
    })
    expect(f.tables.comment_posts[0]).toMatchObject({ message: 'Big sale', permalink_url: 'https://fb/p', source: 'organic' })
    expect(h.getFacebookPost).toHaveBeenCalledWith({ postId: 'PAGE_9', token: 'dec:enc-fb' })
  })

  it('marks an unpublished (dark) post as an ad', async () => {
    h.getFacebookPost.mockResolvedValue({ message: 'Try free', is_published: false })
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'add', comment_id: 'P_1', post_id: 'PAGE_ad', from: { id: 'u1' }, message: 'hi' }))
    expect(f.tables.comment_posts[0].source).toBe('ad')
  })

  it('looks the post up only the first time', async () => {
    const f = seed()
    for (const id of ['P_1', 'P_2']) {
      await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'add', comment_id: id, post_id: 'PAGE_9', from: { id: 'u1' }, message: 'x', created_time: 1758300000 + (id === 'P_2' ? 5 : 0) }))
    }
    expect(h.getFacebookPost).toHaveBeenCalledTimes(1)
    expect(f.tables.comments).toHaveLength(2)
  })

  it('threads a reply to a comment and treats the post as the parent of top-level ones', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'add', comment_id: 'P_2', post_id: 'PAGE_9', parent_id: 'P_1', from: { id: 'u2' }, message: 'me too' }))
    expect(f.tables.comments[0].parent_external_id).toBe('P_1')
  })

  it('files the pages own comment as outbound', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'add', comment_id: 'P_3', post_id: 'PAGE_9', from: { id: 'PAGE', name: 'Our Page' }, message: 'Thanks!' }))
    expect(f.tables.comments[0]).toMatchObject({ direction: 'outbound', handled_status: 'resolved' })
  })

  it('drops a redelivered event', async () => {
    const f = seed()
    const e = fbEntry({ verb: 'add', comment_id: 'P_1', post_id: 'PAGE_9', from: { id: 'u1' }, message: 'x', created_time: 1758300000 })
    await processMetaCommentChanges(f.db, 'page', e)
    f.tables.comments[0].handled_status = 'resolved'
    await processMetaCommentChanges(f.db, 'page', e)
    expect(f.tables.comments).toHaveLength(1)
    expect(f.tables.comment_webhook_events).toHaveLength(1)
  })

  it.each(['remove', 'delete'])('marks a comment deleted on verb %s', async (verb) => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'add', comment_id: 'P_1', post_id: 'PAGE_9', from: { id: 'u1' }, message: 'x', created_time: 1 }))
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb, comment_id: 'P_1', post_id: 'PAGE_9', created_time: 2 }))
    expect(f.tables.comments[0].status).toBe('deleted')
  })

  it('updates the text on an edit without creating a second row', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'add', comment_id: 'P_1', post_id: 'PAGE_9', from: { id: 'u1' }, message: 'old', created_time: 1 }))
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'edited', comment_id: 'P_1', post_id: 'PAGE_9', from: { id: 'u1' }, message: 'new', created_time: 2 }))
    expect(f.tables.comments).toHaveLength(1)
    expect(f.tables.comments[0].text).toBe('new')
  })

  it('ignores reactions, posts and other feed items', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', { id: 'PAGE', changes: [{ field: 'feed', value: { item: 'reaction', verb: 'add' } }] })
    expect(f.tables.comments ?? []).toHaveLength(0)
  })

  it('ignores a page that is not connected', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', { ...fbEntry({ verb: 'add', comment_id: 'P_1', post_id: 'X_1', from: { id: 'u' } }), id: 'OTHER' })
    expect(f.tables.comments ?? []).toHaveLength(0)
  })

  it('survives the post lookup failing', async () => {
    h.getFacebookPost.mockRejectedValue(new Error('boom'))
    const f = seed()
    await processMetaCommentChanges(f.db, 'page', fbEntry({ verb: 'add', comment_id: 'P_1', post_id: 'PAGE_9', from: { id: 'u1' }, message: 'x' }))
    expect(f.tables.comments).toHaveLength(1)
  })
})

describe('Instagram comments', () => {
  const igEntry = (value: Record<string, unknown>, field = 'comments') => ({
    id: 'IG',
    time: 1758300000,
    changes: [{ field, value }],
  })

  it('stores a comment with the media context', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'instagram', igEntry({
      id: 'IC1', text: 'Is there an API?', from: { id: 'igsid-1', username: 'jason.tan' }, media: { id: 'M1', media_product_type: 'FEED' },
    }))
    expect(f.tables.comments[0]).toMatchObject({
      provider: 'instagram', external_comment_id: 'IC1', text: 'Is there an API?', author_username: 'jason.tan', author_external_id: 'igsid-1',
    })
    expect(f.tables.comment_posts[0]).toMatchObject({ message: 'Behind the scenes', media_type: 'feed', permalink_url: 'https://ig/p' })
  })

  it('also accepts live comments and resolves the account by page id', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'instagram', { ...igEntry({ id: 'IC2', text: 'hi', from: { id: 'x', username: 'u' }, media: { id: 'M2' } }, 'live_comments'), id: 'PAGE' })
    expect(f.tables.comments).toHaveLength(1)
  })

  it('threads replies and recognises our own', async () => {
    const f = seed()
    await processMetaCommentChanges(f.db, 'instagram', igEntry({ id: 'IC3', text: 'thanks', parent_id: 'IC1', from: { id: 'IG', username: 'us' }, media: { id: 'M1' } }))
    expect(f.tables.comments[0]).toMatchObject({ parent_external_id: 'IC1', direction: 'outbound' })
  })

  // Meta's picture links expire in about a week; the post keeps a copy of its own instead.
  describe('the post picture', () => {
    const META_LINK = 'https://scontent-kul2-1.cdninstagram.com/v/pic.jpg?oe=68F0A1B2'
    const withStorage = (f: ReturnType<typeof seed>, uploadError: { message: string } | null = null) => {
      const uploads: string[] = []
      ;(f.db as unknown as { storage: unknown }).storage = {
        from: (bucket: string) => ({
          upload: async (path: string) => (uploads.push(`${bucket}/${path}`), { error: uploadError }),
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://halo.test/storage/v1/object/public/${bucket}/${path}` } }),
        }),
      }
      return uploads
    }
    const comment = () => igEntry({ id: 'IC9', text: 'hi', from: { id: 'x', username: 'u' }, media: { id: 'M9' } })

    it('keeps a copy in our storage and stores that link, not Meta\'s', async () => {
      h.getInstagramMedia.mockResolvedValue({ thumbnail_url: META_LINK })
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 1, 2]), { status: 200, headers: { 'content-type': 'image/jpeg' } })))
      const f = seed()
      const uploads = withStorage(f)
      await processMetaCommentChanges(f.db, 'instagram', comment())
      expect(uploads).toHaveLength(1)
      expect(uploads[0]).toMatch(/^public-assets\/account-acct-1\/comment-posts\/instagram-[0-9a-f]{24}\.jpg$/)
      expect(f.tables.comment_posts[0].media_url).toBe(`https://halo.test/storage/v1/object/public/${uploads[0]}`)
      expect(f.tables.comment_posts[0].media_url).not.toContain('cdninstagram')
      vi.unstubAllGlobals()
    })

    it('still stores the comment, with Meta\'s link as the fallback, when the copy fails', async () => {
      h.getInstagramMedia.mockResolvedValue({ thumbnail_url: META_LINK })
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('cdn down') }))
      const f = seed()
      withStorage(f)
      await processMetaCommentChanges(f.db, 'instagram', comment())
      expect(f.tables.comments).toHaveLength(1)
      expect(f.tables.comment_posts[0].media_url).toBe(META_LINK)
      vi.unstubAllGlobals()
    })

    it('does not copy again for a post it already has', async () => {
      h.getInstagramMedia.mockResolvedValue({ thumbnail_url: META_LINK })
      const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
      vi.stubGlobal('fetch', fetchSpy)
      const f = seed()
      withStorage(f)
      await processMetaCommentChanges(f.db, 'instagram', comment())
      await processMetaCommentChanges(f.db, 'instagram', igEntry({ id: 'IC10', text: 'again', from: { id: 'y', username: 'v' }, media: { id: 'M9' } }, 'comments'))
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      vi.unstubAllGlobals()
    })
  })
})
