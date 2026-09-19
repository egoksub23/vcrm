import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listModels } from './models'

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response
const err = (status: number, json: unknown = {}) => ({ ok: false, status, json: async () => json }) as unknown as Response

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('listModels', () => {
  it('reads {baseUrl}/models for an OpenAI-compatible provider, de-duplicated and sorted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ data: [{ id: 'kimi-b' }, { id: 'kimi-a' }, { id: 'kimi-b' }, {}] }))
    vi.stubGlobal('fetch', fetchMock)
    const ids = await listModels({ provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://api.moonshot.ai/v1/' })
    expect(ids).toEqual(['kimi-a', 'kimi-b'])
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.moonshot.ai/v1/models')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer k')
  })

  it('uses the OpenAI and Anthropic endpoints with their own auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listModels({ provider: 'openai', apiKey: 'k', baseUrl: null })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/models')
    await listModels({ provider: 'anthropic', apiKey: 'k', baseUrl: null })
    expect(fetchMock.mock.calls[1][0]).toContain('api.anthropic.com/v1/models')
    expect(fetchMock.mock.calls[1][1].headers['x-api-key']).toBe('k')
  })

  it('maps a rejected key to invalid_key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(401, { error: { message: 'bad key' } })))
    await expect(
      listModels({ provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://api.moonshot.ai/v1' }),
    ).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('reports a service with no models endpoint as a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(err(404)))
    await expect(
      listModels({ provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://gw.example.com/v1' }),
    ).rejects.toMatchObject({ code: 'provider_error' })
  })

  it('requires a base URL for a compatible provider', async () => {
    await expect(listModels({ provider: 'openai_compatible', apiKey: 'k', baseUrl: null })).rejects.toMatchObject({
      code: 'base_url_required',
    })
  })
})
