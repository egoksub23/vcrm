import { beforeEach, describe, expect, it, vi } from 'vitest'

// Resend of a failed message: who may do it, what it rebuilds, that a double
// click sends once, that the failed row is replaced (not duplicated) on
// success and keeps its reason when the retry fails too.

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  sendMessageToConversation: vi.fn(),
  loadWhatsappWindowOpen: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireCapability: h.requireCapability,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : 'x' },
      { status: (err as { status?: number }).status ?? 500 },
    ),
}))

vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: h.sendMessageToConversation,
}))

vi.mock('@/lib/messages/window', () => ({
  loadWhatsappWindowOpen: h.loadWhatsappWindowOpen,
}))

import { POST } from './route'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const MSG = '3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f'
const CONV = 'c0000000-0000-4000-8000-000000000001'

interface State {
  row: Record<string, unknown> | null
  conversation: { id: string; account_id: string } | null
  updates: Record<string, unknown>[]
  deletes: number
  deleteError: { message: string } | null
}

function failedRow(over: Record<string, unknown> = {}) {
  return {
    id: MSG,
    conversation_id: CONV,
    sender_type: 'agent',
    sender_id: 'user-1',
    is_internal: false,
    content_type: 'text',
    content_text: 'hello there',
    content_html: null,
    media_url: null,
    template_name: null,
    interactive_payload: null,
    channel_type: 'whatsapp',
    ai_generated: false,
    reply_to_message_id: null,
    send_payload: null,
    status: 'failed',
    error_code: 131047,
    error_title: 'Re-engagement message',
    error_details: null,
    ...over,
  }
}

/** A one-row `messages` table with the calls the route makes on it. */
function makeDb(state: State) {
  return {
    from(table: string) {
      if (table !== 'messages') throw new Error(`unexpected table ${table}`)
      let op: 'select' | 'update' | 'delete' = 'select'
      let patch: Record<string, unknown> = {}
      const filters: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      const matches = () =>
        !!state.row &&
        state.row.id === filters.id &&
        (filters.status === undefined || state.row.status === filters.status)
      b.select = () => b
      b.update = (p: Record<string, unknown>) => {
        op = 'update'
        patch = p
        return b
      }
      b.delete = () => {
        op = 'delete'
        return b
      }
      b.eq = (k: string, v: unknown) => {
        filters[k] = v
        return b
      }
      b.maybeSingle = async () => ({
        data: state.row ? { ...state.row, conversation: state.conversation } : null,
        error: null,
      })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (op === 'update') {
          const hit = matches()
          if (hit) {
            Object.assign(state.row!, patch)
            state.updates.push(patch)
          }
          return resolve({ data: hit ? [{ id: filters.id }] : [], error: null })
        }
        if (op === 'delete') {
          if (state.deleteError) return resolve({ data: null, error: state.deleteError })
          if (matches()) {
            state.row = null
            state.deletes += 1
          }
          return resolve({ data: null, error: null })
        }
        return resolve({ data: null, error: null })
      }
      return b
    },
  }
}

function setup(over: Partial<State> = {}, caps: { userId?: string } = {}) {
  const state: State = {
    row: failedRow(),
    conversation: { id: CONV, account_id: 'acct-1' },
    updates: [],
    deletes: 0,
    deleteError: null,
    ...over,
  }
  h.requireCapability.mockResolvedValue({
    supabase: makeDb(state),
    accountId: 'acct-1',
    userId: caps.userId ?? 'user-2',
  })
  return state
}

const call = () =>
  POST(new Request(`http://x/api/messages/${MSG}/resend`, { method: 'POST' }), {
    params: Promise.resolve({ id: MSG }),
  })

beforeEach(() => {
  __resetRateLimitForTests()
  h.requireCapability.mockReset()
  h.sendMessageToConversation.mockReset()
  h.loadWhatsappWindowOpen.mockReset()
  h.loadWhatsappWindowOpen.mockResolvedValue(true)
  h.sendMessageToConversation.mockResolvedValue({ messageId: 'new-msg', whatsappMessageId: 'wamid.9' })
})

