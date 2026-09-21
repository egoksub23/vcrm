import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: h.send }))

import { buildLinkText, loadSendableAttachments, planDelivery, sendKnowledgeAttachments } from './attachments'
import type { KnowledgeAttachment } from '@/lib/knowledge-types'

const att = (over: Partial<KnowledgeAttachment> = {}): KnowledgeAttachment => ({
  id: 'a1',
  document_id: 'd1',
  file_name: 'menu.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1000,
  kind: 'document',
  url: 'https://cdn.example/menu.pdf',
  storage_path: 'account-x/kb/menu.pdf',
  send_with_ai: true,
  position: 0,
  inline: false,
  caption: null,
  ...over,
})

describe('planDelivery', () => {
  it('sends documents as documents on WhatsApp and falls back to document for odd media', () => {
    expect(planDelivery('whatsapp', att())).toEqual({ via: 'media', messageType: 'document' })
    expect(planDelivery('whatsapp', att({ kind: 'image', mime_type: 'image/png' }))).toEqual({ via: 'media', messageType: 'image' })
    // heic / gif images are not WhatsApp images: they go as documents
    expect(planDelivery('whatsapp', att({ kind: 'image', mime_type: 'image/heic' }))).toEqual({ via: 'media', messageType: 'document' })
    expect(planDelivery('whatsapp', att({ kind: 'video', mime_type: 'video/mp4' }))).toEqual({ via: 'media', messageType: 'video' })
    expect(planDelivery('whatsapp', att({ kind: 'video', mime_type: 'video/webm' }))).toEqual({ via: 'media', messageType: 'document' })
    expect(planDelivery('whatsapp', att({ kind: 'audio', mime_type: 'audio/ogg' }))).toEqual({ via: 'media', messageType: 'audio' })
  })

  it('uses the file kind on Messenger and email', () => {
    expect(planDelivery('messenger', att())).toEqual({ via: 'media', messageType: 'document' })
    expect(planDelivery('messenger', att({ kind: 'image', mime_type: 'image/jpeg' }))).toEqual({ via: 'media', messageType: 'image' })
    expect(planDelivery('email', att())).toEqual({ via: 'media', messageType: 'document' })
    expect(planDelivery('gmail', att({ kind: 'image', mime_type: 'image/png' }))).toEqual({ via: 'media', messageType: 'image' })
  })

  it('sends documents on Instagram as links, but images natively', () => {
    expect(planDelivery('instagram', att())).toEqual({ via: 'link' })
    expect(planDelivery('instagram', att({ kind: 'image', mime_type: 'image/png' }))).toEqual({ via: 'media', messageType: 'image' })
    expect(planDelivery('instagram', att({ kind: 'image', mime_type: 'image/heic' }))).toEqual({ via: 'link' })
  })

  it('sends everything on the web widget as a link', () => {
    expect(planDelivery('web_widget', att())).toEqual({ via: 'link' })
    expect(planDelivery('web_widget', att({ kind: 'image', mime_type: 'image/png' }))).toEqual({ via: 'link' })
  })
})

describe('buildLinkText', () => {
  it('lists one "name: url" line per file', () => {
    expect(buildLinkText([att(), att({ file_name: 'b.pdf', url: 'https://cdn.example/b.pdf' })])).toBe(
      'menu.pdf: https://cdn.example/menu.pdf\nb.pdf: https://cdn.example/b.pdf',
    )
  })
})

function fakeDb(opts: { sentRows?: { media_url: string | null; content_text: string | null }[]; channel?: string | null } = {}) {
  const calls: { table: string }[] = []
  const chain = (table: string, result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'not']) c[m] = () => c
    c.maybeSingle = () => Promise.resolve({ data: result, error: null })
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null })
    calls.push({ table })
    return c
  }
  return {
    calls,
    db: {
      from: (table: string) =>
        table === 'messages'
          ? chain(table, opts.sentRows ?? [])
          : chain(table, opts.channel === null ? null : { last_channel_type: opts.channel ?? 'whatsapp' }),
    } as unknown as SupabaseClient,
  }
}

beforeEach(() => {
  h.send.mockReset()
  h.send.mockResolvedValue({ messageId: 'm' })
})

