import { beforeEach, describe, expect, it, vi } from 'vitest'

const info = vi.fn()
const remove = vi.fn()
const owned = vi.fn()
const insertMessage = vi.fn()
const fanout = vi.fn()

vi.mock('@/lib/widget/visitor-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/visitor-auth')>('@/lib/widget/visitor-auth')
  return {
    ...actual,
    authenticateVisitorRequest: vi.fn(async () => ({
      ok: true,
      ctx: {
        admin: {
          storage: {
            from: () => ({
              info,
              remove,
              getPublicUrl: (p: string) => ({ data: { publicUrl: `https://storage.example/public/chat-media/${p}` } }),
            }),
          },
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

vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: vi.fn(async () => 'owner-1'),
  ContactError: class ContactError extends Error {
    status = 500
  },
}))

vi.mock('@/lib/widget/inbound', () => ({
  isFirstCustomerMessage: vi.fn(async () => true),
  insertWidgetCustomerMessage: (...args: unknown[]) => insertMessage(...args),
  runWidgetInboundFanout: (...args: unknown[]) => fanout(...args),
}))

import { POST } from './route'

const PREFIX = 'account-acc-1/widget/conv-1/'

function call(body: unknown) {
  return POST(
    new Request('https://crm.example/api/widget/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site.example', Authorization: 'Bearer x' },
      body: JSON.stringify(body),
    }),
  )
}

const media = (over: Record<string, unknown> = {}) => ({
  path: `${PREFIX}abc-photo.jpg`,
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  sizeBytes: 2048,
  kind: 'image',
  ...over,
})

beforeEach(() => {
  for (const m of [info, remove, owned, insertMessage, fanout]) m.mockReset()
  owned.mockResolvedValue({ id: 'conv-1', account_id: 'acc-1', contact_id: 'contact-1', status: 'open' })
  remove.mockResolvedValue({ data: [], error: null })
  info.mockResolvedValue({ data: { size: 2048, contentType: 'image/jpeg' }, error: null })
  insertMessage.mockResolvedValue({ id: 'msg-1', created_at: '2026-01-01T00:00:00Z', status: 'sent', duplicate: false })
})

describe('POST /api/widget/message', () => {
  it('sends text and answers { message: { id, created_at, status: sent } }', async () => {
    const res = await call({ conversationId: 'conv-1', text: '  hello  ' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toEqual({ id: 'msg-1', created_at: '2026-01-01T00:00:00Z', status: 'sent' })
    // legacy shape for old cached loaders
    expect(body).toMatchObject({ success: true, messageId: 'msg-1' })
    expect(insertMessage.mock.calls[0][1]).toMatchObject({ conversationId: 'conv-1', text: 'hello', media: null })
    expect(fanout).toHaveBeenCalledTimes(1)
  })

  it('needs text or media', async () => {
    const res = await call({ conversationId: 'conv-1' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'bad_request' })
  })

  it('a retried send (same clientMessageId) returns the original and skips the fan-out', async () => {
    insertMessage.mockResolvedValue({ id: 'msg-1', created_at: 't', status: 'sent', duplicate: true })
    const res = await call({ conversationId: 'conv-1', text: 'hi', clientMessageId: 'c-1' })
    expect(res.status).toBe(200)
    expect(fanout).not.toHaveBeenCalled()
    expect(insertMessage.mock.calls[0][1].clientMessageId).toBe('c-1')
  })

  it('404s on a conversation that is not the visitor\'s', async () => {
    owned.mockResolvedValue(null)
    const res = await call({ conversationId: 'conv-x', text: 'hi' })
    expect(res.status).toBe(404)
    expect(insertMessage).not.toHaveBeenCalled()
  })

  describe('media', () => {
    it('inserts an image with its public URL and the caption as text', async () => {
      const res = await call({ conversationId: 'conv-1', text: 'look', media: media() })
      expect(res.status).toBe(200)
      const args = insertMessage.mock.calls[0][1]
      expect(args.text).toBe('look')
      expect(args.media).toEqual({
        url: `https://storage.example/public/chat-media/${PREFIX}abc-photo.jpg`,
        kind: 'image',
        mimeType: 'image/jpeg',
      })
      expect(remove).not.toHaveBeenCalled()
    })

    it('accepts a media-only message (no text)', async () => {
      const res = await call({ conversationId: 'conv-1', media: media() })
      expect(res.status).toBe(200)
    })

    it('rejects a path that is not under this conversation, without touching Storage', async () => {
      const res = await call({ conversationId: 'conv-1', media: media({ path: 'account-other/widget/conv-1/x.jpg' }) })
      expect(res.status).toBe(400)
      expect(info).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(insertMessage).not.toHaveBeenCalled()
    })

    it('a declared type outside the allow-list is 415 and the object is deleted', async () => {
      const res = await call({ conversationId: 'conv-1', media: media({ mimeType: 'text/html', kind: 'document' }) })
      expect(res.status).toBe(415)
      expect(await res.json()).toMatchObject({ code: 'file_type_not_allowed' })
      expect(remove).toHaveBeenCalledWith([`${PREFIX}abc-photo.jpg`])
      expect(insertMessage).not.toHaveBeenCalled()
    })

    it('a declared size over 16 MB is 413 and the object is deleted', async () => {
      const res = await call({ conversationId: 'conv-1', media: media({ sizeBytes: 17 * 1024 * 1024 }) })
      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ code: 'file_too_large' })
      expect(remove).toHaveBeenCalled()
    })

    it('an object that is not in Storage is a 400', async () => {
      info.mockResolvedValue({ data: null, error: { message: 'not found' } })
      const res = await call({ conversationId: 'conv-1', media: media() })
      expect(res.status).toBe(400)
      expect(insertMessage).not.toHaveBeenCalled()
    })

    it('the stored object is bigger than declared: 413 and the object is deleted', async () => {
      info.mockResolvedValue({ data: { size: 5_000_000, contentType: 'image/jpeg' }, error: null })
      const res = await call({ conversationId: 'conv-1', media: media() })
      expect(res.status).toBe(413)
      expect(remove).toHaveBeenCalledWith([`${PREFIX}abc-photo.jpg`])
    })

    it('the stored object has another type than declared: 415 and the object is deleted', async () => {
      info.mockResolvedValue({ data: { size: 2048, contentType: 'application/pdf' }, error: null })
      const res = await call({ conversationId: 'conv-1', media: media() })
      expect(res.status).toBe(415)
      expect(remove).toHaveBeenCalled()
      expect(insertMessage).not.toHaveBeenCalled()
    })

    it('a caption is capped at 1024 characters', async () => {
      const res = await call({ conversationId: 'conv-1', text: 'x'.repeat(1025), media: media() })
      expect(res.status).toBe(400)
    })
  })
})
