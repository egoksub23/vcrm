import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildTikTokAuthUrl,
  deleteTikTokComment,
  exchangeTikTokCode,
  listTikTokComments,
  replyToTikTokComment,
  setTikTokCommentHidden,
  TikTokApiError,
} from './api'

const ok = (data: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, message: 'OK', data }) }) as unknown as Response
const fail = (code: number, message: string, status = 200) =>
  ({ ok: status < 400, status, text: async () => JSON.stringify({ code, message, request_id: 'r1' }) }) as unknown as Response

type Call = [string, { headers: Record<string, string>; body: string }]

beforeEach(() => {
  process.env.TIKTOK_APP_ID = 'app-1'
  process.env.TIKTOK_APP_SECRET = 'sec-1'
  delete process.env.TIKTOK_AUTH_URL
})
afterEach(() => vi.unstubAllGlobals())

describe('buildTikTokAuthUrl', () => {
  it('builds the standard URL from the app id', () => {
    const u = new URL(buildTikTokAuthUrl({ state: 's1', redirectUri: 'https://crm.example/cb/' }))
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize')
    expect(u.searchParams.get('client_key')).toBe('app-1')
    expect(u.searchParams.get('state')).toBe('s1')
    expect(u.searchParams.get('redirect_uri')).toBe('https://crm.example/cb/')
    expect(u.searchParams.get('scope')).toContain('comment.list.manage')
  })

  it('uses the apps own authorization URL when one is configured', () => {
    process.env.TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize?client_key=portal&scope=x'
    const u = new URL(buildTikTokAuthUrl({ state: 's2', redirectUri: 'https://crm.example/cb/' }))
    expect(u.searchParams.get('client_key')).toBe('portal')
    expect(u.searchParams.get('scope')).toBe('x')
    expect(u.searchParams.get('state')).toBe('s2')
  })
})

describe('requests', () => {
  it('exchanges a code and reads the token lifetimes', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) =>
      ok({ access_token: 'a', refresh_token: 'r', expires_in: 86400, refresh_token_expires_in: 31536000, open_id: 'oid', scope: 'comment.list' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const t = await exchangeTikTokCode({ code: 'c', redirectUri: 'https://x/cb/' })
    expect(t).toMatchObject({ accessToken: 'a', refreshToken: 'r', openId: 'oid', scopes: 'comment.list' })
    expect(t.accessExpiresAt.getTime() - Date.now()).toBeGreaterThan(86_000_000)
    const [url, init] = fetchMock.mock.calls[0] as unknown as Call
    expect(url).toBe('https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/')
    expect(JSON.parse(init.body)).toMatchObject({ client_id: 'app-1', client_secret: 'sec-1', grant_type: 'authorization_code', auth_code: 'c' })
  })

  it('sends the token in the Access-Token header and business_id in the body', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ok({ comment_id: '123' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await replyToTikTokComment({ token: 'tok', openId: 'oid', videoId: 'v', commentId: 'c', text: 'hi' })
    expect(r.commentId).toBe('123')
    const [url, init] = fetchMock.mock.calls[0] as unknown as Call
    expect(url).toContain('/business/comment/reply/create/')
    expect(init.headers['Access-Token']).toBe('tok')
    expect(JSON.parse(init.body)).toEqual({ business_id: 'oid', video_id: 'v', comment_id: 'c', text: 'hi' })
  })

  it('hides and unhides with the right action', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ok({}))
    vi.stubGlobal('fetch', fetchMock)
    await setTikTokCommentHidden({ token: 't', openId: 'o', videoId: 'v', commentId: 'c', hidden: true })
    await setTikTokCommentHidden({ token: 't', openId: 'o', videoId: 'v', commentId: 'c', hidden: false })
    const actions = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as Call)[1].body).action)
    expect(actions).toEqual(['HIDE', 'UNHIDE'])
  })

  it('deletes by comment id', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ok({}))
    vi.stubGlobal('fetch', fetchMock)
    await deleteTikTokComment({ token: 't', openId: 'o', commentId: 'c' })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as Call)[1].body)).toEqual({ business_id: 'o', comment_id: 'c' })
  })

  it('lists comments with an id filter as a JSON array', async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => ok({ comments: [{ comment_id: '9' }], cursor: 1, has_more: true }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await listTikTokComments({ token: 't', openId: 'o', videoId: 'v', commentIds: ['9'] })
    expect(r).toMatchObject({ hasMore: true, comments: [{ comment_id: '9' }] })
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0])
    expect(url.searchParams.get('comment_ids')).toBe('["9"]')
    expect(url.searchParams.get('business_id')).toBe('o')
  })

  it('throws the TikTok message when the envelope code is not 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(40002, 'Invalid business_id')))
    await expect(deleteTikTokComment({ token: 't', openId: 'o', commentId: 'c' })).rejects.toMatchObject({
      name: 'TikTokApiError',
      message: 'Invalid business_id',
      code: 40002,
      requestId: 'r1',
    })
  })

  it('throws on an HTTP error too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(0, 'unauthorized', 401)))
    await expect(deleteTikTokComment({ token: 't', openId: 'o', commentId: 'c' })).rejects.toBeInstanceOf(TikTokApiError)
  })
})
