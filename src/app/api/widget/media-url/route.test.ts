import { beforeEach, describe, expect, it, vi } from 'vitest'

const owned = vi.fn()
const messageRows = vi.fn()
const createSignedUrl = vi.fn()
const queryCalls: { eq: [string, unknown][]; in: [string, unknown][] } = { eq: [], in: [] }

vi.mock('@/lib/widget/visitor-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/visitor-auth')>('@/lib/widget/visitor-auth')
  const query: Record<string, unknown> = {}
  query.select = () => query
  query.eq = (col: string, val: unknown) => {
    queryCalls.eq.push([col, val])
    return query
  }
  query.in = (col: string, val: unknown) => {
    queryCalls.in.push([col, val])
    return Promise.resolve(messageRows())
  }
  return {
    ...actual,
    authenticateVisitorRequest: vi.fn(async () => ({
      ok: true,
      ctx: {
        admin: {
          from: () => query,
          storage: { from: (bucket: string) => ({ createSignedUrl: (p: string, ttl: number) => createSignedUrl(bucket, p, ttl) }) },
        },
        visitorId: 'visitor-1',
        accountId: 'acc-1',
        contactId: 'contact-1',
        widgetConfigId: 'cfg-1',
        corsOrigin: 'https://site.example',
      },
    })),
    loadOwnedConversation: (...args: unknown[]) => owned(...args),
  }
})

import { POST } from './route'

const HOST = 'https://x.supabase.co/storage/v1/object/public/chat-media'
const MINE = `${HOST}/account-acc-1/widget/conv-1/a-photo.jpg`
const MINE_2 = `${HOST}/account-acc-1/agent/b-voice.ogg`
const OTHER_ACCOUNT = `${HOST}/account-acc-2/widget/conv-9/steal.jpg`
const NOT_ON_A_MESSAGE = `${HOST}/account-acc-1/widget/conv-2/secret.pdf`

function call(body: unknown) {
  return POST(
    new Request('https://crm.example/api/widget/media-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site.example', Authorization: 'Bearer x' },
      body: JSON.stringify(body),
    }),
  )
}

const rows = (...urls: string[]) => ({ data: urls.map((media_url) => ({ media_url })), error: null })

beforeEach(() => {
  for (const m of [owned, messageRows, createSignedUrl]) m.mockReset()
  queryCalls.eq = []
  queryCalls.in = []
  owned.mockResolvedValue({ id: 'conv-1', account_id: 'acc-1', contact_id: 'contact-1', status: 'open' })
  messageRows.mockReturnValue(rows())
  createSignedUrl.mockImplementation(async (_b: string, p: string) => ({
    data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/chat-media/${p}?token=t` },
    error: null,
  }))
})

describe('POST /api/widget/media-url', () => {
  it('signs a media url that belongs to a message in the visitor\'s conversation', async () => {
    messageRows.mockReturnValue(rows(MINE, MINE_2))
    const res = await call({ conversationId: 'conv-1', urls: [MINE, MINE_2] })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://site.example')
    const body = await res.json()
    expect(body.urls[MINE]).toBe(
      'https://x.supabase.co/storage/v1/object/sign/chat-media/account-acc-1/widget/conv-1/a-photo.jpg?token=t',
    )
    expect(Object.keys(body.urls)).toEqual([MINE, MINE_2])
    // signed with the 4 hour viewing lifetime, in the private bucket
    expect(createSignedUrl).toHaveBeenCalledWith('chat-media', 'account-acc-1/widget/conv-1/a-photo.jpg', 14400)
    // looked up in THIS conversation, never including internal notes
    expect(queryCalls.eq).toEqual([
      ['conversation_id', 'conv-1'],
      ['is_internal', false],
    ])
  })

  it('omits a url that is not on any message of that conversation', async () => {
    messageRows.mockReturnValue(rows(MINE))
    const res = await call({ conversationId: 'conv-1', urls: [MINE, NOT_ON_A_MESSAGE] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body.urls)).toEqual([MINE])
    expect(createSignedUrl).toHaveBeenCalledTimes(1)
  })

  it('omits another account\'s path even if a message somehow carries it', async () => {
    messageRows.mockReturnValue(rows(OTHER_ACCOUNT, MINE))
    const res = await call({ conversationId: 'conv-1', urls: [OTHER_ACCOUNT, MINE] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body.urls)).toEqual([MINE])
    expect(createSignedUrl).not.toHaveBeenCalledWith('chat-media', expect.stringContaining('account-acc-2'), expect.anything())
  })

  it('omits a file Storage cannot sign (deleted object) instead of failing', async () => {
    messageRows.mockReturnValue(rows(MINE, MINE_2))
    createSignedUrl.mockImplementation(async (_b: string, p: string) =>
      p.includes('voice') ? { data: null, error: { message: 'Object not found' } } : { data: { signedUrl: `https://s/${p}` }, error: null },
    )
    const res = await call({ conversationId: 'conv-1', urls: [MINE, MINE_2] })
    expect(res.status).toBe(200)
    expect(Object.keys((await res.json()).urls)).toEqual([MINE])
  })

  it('answers an empty map for an empty list without querying messages', async () => {
    const res = await call({ conversationId: 'conv-1', urls: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ urls: {} })
    expect(messageRows).not.toHaveBeenCalled()
  })

  it('404s on a conversation that is not the visitor\'s, and signs nothing', async () => {
    owned.mockResolvedValue(null)
    const res = await call({ conversationId: 'conv-x', urls: [MINE] })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'not_found' })
    expect(messageRows).not.toHaveBeenCalled()
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('500s when the message lookup fails, signing nothing', async () => {
    messageRows.mockReturnValue({ data: null, error: { message: 'boom' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await call({ conversationId: 'conv-1', urls: [MINE] })
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  describe('rejects bad bodies', () => {
    const bad: [string, unknown][] = [
      ['no conversationId', { urls: [MINE] }],
      ['conversationId not a string', { conversationId: 7, urls: [MINE] }],
      ['urls missing', { conversationId: 'conv-1' }],
      ['urls not an array', { conversationId: 'conv-1', urls: MINE }],
      ['urls with a non-string', { conversationId: 'conv-1', urls: [MINE, 3] }],
      ['urls with an empty string', { conversationId: 'conv-1', urls: [''] }],
      ['more than 25 urls', { conversationId: 'conv-1', urls: Array.from({ length: 26 }, (_, i) => `${MINE}?${i}`) }],
      ['a url over the length cap', { conversationId: 'conv-1', urls: ['x'.repeat(2049)] }],
      ['not an object', 'nope'],
      ['null', null],
    ]
    for (const [name, body] of bad) {
      it(name, async () => {
        const res = await call(body)
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ code: 'bad_request' })
        expect(messageRows).not.toHaveBeenCalled()
        expect(createSignedUrl).not.toHaveBeenCalled()
      })
    }

    it('accepts exactly 25 urls', async () => {
      messageRows.mockReturnValue(rows())
      const res = await call({ conversationId: 'conv-1', urls: Array.from({ length: 25 }, (_, i) => `${MINE}?${i}`) })
      expect(res.status).toBe(200)
    })
  })
})
