import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  defaultReasoningEffort,
  generateOpenAi,
  isOpenAiReasoningModel,
  nextReasoningEffort,
  resetReasoningEffortMemo,
} from './openai'
import {
  anthropicCacheMinTokens,
  buildAnthropicSystem,
  estimateTokens,
  generateAnthropic,
} from './anthropic'
import { normalizeUsage } from './shared'
import { budgetState } from '../budget'
import { buildSystemPrompt, buildSystemPromptParts } from '../defaults'

const okResponse = (json: unknown): Response =>
  ({ ok: true, status: 200, json: async () => json }) as unknown as Response

const errResponse = (status: number, message: string): Response => {
  const body = { error: { message } }
  return {
    ok: false,
    status,
    json: async () => body,
    clone() {
      return { text: async () => JSON.stringify(body) }
    },
  } as unknown as Response
}

const chat = (content: string, extra: Record<string, unknown> = {}) =>
  okResponse({ choices: [{ message: { content }, finish_reason: 'stop' }], ...extra })

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(fetchMock.mock.calls[call][1].body)

const openAiArgs = (over: Partial<Parameters<typeof generateOpenAi>[0]> = {}) => ({
  apiKey: 'sk-test',
  model: 'gpt-5-mini',
  systemPrompt: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  timeoutMs: 5000,
  ...over,
})

beforeEach(() => {
  resetReasoningEffortMemo()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('isOpenAiReasoningModel', () => {
  it.each([
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5-2025-08-07',
    'gpt-5.1',
    'gpt-5.4-mini',
    'gpt-5.5',
    'GPT-5-Mini',
    'o1',
    'o3',
    'o3-mini',
    'o4-mini',
    'o4-mini-2025-04-16',
  ])('%s is a reasoning model', (m) => expect(isOpenAiReasoningModel(m)).toBe(true))

  it.each(['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5-chat-latest', 'o10', 'omni', 'kimi-k2', 'claude-sonnet-5', '', 'gpt-50'])(
    '%s is not',
    (m) => expect(isOpenAiReasoningModel(m)).toBe(false),
  )
  it('handles null/undefined', () => {
    expect(isOpenAiReasoningModel(null)).toBe(false)
    expect(isOpenAiReasoningModel(undefined)).toBe(false)
  })
})

describe('reasoning effort mapping', () => {
  it('minimal for the original gpt-5 family', () => {
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-2025-08-07']) {
      expect(defaultReasoningEffort(m)).toBe('minimal')
    }
  })
  it('none for gpt-5.1 to gpt-5.4', () => {
    for (const m of ['gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.4-mini']) {
      expect(defaultReasoningEffort(m)).toBe('none')
    }
  })
  it('low for everything else', () => {
    for (const m of ['gpt-5.5', 'gpt-5.6', 'gpt-6', 'o3', 'o4-mini', 'o1']) {
      expect(defaultReasoningEffort(m)).toBe('low')
    }
  })
  it('walks the ladder none/minimal -> low -> nothing', () => {
    expect(nextReasoningEffort('minimal')).toBe('low')
    expect(nextReasoningEffort('none')).toBe('low')
    expect(nextReasoningEffort('low')).toBeNull()
  })
})

describe('generateOpenAi request body', () => {
  it('sends reasoning_effort for a reasoning model on api.openai.com, never sampling params', async () => {
    const f = vi.fn().mockResolvedValue(chat('ok'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ model: 'gpt-5-mini' }))
    const body = bodyOf(f)
    expect(body.reasoning_effort).toBe('minimal')
    expect(body.max_completion_tokens).toBeGreaterThan(0)
    expect(body.max_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
  })

  it('uses the newer-family value for gpt-5.4-mini and low for o-series', async () => {
    const f = vi.fn().mockResolvedValue(chat('ok'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ model: 'gpt-5.4-mini' }))
    await generateOpenAi(openAiArgs({ model: 'o4-mini' }))
    expect(bodyOf(f, 0).reasoning_effort).toBe('none')
    expect(bodyOf(f, 1).reasoning_effort).toBe('low')
  })

  it('omits it for non-reasoning models', async () => {
    const f = vi.fn().mockResolvedValue(chat('ok'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ model: 'gpt-4.1' }))
    await generateOpenAi(openAiArgs({ model: 'gpt-4o-mini' }))
    expect(bodyOf(f, 0)).not.toHaveProperty('reasoning_effort')
    expect(bodyOf(f, 1)).not.toHaveProperty('reasoning_effort')
  })

  it('omits it for OpenAI-compatible hosts even with a gpt-5 style model id', async () => {
    const f = vi.fn().mockResolvedValue(chat('ok'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ model: 'gpt-5-mini', baseUrl: 'https://gateway.example.com/v1' }))
    const body = bodyOf(f)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('joins the stable prompt and the per-question tail into one system message', async () => {
    const f = vi.fn().mockResolvedValue(chat('ok'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ model: 'gpt-4.1', systemPrompt: 'STABLE', systemPromptTail: 'TAIL' }))
    expect(bodyOf(f).messages[0]).toEqual({ role: 'system', content: 'STABLE\n\nTAIL' })
  })
})

