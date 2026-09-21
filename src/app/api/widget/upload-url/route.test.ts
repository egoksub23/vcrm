import { beforeEach, describe, expect, it, vi } from 'vitest'

const createSignedUploadUrl = vi.fn()
const owned = vi.fn()

vi.mock('@/lib/widget/visitor-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/visitor-auth')>('@/lib/widget/visitor-auth')
  return {
    ...actual,
    authenticateVisitorRequest: vi.fn(async () => ({
      ok: true,
      ctx: {
        admin: { storage: { from: () => ({ createSignedUploadUrl }) } },
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

function call(body: unknown) {
  return POST(
    new Request('https://crm.example/api/widget/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site.example', Authorization: 'Bearer x' },
      body: JSON.stringify(body),
    }),
  )
}

const valid = {
  conversationId: 'conv-1',
  fileName: 'holiday photo.JPG',
  mimeType: 'image/jpeg',
  sizeBytes: 2048,
  kind: 'image',
}

beforeEach(() => {
  createSignedUploadUrl.mockReset()
  owned.mockReset()
  owned.mockResolvedValue({ id: 'conv-1', account_id: 'acc-1', contact_id: 'contact-1', status: 'open' })
  createSignedUploadUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: 'https://storage/x', token: 'signed-token', path },
    error: null,
  }))
})

describe('POST /api/widget/upload-url', () => {
  it('returns bucket, an account/conversation scoped path and a signed upload token', async () => {
    const res = await call(valid)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bucket).toBe('chat-media')
    expect(body.token).toBe('signed-token')
    expect(body.path).toMatch(/^account-acc-1\/widget\/conv-1\/[0-9a-f-]{36}-holiday_photo\.jpg$/)
    expect(createSignedUploadUrl).toHaveBeenCalledWith(body.path)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://site.example')
  })

  it('refuses a file over 16 MB with 413 file_too_large', async () => {
    const res = await call({ ...valid, sizeBytes: 16 * 1024 * 1024 + 1 })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: 'file_too_large' })
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses a type outside the chat-media allow-list with 415', async () => {
    const res = await call({ ...valid, mimeType: 'text/html', kind: 'document', fileName: 'x.html' })
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ code: 'file_type_not_allowed' })
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('refuses a kind that does not match the type', async () => {
    const res = await call({ ...valid, kind: 'video' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'bad_request' })
  })

  it('refuses missing fields', async () => {
    for (const patch of [{ conversationId: '' }, { fileName: '' }, { sizeBytes: 0 }, { sizeBytes: 'big' }]) {
      const res = await call({ ...valid, ...patch })
      expect(res.status).toBe(400)
    }
  })

  it('404s when the conversation is not the visitor\'s own', async () => {
    owned.mockResolvedValue(null)
    const res = await call(valid)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'not_found' })
    expect(createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('500s cleanly when Storage cannot sign', async () => {
    createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await call(valid)
    expect(res.status).toBe(500)
  })
})
