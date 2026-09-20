import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateReply } from './generate'
import { MAX_OUTPUT_TOKENS } from './defaults'
import type { AiConfig } from './types'

// A job that returns a whole article (translation) may ask for a longer
// reply and a longer wait than a chat reply gets; everything else is unchanged.

const config = (over: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'openai',
  model: 'm',
  apiKey: 'k',
  baseUrl: null,
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: false,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
  ...over,
})

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response
const openAiOk = () => ok({ choices: [{ message: { content: 'hi' } }] })
const anthropicOk = () => ok({ content: [{ type: 'text', text: 'hi' }] })
const sent = (f: ReturnType<typeof vi.fn>) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)
const msgs = [{ role: 'user' as const, content: 'x' }]

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('maxOutputTokens', () => {
  it('keeps the chat-reply cap when none is asked for', async () => {
    fetchMock.mockResolvedValue(openAiOk())
    await generateReply({ config: config(), systemPrompt: 's', messages: msgs })
    expect(sent(fetchMock).max_completion_tokens).toBe(MAX_OUTPUT_TOKENS)
  })

  it('raises it on OpenAI, on a compatible service and on Anthropic', async () => {
    fetchMock.mockResolvedValue(openAiOk())
    await generateReply({ config: config(), systemPrompt: 's', messages: msgs, maxOutputTokens: 9000 })
    expect(sent(fetchMock).max_completion_tokens).toBe(9000)

    fetchMock.mockReset().mockResolvedValue(openAiOk())
    await generateReply({
      config: config({ provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1' }),
      systemPrompt: 's',
      messages: msgs,
      maxOutputTokens: 7000,
    })
    expect(sent(fetchMock).max_tokens).toBe(7000)

    fetchMock.mockReset().mockResolvedValue(anthropicOk())
    await generateReply({ config: config({ provider: 'anthropic' }), systemPrompt: 's', messages: msgs, maxOutputTokens: 12000 })
    expect(sent(fetchMock).max_tokens).toBe(12000)
  })

  it('never gives a Kimi thinking model less room than it needs', async () => {
    fetchMock.mockResolvedValue(openAiOk())
    const kimi = config({ provider: 'openai_compatible', baseUrl: 'https://api.moonshot.ai/v1' })
    await generateReply({ config: kimi, systemPrompt: 's', messages: msgs })
    // thinking is switched off on the first attempt: the ordinary cap applies
    expect(sent(fetchMock).max_tokens).toBe(MAX_OUTPUT_TOKENS)
    fetchMock.mockReset().mockResolvedValue(openAiOk())
    await generateReply({ config: kimi, systemPrompt: 's', messages: msgs, maxOutputTokens: 16000 })
    expect(sent(fetchMock).max_tokens).toBe(16000)
  })
})

describe('timeoutMs', () => {
  it('uses the per-call timeout instead of the default', async () => {
    fetchMock.mockResolvedValue(openAiOk())
    const spy = vi.spyOn(AbortSignal, 'timeout')
    await generateReply({ config: config(), systemPrompt: 's', messages: msgs, timeoutMs: 123_000 })
    expect(spy).toHaveBeenCalledWith(123_000)
  })

  it('falls back to the default timeout', async () => {
    fetchMock.mockResolvedValue(openAiOk())
    const spy = vi.spyOn(AbortSignal, 'timeout')
    await generateReply({ config: config(), systemPrompt: 's', messages: msgs })
    expect(spy).toHaveBeenCalledWith(30_000)
  })
})
