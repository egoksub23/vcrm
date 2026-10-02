import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** what findMessageByServerId finds (the messages select) */
  existing: null as null | { id: string; status: string; conversation_id: string },
  insertResult: { data: { id: 'msg-new' } as { id: string } | null, error: null as { code?: string; message: string } | null },
  inserted: [] as Record<string, unknown>[],
  updates: [] as { table: string; row: Record<string, unknown>; filters: Record<string, unknown> }[],
  updateReturns: [{ id: 'msg-1' }] as unknown[],
  store: {
    findByWallet: vi.fn(),
    mergeContacts: vi.fn(),
    recordSuggestion: vi.fn(),
  },
  resolveIdentity: vi.fn(),
  findOrCreateConversation: vi.fn(),
  fanOut: vi.fn(),
  isFirst: vi.fn(),
  mirror: vi.fn(),
  reopen: vi.fn(),
}))

vi.mock('@/lib/api/v1/contacts', () => ({ resolveAuditUserId: async () => 'owner-1' }))
vi.mock('@/lib/widget/identity-resolve', () => ({
  createSupabaseIdentityStore: () => h.store,
  resolveIdentityContact: (...a: unknown[]) => h.resolveIdentity(...a),
}))
vi.mock('@/lib/conversations/find-or-create', () => ({ findOrCreateConversation: (...a: unknown[]) => h.findOrCreateConversation(...a) }))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: (...a: unknown[]) => h.reopen(...a) }))
vi.mock('@/lib/widget/inbound', () => ({
  isFirstCustomerMessage: (...a: unknown[]) => h.isFirst(...a),
  runWidgetInboundFanout: (...a: unknown[]) => h.fanOut(...a),
}))
vi.mock('./media', () => ({ mirrorUserFile: (...a: unknown[]) => h.mirror(...a) }))

import { applyReceipt, canMoveStatus, DROPPED_FILE_NOTE, ingestInbound, resolveVircleContact } from './events'
import type { VircleChatConfigRow } from './config'
import type { InboundEvent, ReceiptEvent } from './contract'

/** A chainable fake: select reads the scripted `existing`, insert records the row, update records the patch. */
const admin = {
  storage: {},
  from(table: string) {
    let mode: 'select' | 'insert' | 'update' = 'select'
    let patch: Record<string, unknown> = {}
    const filters: Record<string, unknown> = {}
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (row: Record<string, unknown>) => {
        mode = 'insert'
        h.inserted.push(row)
        return b
      },
      update: (row: Record<string, unknown>) => {
        mode = 'update'
        patch = row
        return b
      },
      eq: (col: string, v: unknown) => {
        filters[col] = v
        return b
      },
      limit: async () => ({ data: h.existing ? [h.existing] : [], error: null }),
      single: async () => (mode === 'insert' ? h.insertResult : { data: null, error: null }),
      then: (resolve: (r: unknown) => unknown) => {
        if (mode === 'update') {
          h.updates.push({ table, row: patch, filters })
          return resolve({ data: h.updateReturns, error: null })
        }
        return resolve({ data: [], error: null })
      },
    }
    return b
  },
}

const cfg = { id: 'vc-1', account_id: 'acct-1' } as VircleChatConfigRow

const inbound = (over: Partial<InboundEvent['message']> = {}, user: Partial<InboundEvent['user']> = {}): InboundEvent => ({
  kind: 'message.inbound',
  eventId: 'evt_1',
  workspaceKey: 'vcw_x',
  user: { walletId: 'W123', name: 'Aisha', phone: '+60 12-345 6789', email: 'A@Example.com', ...user },
  conversationId: 'c_9f2',
  message: { serverId: 'm_77', clientId: null, seq: 41, type: 'text', text: 'Hi, I cannot top up', sentAt: null, media: null, ...over },
})

beforeEach(() => {
  h.existing = null
  h.insertResult = { data: { id: 'msg-new' }, error: null }
  h.inserted = []
  h.updates = []
  h.updateReturns = [{ id: 'msg-1' }]
  for (const f of [h.store.findByWallet, h.store.mergeContacts, h.store.recordSuggestion, h.resolveIdentity, h.findOrCreateConversation, h.fanOut, h.isFirst, h.mirror, h.reopen]) f.mockReset()
  h.store.findByWallet.mockResolvedValue(null)
  h.store.mergeContacts.mockResolvedValue(true)
  h.resolveIdentity.mockResolvedValue({ contactId: 'ct-1', created: false })
  h.findOrCreateConversation.mockResolvedValue({ conversation: { id: 'cv-1', status: 'open', vircle_conversation_id: null }, created: false })
  h.isFirst.mockResolvedValue(false)
  h.reopen.mockResolvedValue(undefined)
  h.fanOut.mockResolvedValue(undefined)
})

