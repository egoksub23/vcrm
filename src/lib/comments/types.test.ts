import { describe, it, expect } from 'vitest'
import { commentCapabilities, PRIVATE_REPLY_WINDOW_MS, replyTargetExternalId } from './types'

const NOW = Date.parse('2026-09-20T12:00:00Z')
const base = {
  provider: 'facebook' as const,
  direction: 'inbound' as const,
  status: 'visible' as const,
  parent_comment_id: null,
  author_external_id: 'user-1',
  private_replied_at: null,
  provider_created_at: '2026-09-19T12:00:00Z',
}

describe('commentCapabilities', () => {
  it('allows everything on a fresh Facebook comment', () => {
    const c = commentCapabilities(base, NOW)
    expect(c).toMatchObject({ reply: true, privateReply: true, hide: true, unhide: false, delete: true })
  })

  it('offers unhide instead of hide for a hidden comment', () => {
    const c = commentCapabilities({ ...base, status: 'hidden' }, NOW)
    expect(c.hide).toBe(false)
    expect(c.unhide).toBe(true)
  })

  it('turns everything off for a deleted comment', () => {
    const c = commentCapabilities({ ...base, status: 'deleted' }, NOW)
    expect([c.reply, c.privateReply, c.hide, c.unhide, c.delete]).toEqual([false, false, false, false, false])
    expect(c.reasons.reply).toBe('deleted')
  })

  it('allows only delete on our own comment', () => {
    const c = commentCapabilities({ ...base, direction: 'outbound' }, NOW)
    expect(c).toMatchObject({ reply: false, privateReply: false, hide: false, unhide: false, delete: true })
    expect(c.reasons.reply).toBe('ownComment')
  })

  describe('private reply', () => {
    it('is off after one has been sent', () => {
      const c = commentCapabilities({ ...base, private_replied_at: '2026-09-20T01:00:00Z' }, NOW)
      expect(c.privateReply).toBe(false)
      expect(c.reasons.private_reply).toBe('privateAlready')
    })

    it('expires after seven days', () => {
      const old = new Date(NOW - PRIVATE_REPLY_WINDOW_MS - 1000).toISOString()
      const c = commentCapabilities({ ...base, provider_created_at: old }, NOW)
      expect(c.privateReply).toBe(false)
      expect(c.reasons.private_reply).toBe('privateExpired')
    })

    it('is still on just inside the window', () => {
      const inside = new Date(NOW - PRIVATE_REPLY_WINDOW_MS + 60_000).toISOString()
      expect(commentCapabilities({ ...base, provider_created_at: inside }, NOW).privateReply).toBe(true)
    })

    it('needs to know who wrote the comment', () => {
      const c = commentCapabilities({ ...base, author_external_id: null }, NOW)
      expect(c.reasons.private_reply).toBe('privateNoAuthor')
    })
  })

  describe('instagram', () => {
    const ig = { ...base, provider: 'instagram' as const }
    it('replies to a top-level comment', () => {
      expect(commentCapabilities(ig, NOW).reply).toBe(true)
    })
    it('cannot reply to a reply', () => {
      const c = commentCapabilities({ ...ig, parent_comment_id: 'p' }, NOW)
      expect(c.reply).toBe(false)
      expect(c.reasons.reply).toBe('igReplyToReply')
    })
    it('cannot reply to a hidden comment', () => {
      const c = commentCapabilities({ ...ig, status: 'hidden' }, NOW)
      expect(c.reasons.reply).toBe('igHidden')
    })
  })

  describe('tiktok', () => {
    const tt = { ...base, provider: 'tiktok' as const }
    it('has no private reply', () => {
      const c = commentCapabilities(tt, NOW)
      expect(c.privateReply).toBe(false)
      expect(c.reasons.private_reply).toBe('privateUnsupported')
    })
    it("cannot delete other people's comments, but can hide them", () => {
      const c = commentCapabilities(tt, NOW)
      expect(c.delete).toBe(false)
      expect(c.reasons.delete).toBe('deleteTiktokOwnOnly')
      expect(c.hide).toBe(true)
    })
    it('can delete its own', () => {
      expect(commentCapabilities({ ...tt, direction: 'outbound' }, NOW).delete).toBe(true)
    })
  })
})

describe('replyTargetExternalId', () => {
  it('replies to the parent when the comment is itself a reply', () => {
    expect(replyTargetExternalId({ external_comment_id: 'c2' }, 'c1')).toBe('c1')
  })
  it('replies to the comment when it is top-level', () => {
    expect(replyTargetExternalId({ external_comment_id: 'c1' }, null)).toBe('c1')
  })
})
