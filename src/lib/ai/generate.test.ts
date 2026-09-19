import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    baseUrl: null,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('sends OpenAI its own token-limit parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await generateReply({ config: config(), systemPrompt: 'sys', messages: [{ role: 'user', content: 'Hi' }] })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.max_completion_tokens).toBeGreaterThan(0)
    expect(body.max_tokens).toBeUndefined()
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})

describe('generateReply — OpenAI-compatible provider', () => {
  const compat = (over: Partial<AiConfig> = {}) =>
    config({ provider: 'openai_compatible', baseUrl: 'https://api.moonshot.ai/v1/', model: 'kimi-test', ...over })

  it('calls {baseUrl}/chat/completions with the classic max_tokens parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Hello from Kimi' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({ config: compat(), systemPrompt: 'sys', messages: [{ role: 'user', content: 'Hi' }] })

    expect(res.text).toBe('Hello from Kimi')
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.moonshot.ai/v1/chat/completions')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(opts.body)
    expect(body.model).toBe('kimi-test')
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('uses only the final content of a reasoning model, not its thinking', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ choices: [{ message: { content: 'Final answer', reasoning_content: 'Let me think…' } }] }),
      ),
    )
    const res = await generateReply({ config: compat(), systemPrompt: 's', messages: [{ role: 'user', content: 'Hi' }] })
    expect(res.text).toBe('Final answer')
  })

  it('accepts content returned as a list of text parts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ choices: [{ message: { content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }] } }] }),
      ),
    )
    const res = await generateReply({ config: compat(), systemPrompt: 's', messages: [{ role: 'user', content: 'Hi' }] })
    expect(res.text).toBe('Part one. Part two.')
  })

  it('names the compatible host, not OpenAI, in errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'Invalid Authentication' } })))
    await expect(
      generateReply({ config: compat(), systemPrompt: 's', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ code: 'invalid_key', message: expect.stringContaining('api.moonshot.ai') })
  })

  it('reports an empty reply as an error naming the host', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })))
    await expect(
      generateReply({ config: compat(), systemPrompt: 's', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ code: 'empty_response', message: expect.stringContaining('api.moonshot.ai') })
  })
})