describe('generateOpenAi reasoning_effort retry ladder', () => {
  it('retries once with low, then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errResponse(400, "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model."))
      .mockResolvedValueOnce(chat('fine'))
    vi.stubGlobal('fetch', f)
    const res = await generateOpenAi(openAiArgs({ model: 'gpt-5-nano' }))
    expect(res.text).toBe('fine')
    expect(f).toHaveBeenCalledTimes(2)
    expect(bodyOf(f, 0).reasoning_effort).toBe('minimal')
    expect(bodyOf(f, 1).reasoning_effort).toBe('low')
  })

  it('finally drops the parameter when even low is refused', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errResponse(400, 'Unrecognized request argument supplied: reasoning_effort'))
      .mockResolvedValueOnce(chat('fine'))
    vi.stubGlobal('fetch', f)
    const res = await generateOpenAi(openAiArgs({ model: 'o1-preview' }))
    expect(res.text).toBe('fine')
    expect(f).toHaveBeenCalledTimes(2) // o-series starts at low, so: low -> omitted
    expect(bodyOf(f, 0).reasoning_effort).toBe('low')
    expect(bodyOf(f, 1)).not.toHaveProperty('reasoning_effort')
  })

  it('walks minimal -> low -> nothing (three calls)', async () => {
    const refuse = () => errResponse(400, 'Unsupported parameter: reasoning_effort')
    const f = vi
      .fn()
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(refuse())
      .mockResolvedValueOnce(chat('fine'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ model: 'gpt-5-pro' }))
    expect(f).toHaveBeenCalledTimes(3)
    expect(bodyOf(f, 0).reasoning_effort).toBe('minimal')
    expect(bodyOf(f, 1).reasoning_effort).toBe('low')
    expect(bodyOf(f, 2)).not.toHaveProperty('reasoning_effort')
  })

  it('remembers a refused value so later calls do not repeat the failure', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errResponse(400, 'reasoning_effort not supported'))
      .mockResolvedValue(chat('fine'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ model: 'gpt-5-nano' }))
    await generateOpenAi(openAiArgs({ model: 'gpt-5-nano' }))
    expect(f).toHaveBeenCalledTimes(3)
    expect(bodyOf(f, 2).reasoning_effort).toBe('low')
  })

  it('does not retry a 400 that is about something else', async () => {
    const f = vi.fn().mockResolvedValue(errResponse(400, 'Invalid model'))
    vi.stubGlobal('fetch', f)
    await expect(generateOpenAi(openAiArgs())).rejects.toMatchObject({ code: 'provider_error' })
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('generateOpenAi empty reply cut off by length', () => {
  const cutOff = (usage?: Record<string, unknown>) =>
    okResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage })

  it('retries once with 4x the token limit', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(cutOff({ prompt_tokens: 100, completion_tokens: 256, total_tokens: 356 }))
      .mockResolvedValueOnce(
        chat('answer', {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 300,
            total_tokens: 400,
            completion_tokens_details: { reasoning_tokens: 200 },
          },
        }),
      )
    vi.stubGlobal('fetch', f)
    const res = await generateOpenAi(openAiArgs({ maxOutputTokens: 256 }))
    expect(res.text).toBe('answer')
    expect(bodyOf(f, 0).max_completion_tokens).toBe(256)
    expect(bodyOf(f, 1).max_completion_tokens).toBe(1024)
    // Both calls were billed; reasoning tokens are informational (inside completion).
    expect(res.usage).toEqual({
      promptTokens: 200,
      completionTokens: 556,
      totalTokens: 756,
      reasoningTokens: 200,
    })
  })

  it('retries at most once, then throws empty_response', async () => {
    const f = vi.fn().mockResolvedValue(cutOff())
    vi.stubGlobal('fetch', f)
    await expect(generateOpenAi(openAiArgs({ maxOutputTokens: 256 }))).rejects.toMatchObject({
      code: 'empty_response',
    })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('caps the larger limit', async () => {
    const f = vi.fn().mockResolvedValueOnce(cutOff()).mockResolvedValueOnce(chat('ok'))
    vi.stubGlobal('fetch', f)
    await generateOpenAi(openAiArgs({ maxOutputTokens: 20_000 }))
    expect(bodyOf(f, 1).max_completion_tokens).toBe(32_768)
  })

  it('does not retry an empty reply that ended for another reason', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }))
    vi.stubGlobal('fetch', f)
    await expect(generateOpenAi(openAiArgs())).rejects.toMatchObject({ code: 'empty_response' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does not retry on OpenAI-compatible hosts', async () => {
    const f = vi.fn().mockResolvedValue(cutOff())
    vi.stubGlobal('fetch', f)
    await expect(
      generateOpenAi(openAiArgs({ baseUrl: 'https://gateway.example.com/v1', model: 'some-model' })),
    ).rejects.toMatchObject({ code: 'empty_response' })
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('anthropic cache minimums', () => {
  it.each([
    ['claude-haiku-4-5-20251001', 4096],
    ['claude-haiku-4-5', 4096],
    ['claude-opus-4-5', 4096],
    ['claude-opus-4-6', 4096],
    ['claude-opus-4-7', 2048],
    ['claude-opus-4-8', 1024],
    ['claude-opus-4-1-20250805', 1024],
    ['claude-opus-4-20250514', 1024],
    ['claude-sonnet-4-5-20250929', 1024],
    ['claude-sonnet-4-6', 1024],
    ['claude-sonnet-5', 1024],
    ['claude-opus-5', 512],
    ['claude-fable-5', 512],
    ['claude-3-5-haiku-20241022', 2048],
    ['some-unknown-model', 4096],
  ])('%s needs %i tokens', (model, min) => {
    expect(anthropicCacheMinTokens(model)).toBe(min)
  })
})

describe('buildAnthropicSystem', () => {
  const chars = (tokens: number) => 'x'.repeat(tokens * 4)

  it('stays a plain string below the threshold (no cache_control)', () => {
    expect(buildAnthropicSystem('claude-haiku-4-5-20251001', chars(3000))).toBe(chars(3000))
    expect(buildAnthropicSystem('claude-haiku-4-5-20251001', 'short', 'TAIL')).toBe('short\n\nTAIL')
  })

  it('marks the stable block above the threshold, with the tail after it, unmarked', () => {
    const stable = chars(4200)
    const sys = buildAnthropicSystem('claude-haiku-4-5-20251001', stable, 'KNOWLEDGE')
    expect(sys).toEqual([
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'KNOWLEDGE' },
    ])
  })

  it('uses the model-specific minimum (1500 tokens caches on Sonnet, not on Haiku 4.5)', () => {
    expect(Array.isArray(buildAnthropicSystem('claude-sonnet-5', chars(1500)))).toBe(true)
    expect(Array.isArray(buildAnthropicSystem('claude-haiku-4-5', chars(1500)))).toBe(false)
  })

  it('has a single marked block when there is no tail', () => {
    const sys = buildAnthropicSystem('claude-sonnet-5', chars(1100)) as { cache_control?: unknown }[]
    expect(sys).toHaveLength(1)
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('estimates roughly 4 characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('generateAnthropic', () => {
  const args = (over: Partial<Parameters<typeof generateAnthropic>[0]> = {}) => ({
    apiKey: 'k',
    model: 'claude-sonnet-5',
    systemPrompt: 'sys',
    messages: [{ role: 'user' as const, content: 'hi' }],
    timeoutMs: 5000,
    ...over,
  })
  const reply = (usage: Record<string, unknown>) =>
    okResponse({ content: [{ type: 'text', text: 'hello' }], usage })

  it('request body carries cache_control on the system block only when long enough', async () => {
    const f = vi.fn().mockResolvedValue(reply({ input_tokens: 5, output_tokens: 2 }))
    vi.stubGlobal('fetch', f)
    await generateAnthropic(args({ systemPrompt: 'x'.repeat(8000), systemPromptTail: 'KB' }))
    await generateAnthropic(args({ systemPrompt: 'short', systemPromptTail: 'KB' }))
    const long = bodyOf(f, 0)
    expect(long.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(long.system[1]).toEqual({ type: 'text', text: 'KB' })
    // No cache_control anywhere else: not on the tail, not on messages.
    expect(JSON.stringify(long.messages)).not.toContain('cache_control')
    expect(JSON.stringify(long.system[1])).not.toContain('cache_control')
    const short = bodyOf(f, 1)
    expect(short.system).toBe('short\n\nKB')
    expect(JSON.stringify(short)).not.toContain('cache_control')
  })

  it('counts cache reads and writes inside promptTokens/totalTokens (budget stays conservative)', async () => {
    const f = vi.fn().mockResolvedValue(
      reply({
        input_tokens: 50,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 900,
        output_tokens: 100,
      }),
    )
    vi.stubGlobal('fetch', f)
    const res = await generateAnthropic(args())
    expect(res.usage).toEqual({
      promptTokens: 4950,
      completionTokens: 100,
      totalTokens: 5050,
      cacheReadTokens: 4000,
      cacheWriteTokens: 900,
    })
  })

  it('leaves usage exactly as before when nothing was cached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ input_tokens: 30, output_tokens: 6 })))
    const res = await generateAnthropic(args())
    expect(res.usage).toEqual({ promptTokens: 30, completionTokens: 6, totalTokens: 36 })
    expect(res.usage).not.toHaveProperty('cacheReadTokens')
  })

  it('tolerates null cache fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        reply({ input_tokens: 30, output_tokens: 6, cache_read_input_tokens: null, cache_creation_input_tokens: null }),
      ),
    )
    const res = await generateAnthropic(args())
    expect(res.usage?.totalTokens).toBe(36)
  })

  it('resends the plain prompt if the API rejects cache_control', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(errResponse(400, 'system.0.cache_control: Extra inputs are not permitted'))
      .mockResolvedValueOnce(reply({ input_tokens: 5, output_tokens: 2 }))
    vi.stubGlobal('fetch', f)
    const res = await generateAnthropic(args({ systemPrompt: 'x'.repeat(8000), systemPromptTail: 'KB' }))
    expect(res.text).toBe('hello')
    expect(f).toHaveBeenCalledTimes(2)
    expect(bodyOf(f, 1).system).toBe(`${'x'.repeat(8000)}\n\nKB`)
  })
})