describe('POST /api/messages/[id]/resend — permission and shape', () => {
  it('needs the messages.send capability', async () => {
    h.requireCapability.mockRejectedValue(
      Object.assign(new Error("This action requires the 'messages.send' permission"), { status: 403 }),
    )
    const res = await call()
    expect(res.status).toBe(403)
    expect(h.requireCapability).toHaveBeenCalledWith('messages.send')
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('404s for a message that does not exist or belongs to another account', async () => {
    setup({ row: null })
    expect((await call()).status).toBe(404)
    setup({ conversation: { id: CONV, account_id: 'other-account' } })
    expect((await call()).status).toBe(404)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('refuses a customer message, an internal comment, and an unsupported type', async () => {
    setup({ row: failedRow({ sender_type: 'customer' }) })
    expect((await call()).status).toBe(400)
    setup({ row: failedRow({ is_internal: true }) })
    expect((await call()).status).toBe(400)
    setup({ row: failedRow({ content_type: 'location' }) })
    expect((await call()).status).toBe(400)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('refuses a message that is not failed, and one already being resent', async () => {
    setup({ row: failedRow({ status: 'sent' }) })
    const notFailed = await call()
    expect(notFailed.status).toBe(409)
    expect((await notFailed.json()).code).toBe('not_failed')

    setup({ row: failedRow({ status: 'sending' }) })
    const busy = await call()
    expect(busy.status).toBe(409)
    expect((await busy.json()).code).toBe('in_progress')
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })
})

describe('POST /api/messages/[id]/resend — the 24-hour rule', () => {
  it('does not retry a free-form WhatsApp message once the window is closed', async () => {
    const state = setup()
    h.loadWhatsappWindowOpen.mockResolvedValue(false)
    const res = await call()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('window_closed')
    expect(body.needs_template).toBe(true)
    expect(body.error).toMatch(/template/i)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
    // Nothing was claimed: the message is still a failed bubble.
    expect(state.row?.status).toBe('failed')
  })

  it('lets a template through (a template is what reopens the window)', async () => {
    setup({ row: failedRow({ content_type: 'template', template_name: 'order_update' }) })
    h.loadWhatsappWindowOpen.mockResolvedValue(false)
    const res = await call()
    expect(res.status).toBe(200)
    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
  })

  it('does not apply the WhatsApp rule to other channels', async () => {
    setup({ row: failedRow({ channel_type: 'messenger' }) })
    h.loadWhatsappWindowOpen.mockResolvedValue(false)
    expect((await call()).status).toBe(200)
    expect(h.loadWhatsappWindowOpen).not.toHaveBeenCalled()
  })
})

describe('POST /api/messages/[id]/resend — sending again', () => {
  it('rebuilds the same content on the same channel and replaces the failed row', async () => {
    const state = setup({
      row: failedRow({
        content_type: 'template',
        content_text: 'Your order A123 ships on Friday',
        template_name: 'order_update',
        reply_to_message_id: 'parent-1',
        send_payload: {
          template_language: 'en',
          template_params: ['A123', 'Friday'],
          template_message_params: { body: ['A123', 'Friday'] },
        },
      }),
    })
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true,
      message_id: 'new-msg',
      replaced_message_id: MSG,
    })

    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
    const [, accountId, params] = h.sendMessageToConversation.mock.calls[0]
    expect(accountId).toBe('acct-1')
    expect(params).toMatchObject({
      conversationId: CONV,
      messageType: 'template',
      contentText: 'Your order A123 ships on Friday',
      templateName: 'order_update',
      templateLanguage: 'en',
      templateParams: ['A123', 'Friday'],
      templateMessageParams: { body: ['A123', 'Friday'] },
      replyToMessageId: 'parent-1',
      channelOverride: 'whatsapp',
      senderType: 'agent',
      senderUserId: 'user-1',
      // The route owns the failed row; the core must not add a second one.
      persistFailedAttempt: false,
    })
    // The failed row is gone (one bubble, not two).
    expect(state.row).toBeNull()
    expect(state.deletes).toBe(1)
  })

  it('resends media and interactive content from the stored row', async () => {
    setup({
      row: failedRow({
        content_type: 'image',
        media_url: 'https://cdn/x.png',
        content_text: 'caption',
        send_payload: { filename: 'x.png' },
      }),
    })
    await call()
    expect(h.sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'image',
      mediaUrl: 'https://cdn/x.png',
      contentText: 'caption',
      filename: 'x.png',
    })

    const payload = { kind: 'buttons', body: 'Pick', buttons: [{ id: 'a', title: 'A' }] }
    setup({ row: failedRow({ content_type: 'interactive', content_text: 'Pick', interactive_payload: payload }) })
    h.sendMessageToConversation.mockClear()
    await call()
    expect(h.sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      messageType: 'interactive',
      interactivePayload: payload,
    })
  })

  it('keeps a bot message a bot message, with no human attribution', async () => {
    setup({ row: failedRow({ sender_type: 'bot', sender_id: null, ai_generated: true }) })
    await call()
    expect(h.sendMessageToConversation.mock.calls[0][2]).toMatchObject({
      senderType: 'bot',
      senderUserId: null,
      aiGenerated: true,
    })
  })

  it('attributes an agent message with no stored sender to whoever clicked Resend', async () => {
    setup({ row: failedRow({ sender_id: null }) }, { userId: 'user-9' })
    await call()
    expect(h.sendMessageToConversation.mock.calls[0][2].senderUserId).toBe('user-9')
  })

  it('a double click sends once: the second request loses the claim', async () => {
    let release!: (v: unknown) => void
    h.sendMessageToConversation.mockReturnValue(new Promise((r) => (release = r)))
    const state = setup()

    const first = call()
    const second = call()
    // The loser answers straight away, before the send has finished.
    const secondRes = await second
    expect(secondRes.status).toBe(409)
    expect((await secondRes.json()).code).toBe('in_progress')

    release({ messageId: 'new-msg', whatsappMessageId: 'wamid.9' })
    const firstRes = await first
    expect(firstRes.status).toBe(200)
    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
    expect(state.row).toBeNull()
  })

  it('hides the failed row instead when it cannot be deleted', async () => {
    const state = setup({ deleteError: { message: 'nope' } })
    const res = await call()
    expect(res.status).toBe(200)
    expect(state.row).toMatchObject({ status: 'failed', pending_delete: true })
  })
})

describe('POST /api/messages/[id]/resend — when the retry fails too', () => {
  it('puts the row back to failed with the new reason and returns it', async () => {
    const state = setup()
    h.sendMessageToConversation.mockRejectedValue(
      new SendMessageError('meta_error', 'Meta API error: (#131030) Not allowed', 502, {
        failure: { code: 131030, title: 'Not allowed', details: 'add it' },
      }),
    )
    const res = await call()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.failed_message_id).toBe(MSG)
    expect(body.failure).toMatchObject({ code: 131030, title: 'Not allowed', kind: 'allowlist' })

    expect(state.row).toMatchObject({
      status: 'failed',
      error_code: 131030,
      error_title: 'Not allowed',
      error_details: 'add it',
    })
    // It can be tried again.
    h.sendMessageToConversation.mockResolvedValue({ messageId: 'new-msg', whatsappMessageId: 'w' })
    expect((await call()).status).toBe(200)
  })

  it('keeps the old reason for an error that is not from the channel (e.g. not connected)', async () => {
    const state = setup()
    h.sendMessageToConversation.mockRejectedValue(
      new SendMessageError('whatsapp_not_configured', 'WhatsApp not configured', 400),
    )
    const res = await call()
    expect(res.status).toBe(400)
    expect(state.row).toMatchObject({ status: 'failed', error_code: 131047 })
  })

  it('restores the failed state before rethrowing an unexpected error', async () => {
    const state = setup()
    h.sendMessageToConversation.mockRejectedValue(new Error('boom'))
    const res = await call()
    expect(res.status).toBe(500)
    expect(state.row?.status).toBe('failed')
  })
})
