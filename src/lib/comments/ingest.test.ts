import { describe, it, expect } from 'vitest'
import { makeFakeDb } from './fake-db'
import { claimWebhookEvent, ingestComment, setCommentStatusByExternalId } from './ingest'

const ACCT = 'acct-1'
const POST = { provider: 'facebook' as const, channelRefId: 'page-1', externalPostId: 'page-1_post-1', message: 'Big sale' }
const at = new Date('2026-09-20T01:00:00Z')

describe('ingestComment', () => {
  it('creates the post and the comment', async () => {
    const f = makeFakeDb()
    const r = await ingestComment(f.db, ACCT, POST, {
      externalCommentId: 'c1', authorExternalId: 'u1', authorName: 'Aisha', text: 'Price?', providerCreatedAt: at,
    })
    expect(r?.isNew).toBe(true)
    expect(f.tables.comment_posts).toHaveLength(1)
    expect(f.tables.comments[0]).toMatchObject({
      account_id: ACCT, provider: 'facebook', external_comment_id: 'c1', text: 'Price?',
      direction: 'inbound', handled_status: 'open', status: 'visible', is_test: false,
    })
  })

  it('is idempotent: a re-delivery updates in place and reports it is not new', async () => {
    const f = makeFakeDb()
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', text: 'Price?', providerCreatedAt: at })
    const again = await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', text: 'Price? (edited)', providerCreatedAt: at })
    expect(again?.isNew).toBe(false)
    expect(f.tables.comments).toHaveLength(1)
    expect(f.tables.comments[0].text).toBe('Price? (edited)')
  })

  it('never resets what an agent did when the comment is updated', async () => {
    const f = makeFakeDb()
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', text: 'Price?', providerCreatedAt: at })
    f.tables.comments[0].handled_status = 'resolved'
    f.tables.comments[0].assigned_to = 'agent-1'
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', text: 'Price??', providerCreatedAt: at })
    expect(f.tables.comments[0]).toMatchObject({ handled_status: 'resolved', assigned_to: 'agent-1' })
  })

  it('does not blank fields the update did not mention', async () => {
    const f = makeFakeDb()
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', authorName: 'Aisha', text: 'Price?', providerCreatedAt: at })
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', status: 'hidden', providerCreatedAt: at })
    expect(f.tables.comments[0]).toMatchObject({ author_name: 'Aisha', text: 'Price?', status: 'hidden' })
  })

  it('files our own comments as resolved, not waiting for an answer', async () => {
    const f = makeFakeDb()
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c9', direction: 'outbound', text: 'Thanks!', providerCreatedAt: at })
    expect(f.tables.comments[0]).toMatchObject({ direction: 'outbound', handled_status: 'resolved' })
  })

  it('links a reply to its parent', async () => {
    const f = makeFakeDb()
    const parent = await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', text: 'a', providerCreatedAt: at })
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c2', parentExternalId: 'c1', text: 'b', providerCreatedAt: at })
    expect(f.tables.comments[1].parent_comment_id).toBe(parent?.commentId)
  })

  it('links a reply that arrived before its parent, once the parent shows up', async () => {
    const f = makeFakeDb()
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c2', parentExternalId: 'c1', text: 'b', providerCreatedAt: at })
    expect(f.tables.comments[0].parent_comment_id).toBeNull()
    const parent = await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', text: 'a', providerCreatedAt: at })
    expect(f.tables.comments.find((c) => c.external_comment_id === 'c2')?.parent_comment_id).toBe(parent?.commentId)
  })

  it('matches a Facebook commenter to a contact we already message', async () => {
    const f = makeFakeDb({ contacts: [{ account_id: ACCT, messenger_psid: 'u1', name: 'Aisha' }] })
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', authorExternalId: 'u1', providerCreatedAt: at })
    expect(f.tables.comments[0].contact_id).toBe(f.tables.contacts[0].id)
  })

  it('matches an Instagram commenter by IGSID and never matches TikTok', async () => {
    const f = makeFakeDb({ contacts: [{ account_id: ACCT, instagram_igsid: 'ig1' }] })
    await ingestComment(f.db, ACCT, { provider: 'instagram', channelRefId: 'ig', externalPostId: 'm1' }, { externalCommentId: 'c1', authorExternalId: 'ig1', providerCreatedAt: at })
    await ingestComment(f.db, ACCT, { provider: 'tiktok', channelRefId: 'tt', externalPostId: 'v1' }, { externalCommentId: 'c2', authorExternalId: 'ig1', providerCreatedAt: at })
    expect(f.tables.comments[0].contact_id).toBe(f.tables.contacts[0].id)
    expect(f.tables.comments[1].contact_id).toBeNull()
  })

  it('keeps the same external id on two providers apart', async () => {
    const f = makeFakeDb()
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'same', providerCreatedAt: at })
    await ingestComment(f.db, ACCT, { provider: 'tiktok', channelRefId: 't', externalPostId: 'v' }, { externalCommentId: 'same', providerCreatedAt: at })
    expect(f.tables.comments).toHaveLength(2)
  })
})

describe('setCommentStatusByExternalId', () => {
  it('marks a comment deleted or hidden', async () => {
    const f = makeFakeDb()
    await ingestComment(f.db, ACCT, POST, { externalCommentId: 'c1', providerCreatedAt: at })
    await setCommentStatusByExternalId(f.db, ACCT, 'facebook', 'c1', 'deleted')
    expect(f.tables.comments[0].status).toBe('deleted')
  })
})

describe('claimWebhookEvent', () => {
  it('lets an event through once and rejects the redelivery', async () => {
    const f = makeFakeDb()
    expect(await claimWebhookEvent(f.db, 'tiktok', 'k1')).toBe(true)
    expect(await claimWebhookEvent(f.db, 'tiktok', 'k1')).toBe(false)
    expect(await claimWebhookEvent(f.db, 'tiktok', 'k2')).toBe(true)
    expect(await claimWebhookEvent(f.db, 'facebook', 'k1')).toBe(true)
  })
})