describe('resolveVircleContact', () => {
  it('matches as a verified identity with digits-only phone and lower-cased email', async () => {
    await resolveVircleContact(admin as never, 'acct-1', 'owner-1', inbound().user)
    expect(h.resolveIdentity).toHaveBeenCalledWith(h.store, {
      accountId: 'acct-1',
      ownerUserId: 'owner-1',
      verified: true,
      identity: { phone: '60123456789', email: 'a@example.com', walletId: 'W123', name: 'Aisha' },
    })
    expect(h.store.mergeContacts).not.toHaveBeenCalled()
  })

  it('names a new contact "Vircle user" when the gateway sent no name, and drops a phone that is not a phone', async () => {
    await resolveVircleContact(admin as never, 'acct-1', 'owner-1', { walletId: 'W1', name: null, phone: 'abc', email: null })
    expect(h.resolveIdentity.mock.calls[0][1].identity).toEqual({ phone: null, email: null, walletId: 'W1', name: 'Vircle user' })
  })

  it('folds the wallet\'s own contact into the one the phone matched', async () => {
    h.store.findByWallet.mockResolvedValue({ id: 'wallet-contact' })
    h.resolveIdentity.mockResolvedValue({ contactId: 'phone-contact', created: false })
    const r = await resolveVircleContact(admin as never, 'acct-1', 'owner-1', inbound().user)
    expect(r.contactId).toBe('phone-contact')
    expect(h.store.mergeContacts).toHaveBeenCalledWith('acct-1', 'phone-contact', 'wallet-contact')
  })

  it('records a possible-duplicate suggestion when that merge fails, and keeps going', async () => {
    h.store.findByWallet.mockResolvedValue({ id: 'wallet-contact' })
    h.resolveIdentity.mockResolvedValue({ contactId: 'phone-contact', created: false })
    h.store.mergeContacts.mockResolvedValue(false)
    await resolveVircleContact(admin as never, 'acct-1', 'owner-1', inbound().user)
    expect(h.store.recordSuggestion).toHaveBeenCalledWith('acct-1', 'phone-contact', 'wallet-contact')
  })

  it('does nothing extra when the wallet\'s contact is the one resolved', async () => {
    h.store.findByWallet.mockResolvedValue({ id: 'ct-1' })
    await resolveVircleContact(admin as never, 'acct-1', 'owner-1', inbound().user)
    expect(h.store.mergeContacts).not.toHaveBeenCalled()
  })
})

describe('ingestInbound', () => {
  it('stores the message on the contact\'s one conversation, keyed by the gateway id', async () => {
    const r = await ingestInbound(admin as never, cfg, inbound())
    expect(r).toMatchObject({ status: 'stored', messageId: 'msg-new', contactId: 'ct-1', conversationId: 'cv-1' })
    expect(h.inserted[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Hi, I cannot top up',
      channel_type: 'vircle_chat',
      status: 'sent',
      message_id: 'm_77',
      media_url: null,
    })
  })

  it('remembers the gateway\'s conversation id on the Halo conversation', async () => {
    await ingestInbound(admin as never, cfg, inbound())
    expect(h.updates).toContainEqual({ table: 'conversations', row: { vircle_conversation_id: 'c_9f2' }, filters: { id: 'cv-1' } })
  })

  it('does not touch the conversation when it already knows that id', async () => {
    h.findOrCreateConversation.mockResolvedValue({ conversation: { id: 'cv-1', vircle_conversation_id: 'c_9f2' }, created: false })
    await ingestInbound(admin as never, cfg, inbound())
    expect(h.updates.filter((u) => u.table === 'conversations')).toHaveLength(0)
  })

  it('runs nothing at all for a message it has already stored', async () => {
    h.existing = { id: 'old', status: 'sent', conversation_id: 'cv-1' }
    const r = await ingestInbound(admin as never, cfg, inbound())
    expect(r).toEqual({ status: 'duplicate', messageId: 'old' })
    expect(h.inserted).toHaveLength(0)
    expect(h.resolveIdentity).not.toHaveBeenCalled()
  })

  it('treats a unique-violation race as a duplicate, not a failure', async () => {
    h.insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } }
    const r = await ingestInbound(admin as never, cfg, inbound())
    expect(r.status).toBe('duplicate')
  })

  it('fails (so the gateway retries) when the message cannot be stored', async () => {
    h.insertResult = { data: null, error: { message: 'connection reset' } }
    await expect(ingestInbound(admin as never, cfg, inbound())).rejects.toThrow(/Could not store/)
  })

  it('copies a file into private storage and stores its identifier', async () => {
    h.mirror.mockResolvedValue('https://x.supabase.co/storage/v1/object/public/chat-media/account-acct-1/inbound/vc-m_77-a.png')
    const ev = inbound({
      type: 'image',
      text: 'receipt',
      media: { url: 'https://files.example/a', mimeType: 'image/png', fileName: 'a.png', sizeBytes: 10 },
    })
    await ingestInbound(admin as never, cfg, ev)
    expect(h.mirror).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1', serverId: 'm_77', kind: 'image' }))
    expect(h.inserted[0]).toMatchObject({ content_type: 'image', media_type: 'image/png', content_text: 'receipt' })
    expect(String(h.inserted[0].media_url)).toContain('/chat-media/account-acct-1/inbound/')
  })

  it('keeps the text and says so when a file cannot be taken', async () => {
    h.mirror.mockResolvedValue(null)
    const ev = inbound({ type: 'image', text: 'receipt', media: { url: 'https://files.example/a', mimeType: 'image/png', fileName: null, sizeBytes: null } })
    await ingestInbound(admin as never, cfg, ev)
    expect(h.inserted[0]).toMatchObject({ content_type: 'text', media_url: null, content_text: `receipt\n\n${DROPPED_FILE_NOTE}` })
    const bare = inbound({ type: 'image', text: null, media: { url: 'https://files.example/a', mimeType: 'image/png', fileName: null, sizeBytes: null } })
    await ingestInbound(admin as never, cfg, bare)
    expect(h.inserted[1]).toMatchObject({ content_type: 'text', content_text: DROPPED_FILE_NOTE })
  })

  it('defers everything that follows the message to fanOut(), on the vircle_chat channel', async () => {
    h.isFirst.mockResolvedValue(true)
    const r = await ingestInbound(admin as never, cfg, inbound())
    if (r.status !== 'stored') throw new Error('expected stored')
    expect(h.fanOut).not.toHaveBeenCalled()
    await r.fanOut()
    expect(h.reopen).toHaveBeenCalled()
    expect(h.fanOut).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'ct-1',
        messageId: 'msg-new',
        text: 'Hi, I cannot top up',
        isFirstInboundMessage: true,
        channelType: 'vircle_chat',
        media: null,
      }),
    )
  })
})