describe('budget accounting', () => {
  it('a cached call costs the same budget as an uncached one', () => {
    const cached = normalizeUsage({ prompt: 50 + 4000 + 900, completion: 100, cacheRead: 4000, cacheWrite: 900 })
    const uncached = normalizeUsage({ prompt: 4950, completion: 100 })
    expect(cached?.totalTokens).toBe(uncached?.totalTokens)
    const state = budgetState(cached!.totalTokens, 5050)
    expect(state.exceeded).toBe(true)
  })

  it('normalizeUsage keeps cache/reasoning numbers out of the total', () => {
    expect(normalizeUsage({ prompt: 10, completion: 20, cacheRead: 8, reasoning: 15 })).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 8,
      reasoningTokens: 15,
    })
  })
})

describe('buildSystemPromptParts', () => {
  const base = { userPrompt: 'We sell shoes.', mode: 'auto_reply' as const, preferredLanguage: 'ko' }

  it('stable + blank line + variable is exactly buildSystemPrompt', () => {
    const knowledge = ['Returns take 14 days.', 'Shipping is free over $50.']
    const { stable, variable } = buildSystemPromptParts({ ...base, knowledge })
    expect(`${stable}\n\n${variable}`).toBe(buildSystemPrompt({ ...base, knowledge }))
  })

  it('keeps knowledge out of the stable prefix and business context inside it', () => {
    const { stable, variable } = buildSystemPromptParts({ ...base, knowledge: ['Returns take 14 days.'] })
    expect(stable).toContain('We sell shoes.')
    expect(stable).not.toContain('Returns take 14 days.')
    expect(variable).toContain('[1] Returns take 14 days.')
  })

  it('has an empty variable part and an unchanged prompt without knowledge', () => {
    const { stable, variable } = buildSystemPromptParts({ ...base, knowledge: [] })
    expect(variable).toBe('')
    expect(stable).toBe(buildSystemPrompt({ ...base, knowledge: [] }))
  })
})
