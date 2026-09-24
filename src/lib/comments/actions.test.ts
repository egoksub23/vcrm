import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb, type FakeDb } from './fake-db'
import { MetaApiError } from '@/lib/meta/errors'

const h = vi.hoisted(() => ({
  replyFacebookComment: vi.fn(),
  replyInstagramComment: vi.fn(),
  sendPrivateReply: vi.fn(),
  setFacebookCommentHidden: vi.fn(),
  setInstagramCommentHidden: vi.fn(),
  deleteMetaComment: vi.fn(),
  replyToTikTokComment: vi.fn(),
  setTikTokCommentHidden: vi.fn(),
  deleteTikTokComment: vi.fn(),
  getTikTokAccess: vi.fn(),
  findOrCreateContactByExternalId: vi.fn(),
  findOrCreateConversation: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}` }))
vi.mock('./meta-comments', () => ({
  replyFacebookComment: h.replyFacebookComment,
  replyInstagramComment: h.replyInstagramComment,
  sendPrivateReply: h.sendPrivateReply,
  setFacebookCommentHidden: h.setFacebookCommentHidden,
  setInstagramCommentHidden: h.setInstagramCommentHidden,
  deleteMetaComment: h.deleteMetaComment,
}))
vi.mock('./tiktok/api', () => ({
  replyToTikTokComment: h.replyToTikTokComment,
  setTikTokCommentHidden: h.setTikTokCommentHidden,
  deleteTikTokComment: h.deleteTikTokComment,
  TikTokApiError: class TikTokApiError extends Error {},
}))
vi.mock('./tiktok/connection', () => ({
  getTikTokAccess: h.getTikTokAccess,
  TikTokReauthRequired: class TikTokReauthRequired extends Error {},
}))
vi.mock('@/lib/meta/contact-identity', () => ({ findOrCreateContactByExternalId: h.findOrCreateContactByExternalId }))
vi.mock('@/lib/conversations/find-or-create', () => ({ findOrCreateConversation: h.findOrCreateConversation }))

import { performCommentAction } from './actions'

const ACCT = 'acct-1'
const CTX = { accountId: ACCT, userId: 'agent-1' }

function setup(opts: { provider?: 'facebook' | 'instagram' | 'tiktok'; comment?: Record<string, unknown>; isTest?: boolean } = {}) {
  const provider = opts.provider ?? 'facebook'
  const f = makeFakeDb({
    messenger_config: [{ account_id: ACCT, page_id: 'PAGE', page_access_token: 'enc-fb', connected_by_user_id: 'owner-1', status: 'connected', enabled: true }],
    instagram_config: [{ account_id: ACCT, page_id: 'PAGE', ig_business_account_id: 'IG', page_access_token: 'enc-ig', connected_by_user_id: 'owner-1', status: 'connected', enabled: true }],
    comment_posts: [{ id: 'post-1', account_id: ACCT, provider, channel_ref_id: 'ref', external_post_id: 'ext-post-1', source: 'organic' }],
    comments: [{
      id: 'c-1', account_id: ACCT, post_id: 'post-1', provider, external_comment_id: 'ext-c1', parent_comment_id: null,
      parent_external_id: null, direction: 'inbound', author_external_id: 'user-1', author_name: 'Aisha', text: 'Price?',
      status: 'visible', handled_status: 'open', private_replied_at: null, is_test: opts.isTest ?? false,
      provider_created_at: new Date(Date.now() - 3600_000).toISOString(), ...opts.comment,
    }],
  })
  return f
}

const comment = (f: FakeDb) => f.tables.comments.find((c) => c.id === 'c-1')!
const audits = (f: FakeDb) => f.tables.comment_actions ?? []

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset())
  h.replyFacebookComment.mockResolvedValue({ id: 'reply-fb-1' })
  h.replyInstagramComment.mockResolvedValue({ id: 'reply-ig-1' })
  h.sendPrivateReply.mockResolvedValue({ recipientId: 'psid-1', messageId: 'mid-1' })
  h.replyToTikTokComment.mockResolvedValue({ commentId: 'reply-tt-1' })
  h.getTikTokAccess.mockResolvedValue({ accountId: ACCT, openId: 'open-1', token: 'tt-token' })
  h.findOrCreateContactByExternalId.mockResolvedValue({ contact: { id: 'contact-1' }, wasCreated: true })
  h.findOrCreateConversation.mockResolvedValue({ conversation: { id: 'conv-1' }, created: true })
})

describe('reply', () => {
  it('posts a Facebook reply, records it, and marks the comment replied', async () => {
    const f = setup()
    const r = await performCommentAction(f.db, CTX, 'c-1', 'reply', '  Thanks, DM us!  ')
    expect(r.ok).toBe(true)
    expect(h.replyFacebookComment).toHaveBeenCalledWith({ commentId: 'ext-c1', token: 'dec:enc-fb', message: 'Thanks, DM us!' })
    expect(comment(f).handled_status).toBe('replied')
    const outbound = f.tables.comments.find((c) => c.external_comment_id === 'reply-fb-1')
    expect(outbound).toMatchObject({ direction: 'outbound', text: 'Thanks, DM us!', parent_external_id: 'ext-c1' })
    expect(audits(f)[0]).toMatchObject({ action: 'reply', status: 'success', actor_user_id: 'agent-1', provider_object_id: 'reply-fb-1' })
  })

  it('replies to the top-level comment when the comment is itself a reply', async () => {
    const f = setup({ comment: { parent_external_id: 'ext-parent', parent_comment_id: 'p-1' } })
    await performCommentAction(f.db, CTX, 'c-1', 'reply', 'ok')
    expect(h.replyFacebookComment.mock.calls[0][0].commentId).toBe('ext-parent')
  })

  it('rejects an empty reply and an over-long one without calling the provider', async () => {
    const f = setup({ provider: 'instagram' })
    expect(await performCommentAction(f.db, CTX, 'c-1', 'reply', '   ')).toMatchObject({ ok: false, status: 400 })
    expect(await performCommentAction(f.db, CTX, 'c-1', 'reply', 'x'.repeat(2201))).toMatchObject({ ok: false, status: 400 })
    expect(h.replyInstagramComment).not.toHaveBeenCalled()
    expect(audits(f)).toHaveLength(0)
  })

  it('blocks an Instagram reply to a reply', async () => {
    const f = setup({ provider: 'instagram', comment: { parent_comment_id: 'p-1', parent_external_id: 'ext-parent' } })
    const r = await performCommentAction(f.db, CTX, 'c-1', 'reply', 'hi')
    expect(r).toMatchObject({ ok: false, status: 409, reason: 'igReplyToReply' })
    expect(h.replyInstagramComment).not.toHaveBeenCalled()
  })

  it('replies on TikTok to the video and top-level comment id', async () => {
    const f = setup({ provider: 'tiktok', comment: { parent_external_id: 'tt-parent' } })
    await performCommentAction(f.db, CTX, 'c-1', 'reply', 'thanks')
    expect(h.replyToTikTokComment).toHaveBeenCalledWith({ token: 'tt-token', openId: 'open-1', videoId: 'ext-post-1', commentId: 'tt-parent', text: 'thanks' })
  })

  it('says so when the channel is not connected', async () => {
    const f = setup({ provider: 'tiktok' })
    h.getTikTokAccess.mockResolvedValue(null)
    expect(await performCommentAction(f.db, CTX, 'c-1', 'reply', 'hi')).toMatchObject({ ok: false, status: 409, reason: 'notConnected' })
  })

  it('returns 404 for a comment in another account', async () => {
    const f = setup()
    expect(await performCommentAction(f.db, { accountId: 'other', userId: 'u' }, 'c-1', 'reply', 'hi')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('private reply', () => {
  it('sends the DM, files it in a chat, links the contact, and blocks a second one', async () => {
    const f = setup()
    const r = await performCommentAction(f.db, CTX, 'c-1', 'private_reply', 'Hi Aisha, DM here')
    expect(r.ok).toBe(true)
    expect(h.sendPrivateReply).toHaveBeenCalledWith({ senderId: 'PAGE', commentId: 'ext-c1', token: 'dec:enc-fb', text: 'Hi Aisha, DM here' })
    expect(comment(f)).toMatchObject({ contact_id: 'contact-1', handled_status: 'replied' })
    expect(comment(f).private_replied_at).toBeTruthy()
    expect(h.findOrCreateContactByExternalId).toHaveBeenCalledWith(f.db, expect.objectContaining({ column: 'messenger_psid', externalId: 'psid-1', configOwnerUserId: 'owner-1' }))
    expect(f.tables.messages[0]).toMatchObject({ conversation_id: 'conv-1', sender_type: 'agent', sender_id: 'agent-1', channel_type: 'messenger', message_id: 'mid-1', content_text: 'Hi Aisha, DM here' })

    const again = await performCommentAction(f.db, CTX, 'c-1', 'private_reply', 'again')
    expect(again).toMatchObject({ ok: false, status: 409, reason: 'privateAlready' })
    expect(h.sendPrivateReply).toHaveBeenCalledTimes(1)
  })

  it('uses the Instagram account and IGSID column for Instagram', async () => {
    const f = setup({ provider: 'instagram' })
    await performCommentAction(f.db, CTX, 'c-1', 'private_reply', 'hey')
    expect(h.sendPrivateReply.mock.calls[0][0].senderId).toBe('IG')
    expect(h.findOrCreateContactByExternalId.mock.calls[0][1].column).toBe('instagram_igsid')
    expect(f.tables.messages[0].channel_type).toBe('instagram')
  })

  it('refuses after seven days', async () => {
    const f = setup({ comment: { provider_created_at: new Date(Date.now() - 8 * 86_400_000).toISOString() } })
    expect(await performCommentAction(f.db, CTX, 'c-1', 'private_reply', 'late')).toMatchObject({ ok: false, reason: 'privateExpired' })
    expect(h.sendPrivateReply).not.toHaveBeenCalled()
  })

  it('is not available on TikTok', async () => {
    const f = setup({ provider: 'tiktok' })
    expect(await performCommentAction(f.db, CTX, 'c-1', 'private_reply', 'hi')).toMatchObject({ ok: false, reason: 'privateUnsupported' })
  })

  it('still succeeds when the DM was sent but filing it in a chat fails', async () => {
    const f = setup()
    h.findOrCreateContactByExternalId.mockRejectedValue(new Error('db down'))
    const r = await performCommentAction(f.db, CTX, 'c-1', 'private_reply', 'hi')
    expect(r.ok).toBe(true)
    expect(comment(f).private_replied_at).toBeTruthy()
  })
})

describe('hide, unhide, delete', () => {
  it('hides and unhides a Facebook comment', async () => {
    const f = setup()
    await performCommentAction(f.db, CTX, 'c-1', 'hide')
    expect(h.setFacebookCommentHidden).toHaveBeenCalledWith({ commentId: 'ext-c1', token: 'dec:enc-fb', hidden: true })
    expect(comment(f).status).toBe('hidden')
    await performCommentAction(f.db, CTX, 'c-1', 'unhide')
    expect(h.setFacebookCommentHidden).toHaveBeenLastCalledWith({ commentId: 'ext-c1', token: 'dec:enc-fb', hidden: false })
    expect(comment(f).status).toBe('visible')
  })

  it('hides a TikTok comment', async () => {
    const f = setup({ provider: 'tiktok' })
    await performCommentAction(f.db, CTX, 'c-1', 'hide')
    expect(h.setTikTokCommentHidden).toHaveBeenCalledWith({ token: 'tt-token', openId: 'open-1', videoId: 'ext-post-1', commentId: 'ext-c1', hidden: true })
  })

  it('deletes a Facebook comment', async () => {
    const f = setup()
    await performCommentAction(f.db, CTX, 'c-1', 'delete')
    expect(h.deleteMetaComment).toHaveBeenCalledWith({ commentId: 'ext-c1', token: 'dec:enc-fb' })
    expect(comment(f).status).toBe('deleted')
  })

  it('will not delete someone elses TikTok comment', async () => {
    const f = setup({ provider: 'tiktok' })
    expect(await performCommentAction(f.db, CTX, 'c-1', 'delete')).toMatchObject({ ok: false, status: 409, reason: 'deleteTiktokOwnOnly' })
    expect(h.deleteTikTokComment).not.toHaveBeenCalled()
  })

  it('can delete our own TikTok comment', async () => {
    const f = setup({ provider: 'tiktok', comment: { direction: 'outbound' } })
    await performCommentAction(f.db, CTX, 'c-1', 'delete')
    expect(h.deleteTikTokComment).toHaveBeenCalledWith({ token: 'tt-token', openId: 'open-1', commentId: 'ext-c1' })
  })

  it('does nothing more to a deleted comment', async () => {
    const f = setup({ comment: { status: 'deleted' } })
    expect(await performCommentAction(f.db, CTX, 'c-1', 'hide')).toMatchObject({ ok: false, reason: 'deleted' })
  })
})

describe('sample comments', () => {
  it('simulate every action and never call a provider', async () => {
    const f = setup({ isTest: true })
    expect((await performCommentAction(f.db, CTX, 'c-1', 'reply', 'hello')).ok).toBe(true)
    expect((await performCommentAction(f.db, CTX, 'c-1', 'private_reply', 'dm')).ok).toBe(true)
    expect((await performCommentAction(f.db, CTX, 'c-1', 'hide')).ok).toBe(true)
    expect((await performCommentAction(f.db, CTX, 'c-1', 'delete')).ok).toBe(true)
    for (const m of Object.values(h)) expect(m).not.toHaveBeenCalled()
    expect(comment(f).status).toBe('deleted')
    expect(f.tables.comments.find((c) => c.direction === 'outbound')).toMatchObject({ is_test: true, text: 'hello' })
  })
})

describe('provider errors', () => {
  it('flags the channel for reconnect on an expired token (code 190) and audits the failure', async () => {
    const f = setup()
    h.replyFacebookComment.mockRejectedValue(new MetaApiError('Error validating access token', { code: 190, httpStatus: 400 }))
    const r = await performCommentAction(f.db, CTX, 'c-1', 'reply', 'hi')
    expect(r).toMatchObject({ ok: false, status: 409, reason: 'reconnect' })
    expect(f.tables.messenger_config[0].needs_reauth).toBe(true)
    expect(audits(f)[0]).toMatchObject({ action: 'reply', status: 'failed', error_message: 'Error validating access token' })
    expect(comment(f).handled_status).toBe('open')
  })

  it('reports other provider errors as a bad gateway and changes nothing', async () => {
    const f = setup()
    h.setFacebookCommentHidden.mockRejectedValue(new MetaApiError('Unsupported post request', { code: 100, httpStatus: 400 }))
    const r = await performCommentAction(f.db, CTX, 'c-1', 'hide')
    expect(r).toMatchObject({ ok: false, status: 502, error: 'Unsupported post request' })
    expect(comment(f).status).toBe('visible')
  })
})