describe('sendKnowledgeAttachments', () => {
  it('sends each file as its own media message, as the bot, in order', async () => {
    const { db } = fakeDb()
    const r = await sendKnowledgeAttachments(db, 'acct', {
      conversationId: 'conv',
      attachments: [att(), att({ id: 'a2', file_name: 'logo.png', kind: 'image', mime_type: 'image/png', url: 'https://cdn.example/logo.png' })],
    })
    expect(r).toEqual({ sent: 2, linked: 0, skipped: 0, failed: 0 })
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(h.send).toHaveBeenNthCalledWith(1, db, 'acct', expect.objectContaining({
      conversationId: 'conv', messageType: 'document', mediaUrl: 'https://cdn.example/menu.pdf', filename: 'menu.pdf',
      senderType: 'bot', aiGenerated: true, channelOverride: 'whatsapp',
    }))
    expect(h.send).toHaveBeenNthCalledWith(2, db, 'acct', expect.objectContaining({ messageType: 'image', filename: 'logo.png' }))
  })

  it('skips a file already sent in this conversation, as media or inside a link line', async () => {
    const { db } = fakeDb({
      sentRows: [
        { media_url: 'https://cdn.example/menu.pdf', content_text: null },
        { media_url: null, content_text: 'prices.pdf: https://cdn.example/prices.pdf' },
      ],
    })
    const r = await sendKnowledgeAttachments(db, 'acct', {
      conversationId: 'conv',
      attachments: [
        att(),
        att({ id: 'a2', file_name: 'prices.pdf', url: 'https://cdn.example/prices.pdf' }),
        att({ id: 'a3', file_name: 'new.pdf', url: 'https://cdn.example/new.pdf' }),
      ],
    })
    expect(r).toEqual({ sent: 1, linked: 0, skipped: 2, failed: 0 })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith(db, 'acct', expect.objectContaining({ filename: 'new.pdf' }))
  })

  it('sends the same file only once when two articles carry it', async () => {
    const { db } = fakeDb()
    const r = await sendKnowledgeAttachments(db, 'acct', {
      conversationId: 'conv',
      attachments: [att(), att({ id: 'a2', document_id: 'd2' })],
    })
    expect(r.sent).toBe(1)
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('sends channels that cannot carry files as one text with links', async () => {
    const { db } = fakeDb({ channel: 'web_widget' })
    const r = await sendKnowledgeAttachments(db, 'acct', {
      conversationId: 'conv',
      attachments: [att(), att({ id: 'a2', file_name: 'b.pdf', url: 'https://cdn.example/b.pdf' })],
    })
    expect(r).toEqual({ sent: 0, linked: 2, skipped: 0, failed: 0 })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith(db, 'acct', expect.objectContaining({
      messageType: 'text',
      contentText: 'menu.pdf: https://cdn.example/menu.pdf\nb.pdf: https://cdn.example/b.pdf',
      channelOverride: 'web_widget',
    }))
  })

  it('falls back to a link when the channel refuses the media', async () => {
    const { db } = fakeDb()
    h.send.mockRejectedValueOnce(new Error('Meta rejected the file')).mockResolvedValueOnce({ messageId: 'm2' })
    const r = await sendKnowledgeAttachments(db, 'acct', { conversationId: 'conv', attachments: [att()] })
    expect(r).toEqual({ sent: 0, linked: 1, skipped: 0, failed: 0 })
    expect(h.send).toHaveBeenLastCalledWith(db, 'acct', expect.objectContaining({ messageType: 'text', contentText: 'menu.pdf: https://cdn.example/menu.pdf' }))
  })

  it('counts a file as failed, without throwing, when even the link cannot be sent', async () => {
    const { db } = fakeDb()
    h.send.mockRejectedValue(new Error('down'))
    const r = await sendKnowledgeAttachments(db, 'acct', { conversationId: 'conv', attachments: [att()] })
    expect(r).toEqual({ sent: 0, linked: 0, skipped: 0, failed: 1 })
  })

  it('uses the channel it was given and does nothing for an empty list', async () => {
    const { db, calls } = fakeDb({ channel: null })
    expect(await sendKnowledgeAttachments(db, 'acct', { conversationId: 'conv', attachments: [] })).toEqual({
      sent: 0, linked: 0, skipped: 0, failed: 0,
    })
    expect(calls).toHaveLength(0)
    await sendKnowledgeAttachments(db, 'acct', { conversationId: 'conv', attachments: [att()], channel: 'messenger' })
    expect(h.send).toHaveBeenCalledWith(db, 'acct', expect.objectContaining({ channelOverride: 'messenger', messageType: 'document' }))
  })

  it('never throws, even when the conversation cannot be read', async () => {
    const { db } = fakeDb({ channel: null })
    const r = await sendKnowledgeAttachments(db, 'acct', { conversationId: 'gone', attachments: [att()] })
    expect(r.failed).toBe(1)
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('loadSendableAttachments', () => {
  it('returns nothing without articles and orders files by article then position', async () => {
    const { db: emptyDb } = fakeDb()
    expect(await loadSendableAttachments(emptyDb, 'acct', [])).toEqual([])

    const rows = [
      { id: 'x2', document_id: 'B', file_name: 'b.pdf', mime_type: 'application/pdf', size_bytes: 5, kind: 'document', storage_path: 'p2', public_url: 'https://u/b', send_with_ai: true, position: 0 },
      { id: 'x1', document_id: 'A', file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: '7', kind: 'document', storage_path: 'p1', public_url: 'https://u/a', send_with_ai: true, position: 0 },
    ]
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order']) chain[m] = () => chain
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null })
    const db = { from: () => chain } as unknown as SupabaseClient
    const out = await loadSendableAttachments(db, 'acct', ['A', 'B'])
    expect(out.map((a) => a.id)).toEqual(['x1', 'x2'])
    expect(out[0]).toMatchObject({ url: 'https://u/a', size_bytes: 7, kind: 'document' })
  })
})
