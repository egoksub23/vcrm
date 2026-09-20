import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: h.send }))

import { buildLinkText, sendKnowledgeAttachments } from './attachments'
import { toAttachment, type AttachmentRow } from './articles'
import type { KnowledgeAttachment } from '@/lib/knowledge-types'

const att = (over: Partial<KnowledgeAttachment> = {}): KnowledgeAttachment => ({
  id: 'a1',
  document_id: 'd1',
  file_name: 'pasted-image-1.png',
  mime_type: 'image/png',
  size_bytes: 1000,
  kind: 'image',
  url: 'https://cdn.example/1.png',
  storage_path: 'account-x/kb/1.png',
  send_with_ai: true,
  position: 0,
  inline: true,
  caption: null,
  ...over,
})

function fakeDb(channel: string) {
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not']) c[m] = () => c
    c.maybeSingle = () => Promise.resolve({ data: result, error: null })
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null })
    return c
  }
  return {
    from: (table: string) => (table === 'messages' ? chain([]) : chain({ last_channel_type: channel })),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  h.send.mockReset()
  h.send.mockResolvedValue({ messageId: 'm' })
})

describe('toAttachment', () => {
  const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
    id: 'r1',
    document_id: 'd1',
    file_name: 'a.png',
    mime_type: 'image/png',
    size_bytes: 10,
    kind: 'image',
    storage_path: 'account-x/kb/a.png',
    public_url: 'https://u/a.png',
    send_with_ai: true,
    position: 2,
    inline: true,
    caption: 'The menu',
    ...over,
  })
  it('carries inline and caption', () => {
    expect(toAttachment(row())).toMatchObject({ inline: true, caption: 'The menu', position: 2 })
  })
  it('reads a row from before the columns existed as a plain file', () => {
    expect(toAttachment(row({ inline: null, caption: null }))).toMatchObject({ inline: false, caption: null })
    expect(toAttachment({ ...row(), inline: undefined as unknown as null })).toMatchObject({ inline: false })
  })
})

describe('sending an article\'s inline images', () => {
  it('sends them in the order given (document order), each with its caption as the media caption', async () => {
    const db = fakeDb('whatsapp')
    await sendKnowledgeAttachments(db, 'acct', {
      conversationId: 'conv',
      attachments: [
        att({ id: '1', url: 'https://cdn.example/1.png', caption: 'Step 1: open Settings' }),
        att({ id: '2', url: 'https://cdn.example/2.png', caption: null }),
        att({ id: '3', url: 'https://cdn.example/3.png', caption: '  Step 3  ' }),
      ],
    })
    expect(h.send).toHaveBeenCalledTimes(3)
    expect(h.send.mock.calls.map((c) => c[2].mediaUrl)).toEqual([
      'https://cdn.example/1.png',
      'https://cdn.example/2.png',
      'https://cdn.example/3.png',
    ])
    expect(h.send.mock.calls[0][2]).toMatchObject({ messageType: 'image', contentText: 'Step 1: open Settings' })
    expect(h.send.mock.calls[1][2]).not.toHaveProperty('contentText')
    expect(h.send.mock.calls[2][2]).toMatchObject({ contentText: 'Step 3' })
  })

  it('sends a caption on Messenger and Instagram images too, but never on a document', async () => {
    for (const channel of ['messenger', 'instagram']) {
      h.send.mockClear()
      await sendKnowledgeAttachments(fakeDb(channel), 'acct', {
        conversationId: 'conv',
        attachments: [att({ caption: 'Cap' })],
      })
      expect(h.send.mock.calls[0][2]).toMatchObject({ messageType: 'image', contentText: 'Cap' })
    }
    h.send.mockClear()
    // a WhatsApp image that is not a PNG or JPEG goes out as a document: no caption
    await sendKnowledgeAttachments(fakeDb('whatsapp'), 'acct', {
      conversationId: 'conv',
      attachments: [att({ mime_type: 'image/gif', caption: 'Cap' })],
    })
    expect(h.send.mock.calls[0][2]).toMatchObject({ messageType: 'document' })
    expect(h.send.mock.calls[0][2]).not.toHaveProperty('contentText')
  })

  it('cuts a caption to the 1024 characters a media caption may have', async () => {
    await sendKnowledgeAttachments(fakeDb('whatsapp'), 'acct', {
      conversationId: 'conv',
      attachments: [att({ caption: 'x'.repeat(2000) })],
    })
    expect(h.send.mock.calls[0][2].contentText).toHaveLength(1024)
  })

  it('sends an inline image on email as an attachment too (the AI-written body does not contain it)', async () => {
    await sendKnowledgeAttachments(fakeDb('email'), 'acct', { conversationId: 'conv', attachments: [att()] })
    expect(h.send).toHaveBeenCalledWith(expect.anything(), 'acct', expect.objectContaining({ messageType: 'image', channelOverride: 'email' }))
  })

  it('sends each inline image once even when a translation and its base carry the same file', async () => {
    const r = await sendKnowledgeAttachments(fakeDb('whatsapp'), 'acct', {
      conversationId: 'conv',
      attachments: [att({ id: '1' }), att({ id: '2', document_id: 'd2' })],
    })
    expect(r.sent).toBe(1)
  })

  it('names a captioned image by its caption in the link fallback (web chat, Instagram GIFs ...)', async () => {
    await sendKnowledgeAttachments(fakeDb('web_widget'), 'acct', {
      conversationId: 'conv',
      attachments: [att({ caption: 'Open Settings' }), att({ id: '2', url: 'https://cdn.example/2.png' })],
    })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][2]).toMatchObject({
      messageType: 'text',
      contentText: 'Open Settings: https://cdn.example/1.png\npasted-image-1.png: https://cdn.example/2.png',
    })
  })
})

describe('buildLinkText with captions', () => {
  it('prefers a non-blank caption to the file name', () => {
    expect(
      buildLinkText([
        { file_name: 'a.png', url: 'u1', caption: 'Cap' },
        { file_name: 'b.png', url: 'u2', caption: '   ' },
        { file_name: 'c.pdf', url: 'u3' },
      ]),
    ).toBe('Cap: u1\nb.png: u2\nc.pdf: u3')
  })
})
