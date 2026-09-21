import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  searchKnowledge: vi.fn(),
  logKnowledgeUse: vi.fn(),
  logKnowledgeGap: vi.fn(),
  generateReply: vi.fn(),
  getPreferredLanguage: vi.fn(),
  sendMessageToConversation: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  loadSendableAttachments: vi.fn(),
  sendKnowledgeAttachments: vi.fn(),
  postSourcesNote: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
  getPreferredLanguage: h.getPreferredLanguage,
}))
vi.mock('./knowledge', () => ({
  searchKnowledge: h.searchKnowledge,
  logKnowledgeUse: h.logKnowledgeUse,
  logKnowledgeGap: h.logKnowledgeGap,
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/knowledge/attachments', () => ({
  loadSendableAttachments: h.loadSendableAttachments,
  sendKnowledgeAttachments: h.sendKnowledgeAttachments,
}))
vi.mock('@/lib/knowledge/sources-note', () => ({ postSourcesNote: h.postSourcesNote }))
vi.mock('@/lib/flows/meta-send', () => ({
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: h.sendMessageToConversation,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    baseUrl: null,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.getPreferredLanguage.mockResolvedValue(null)
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.searchKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.sendMessageToConversation.mockResolvedValue({ messageId: 'msg-1', whatsappMessageId: 'm1' })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
  h.loadSendableAttachments.mockReset()
  h.sendKnowledgeAttachments.mockReset()
  h.postSourcesNote.mockReset()
  h.loadSendableAttachments.mockResolvedValue([])
  h.sendKnowledgeAttachments.mockResolvedValue({ sent: 0, linked: 0, skipped: 0, failed: 0 })
  h.postSourcesNote.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({
        conversationId: 'conv-1',
        contentText: 'Hello!',
        messageType: 'text',
        senderType: 'bot',
        aiGenerated: true,
      }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.searchKnowledge.mockResolvedValue([
      { chunkId: 'c1', documentId: 'd1', title: 'Returns', category: null, language: 'en', content: 'Returns accepted within 30 days.', score: 1, via: 'keyword' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.searchKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      'hi',
      expect.objectContaining({ audience: 'ai' }),
    )
    expect(h.logKnowledgeUse).toHaveBeenCalled()
    // Knowledge excerpts travel in the per-question tail, after the stable prefix.
    const call = h.generateReply.mock.calls[0][0]
    expect(call.systemPromptTail as string).toContain('Returns accepted within 30 days.')
    expect(call.systemPrompt as string).not.toContain('Returns accepted within 30 days.')
  })

  it("answers in the contact's preferred language when one is set", async () => {
    h.getPreferredLanguage.mockResolvedValue('ms')
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('preferred conversation language is Malay')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ conversationId: 'conv-1', contentText: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('queues the question as a knowledge gap when nothing matched', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.logKnowledgeGap).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'hi', 'conv-1')
  })

  it('does not queue a gap when an article matched but the AI still handed off', async () => {
    h.searchKnowledge.mockResolvedValue([
      { chunkId: 'c1', documentId: 'd1', title: 'T', category: null, language: 'en', content: 'x', score: 1, via: 'keyword' },
    ])
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.logKnowledgeGap).not.toHaveBeenCalled()
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

const hit = (chunkId: string, documentId: string, title: string, body: string) => ({
  chunkId, documentId, title, category: null, language: 'en', content: `${title}\n\n${body}`, score: 1, via: 'keyword',
})

describe('dispatchInboundToAiReply — citations, files and the sources note', () => {
  it('numbers one excerpt per article and never shows the customer a [n] marker', async () => {
    h.searchKnowledge.mockResolvedValue([
      hit('c1', 'dA', 'Refunds', 'Within 14 days.'),
      hit('c2', 'dB', 'Hours', 'Nine to six.'),
      hit('c3', 'dA', 'Refunds', 'Keep the receipt.'),
    ])
    h.generateReply.mockResolvedValue({ text: 'Refunds take 14 days [1]. We open at 9 [2].', handoff: false })
    await dispatchInboundToAiReply(ARGS)

    const prompt = h.generateReply.mock.calls[0][0].systemPromptTail as string
    expect(prompt).toContain('[1] Refunds\n\nWithin 14 days.\n\nKeep the receipt.')
    expect(prompt).toContain('[2] Hours\n\nNine to six.')
    expect(prompt).not.toContain('[3]')
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ contentText: 'Refunds take 14 days. We open at 9.' }),
    )
  })

  it("sends the cited articles' files after the text and posts the sources note", async () => {
    const files = [{ id: 'f1', document_id: 'dB', file_name: 'hours.pdf', url: 'https://x/hours.pdf' }]
    h.searchKnowledge.mockResolvedValue([hit('c1', 'dA', 'Refunds', 'a'), hit('c2', 'dB', 'Hours', 'b')])
    h.generateReply.mockResolvedValue({ text: 'We open at 9 [2].', handoff: false })
    h.loadSendableAttachments.mockResolvedValue(files)
    await dispatchInboundToAiReply(ARGS)

    // only article B was cited
    expect(h.loadSendableAttachments).toHaveBeenCalledWith(expect.anything(), 'acct-1', ['dB'])
    expect(h.sendKnowledgeAttachments).toHaveBeenCalledWith(expect.anything(), 'acct-1', {
      conversationId: 'conv-1',
      attachments: files,
    })
    expect(h.postSourcesNote).toHaveBeenCalledWith(expect.anything(), 'acct-1', 'conv-1', [{ id: 'dB', title: 'Hours' }])
    // text first, files after
    expect(h.sendMessageToConversation.mock.invocationCallOrder[0]).toBeLessThan(
      h.sendKnowledgeAttachments.mock.invocationCallOrder[0],
    )
  })

  it('falls back to the best-ranked article when the model cites nothing', async () => {
    h.searchKnowledge.mockResolvedValue([hit('c1', 'dA', 'Refunds', 'a'), hit('c2', 'dB', 'Hours', 'b')])
    h.generateReply.mockResolvedValue({ text: 'Refunds take 14 days.', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadSendableAttachments).toHaveBeenCalledWith(expect.anything(), 'acct-1', ['dA'])
    expect(h.postSourcesNote).toHaveBeenCalledWith(expect.anything(), 'acct-1', 'conv-1', [{ id: 'dA', title: 'Refunds' }])
  })

  it('sends no files and no note when no article was retrieved', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadSendableAttachments).not.toHaveBeenCalled()
    expect(h.sendKnowledgeAttachments).not.toHaveBeenCalled()
    expect(h.postSourcesNote).not.toHaveBeenCalled()
  })

  it('sends no files on a handoff', async () => {
    h.searchKnowledge.mockResolvedValue([hit('c1', 'dA', 'Refunds', 'a')])
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendKnowledgeAttachments).not.toHaveBeenCalled()
    expect(h.postSourcesNote).not.toHaveBeenCalled()
  })

  it('does not attach files when the reply slot was lost', async () => {
    h.state.claim = false
    h.searchKnowledge.mockResolvedValue([hit('c1', 'dA', 'Refunds', 'a')])
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendKnowledgeAttachments).not.toHaveBeenCalled()
  })

  it('a failing file step cannot undo or break the reply', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.searchKnowledge.mockResolvedValue([hit('c1', 'dA', 'Refunds', 'a')])
    h.generateReply.mockResolvedValue({ text: 'Answer [1].', handoff: false })
    h.loadSendableAttachments.mockRejectedValue(new Error('db down'))
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()
    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sources step failed'), expect.any(Error))
    error.mockRestore()
  })

  it('leaves text without excerpts alone (nothing to cite)', async () => {
    h.generateReply.mockResolvedValue({ text: 'Option [1] is popular.', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ contentText: 'Option [1] is popular.' }),
    )
  })
})