describe('canMoveStatus', () => {
  it('moves forward only', () => {
    expect(canMoveStatus('sent', 'delivered')).toBe(true)
    expect(canMoveStatus('delivered', 'read')).toBe(true)
    expect(canMoveStatus('sent', 'read')).toBe(true)
    expect(canMoveStatus('read', 'delivered')).toBe(false)
    expect(canMoveStatus('delivered', 'delivered')).toBe(false)
  })
  it('accepts failed only before the app confirmed anything, and never leaves failed', () => {
    expect(canMoveStatus('sent', 'failed')).toBe(true)
    expect(canMoveStatus('delivered', 'failed')).toBe(false)
    expect(canMoveStatus('read', 'failed')).toBe(false)
    expect(canMoveStatus('failed', 'delivered')).toBe(false)
  })
})

describe('applyReceipt', () => {
  const receipt = (status: ReceiptEvent['status'], error: ReceiptEvent['error'] = null): ReceiptEvent => ({
    kind: 'message.receipt',
    eventId: 'evt_2',
    workspaceKey: 'vcw_x',
    serverId: 'm_78',
    status,
    at: null,
    error,
  })

  it('moves a sent message forward and says what it did', async () => {
    h.existing = { id: 'msg-1', status: 'sent', conversation_id: 'cv-1' }
    expect(await applyReceipt(admin as never, cfg, receipt('delivered'))).toEqual({ status: 'updated' })
    expect(h.updates[0]).toMatchObject({ table: 'messages', row: { status: 'delivered' }, filters: { id: 'msg-1', status: 'sent' } })
  })

  it('ignores a receipt that would move a message backwards', async () => {
    h.existing = { id: 'msg-1', status: 'read', conversation_id: 'cv-1' }
    expect(await applyReceipt(admin as never, cfg, receipt('delivered'))).toEqual({ status: 'ignored' })
    expect(h.updates).toHaveLength(0)
  })

  it('answers "unknown message" for a server id Halo never stored', async () => {
    expect(await applyReceipt(admin as never, cfg, receipt('read'))).toEqual({ status: 'unknown_message' })
  })

  it('records why a message failed and raises the Not sent marker on the conversation', async () => {
    h.existing = { id: 'msg-1', status: 'sent', conversation_id: 'cv-1' }
    await applyReceipt(admin as never, cfg, receipt('failed', { code: 'blocked', message: 'opted out' }))
    expect(h.updates[0].row).toMatchObject({ status: 'failed', error_code: 'blocked', error_title: 'opted out' })
    expect(h.updates[1]).toMatchObject({ table: 'conversations', row: { last_message_failed: true }, filters: { id: 'cv-1' } })
  })

  it('does not raise the marker when another event already changed the message', async () => {
    h.existing = { id: 'msg-1', status: 'sent', conversation_id: 'cv-1' }
    h.updateReturns = []
    await applyReceipt(admin as never, cfg, receipt('failed'))
    expect(h.updates.filter((u) => u.table === 'conversations')).toHaveLength(0)
  })
})
