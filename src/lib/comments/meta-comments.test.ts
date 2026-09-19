import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  deleteMetaComment,
  replyFacebookComment,
  replyInstagramComment,
  sendPrivateReply,
  setFacebookCommentHidden,
  setInstagramCommentHidden,
  subscribePageFields,
} from './meta-comments'
import { buildMetaOAuthUrl } from '@/lib/meta/oauth'

type Call = [string, { method: string; headers: Record<string, string>; body?: string }]
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

afterEach(() => vi.unstubAllGlobals())

function stub(...responses: Response[]) {
  const fetchMock = vi.fn(async (..._a: unknown[]) => responses.shift() ?? json({}))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const call = (m: ReturnType<typeof stub>, i = 0) => m.mock.calls[i] as unknown as Call

describe('replies', () => {
  it('replies under a Facebook comment', async () => {
    const m = stub(json({ id: 'new-1' }))
    expect(await replyFacebookComment({ commentId: 'C1', token: 'tok', message: 'hi' })).toEqual({ id: 'new-1' })
    const [url, init] = call(m)
    expect(url).toMatch(/graph\.facebook\.com\/v[\d.]+\/C1\/comments$/)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body!)).toEqual({ message: 'hi' })
  })

  it('replies under an Instagram comment', async () => {
    const m = stub(json({ id: 'new-2' }))
    await replyInstagramComment({ commentId: 'IC1', token: 'tok', message: 'hi' })
    expect(call(m)[0]).toMatch(/\/IC1\/replies$/)
  })

  it('sends a private reply from the page with the comment as recipient', async () => {
    const m = stub(json({ recipient_id: 'psid-9', message_id: 'mid-9' }))
    const r = await sendPrivateReply({ senderId: 'PAGE', commentId: 'C1', token: 'tok', text: 'dm' })
    expect(r).toEqual({ recipientId: 'psid-9', messageId: 'mid-9' })
    const [url, init] = call(m)
    expect(url).toMatch(/\/PAGE\/messages$/)
    expect(JSON.parse(init.body!)).toEqual({ recipient: { comment_id: 'C1' }, message: { text: 'dm' } })
  })
})

describe('moderation', () => {
  it('hides a Facebook comment with is_hidden and an Instagram one with hide', async () => {
    const m = stub(json({ success: true }), json({ success: true }))
    await setFacebookCommentHidden({ commentId: 'C1', token: 't', hidden: true })
    await setInstagramCommentHidden({ commentId: 'IC1', token: 't', hidden: false })
    expect(JSON.parse(call(m, 0)[1].body!)).toEqual({ is_hidden: true })
    expect(JSON.parse(call(m, 1)[1].body!)).toEqual({ hide: false })
  })

  it('deletes with DELETE', async () => {
    const m = stub(json({ success: true }))
    await deleteMetaComment({ commentId: 'C1', token: 't' })
    expect(call(m)[1].method).toBe('DELETE')
  })

  it('throws the Graph error message', async () => {
    stub(json({ error: { message: 'Permissions error', code: 200 } }, 403))
    await expect(deleteMetaComment({ commentId: 'C1', token: 't' })).rejects.toMatchObject({ name: 'MetaApiError', message: 'Permissions error', code: 200 })
  })
})

describe('subscribePageFields', () => {
  it('keeps the fields the page already has and adds the new ones', async () => {
    const m = stub(json({ data: [{ subscribed_fields: ['messages', 'messaging_postbacks'] }] }), json({ success: true }))
    const fields = await subscribePageFields({ pageId: 'PAGE', token: 't', add: ['feed', 'messages'] })
    expect(fields.sort()).toEqual(['feed', 'messages', 'messaging_postbacks'])
    const post = call(m, 1)
    expect(post[1].method).toBe('POST')
    expect(JSON.parse(post[1].body!).subscribed_fields.split(',').sort()).toEqual(['feed', 'messages', 'messaging_postbacks'])
  })

  it('still subscribes when reading the current fields fails', async () => {
    stub(json({ error: { message: 'nope', code: 10 } }, 400), json({ success: true }))
    expect(await subscribePageFields({ pageId: 'PAGE', token: 't', add: ['comments', 'live_comments'] })).toEqual(['comments', 'live_comments'])
  })
})

describe('OAuth scopes for comments', () => {
  const args = { state: 's', redirectUri: 'https://crm.example/cb' }
  const scopes = (u: string) => new URL(u).searchParams.get('scope')!.split(',')

  it('asks only for messaging scopes by default', () => {
    process.env.META_APP_ID = 'app'
    expect(scopes(buildMetaOAuthUrl({ channel: 'messenger', ...args }))).not.toContain('pages_manage_engagement')
    expect(scopes(buildMetaOAuthUrl({ channel: 'instagram', ...args }))).not.toContain('instagram_manage_comments')
  })

  it('adds the Facebook comment scopes to Messenger, once each', () => {
    process.env.META_APP_ID = 'app'
    const s = scopes(buildMetaOAuthUrl({ channel: 'messenger', withComments: true, ...args }))
    expect(s).toEqual(expect.arrayContaining(['pages_messaging', 'pages_manage_engagement', 'pages_read_user_content', 'pages_manage_metadata']))
    expect(new Set(s).size).toBe(s.length)
  })

  it('adds the Instagram comment scopes to Instagram', () => {
    process.env.META_APP_ID = 'app'
    expect(scopes(buildMetaOAuthUrl({ channel: 'instagram', withComments: true, ...args }))).toEqual(
      expect.arrayContaining(['instagram_manage_messages', 'instagram_manage_comments', 'pages_manage_metadata']),
    )
  })
})
