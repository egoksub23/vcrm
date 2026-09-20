import { afterEach, describe, expect, it, vi } from 'vitest'

import { createdArticleId, isKnownTranslateError, outcomesOf, postTranslate } from './translate-client'

afterEach(() => vi.unstubAllGlobals())

const stubFetch = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ status, ok: status < 400, json: () => Promise.resolve(body) }),
  )

describe('postTranslate', () => {
  it('posts the body to the article translate route and returns the results', async () => {
    stubFetch(200, { results: [{ language: 'ms', ok: true, id: 'ms1', overwritten: false }] })
    const call = await postTranslate('base', { language: 'ms', overwrite: false })
    expect(fetch).toHaveBeenCalledWith('/api/knowledge/base/translate', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({ language: 'ms', overwrite: false })
    expect(call.httpStatus).toBe(200)
    expect(call.results).toHaveLength(1)
  })

  it('keeps the typed error of a failed request', async () => {
    stubFetch(429, { results: [{ language: 'ms', ok: false, code: 'budget_exceeded' }], error: 'used up', code: 'budget_exceeded' })
    const call = await postTranslate('base', { language: 'ms' })
    expect(call).toMatchObject({ httpStatus: 429, code: 'budget_exceeded', error: 'used up' })
  })

  it('survives a body that is not JSON, and a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500, ok: false, json: () => Promise.reject(new Error('no')) }))
    expect(await postTranslate('base', { language: 'ms' })).toMatchObject({ httpStatus: 500, results: [] })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await postTranslate('base', { language: 'ms' })).toMatchObject({ httpStatus: 0, code: 'network', results: [] })
  })
})

describe('outcomesOf', () => {
  it('uses the per-language results when there are some', () => {
    const results = [{ language: 'ms' as const, ok: true, id: 'x' }]
    expect(outcomesOf({ results, httpStatus: 200 }, ['ms'])).toBe(results)
  })

  it('repeats a request-level failure for each language asked for', () => {
    const out = outcomesOf({ results: [], code: 'forbidden', error: 'no', httpStatus: 403 }, ['ms', 'zh'])
    expect(out).toEqual([
      { language: 'ms', ok: false, code: 'forbidden', error: 'no' },
      { language: 'zh', ok: false, code: 'forbidden', error: 'no' },
    ])
    expect(outcomesOf({ results: [], httpStatus: 0 }, ['ms'])[0].code).toBe('network')
  })
})

describe('helpers', () => {
  it('finds the article a translation produced', () => {
    expect(createdArticleId([{ language: 'ms', ok: false }, { language: 'zh', ok: true, id: 'zh1' }])).toBe('zh1')
    expect(createdArticleId([{ language: 'ms', ok: false }])).toBeNull()
  })

  it('knows the codes it has wording for', () => {
    expect(isKnownTranslateError('budget_exceeded')).toBe(true)
    expect(isKnownTranslateError('timeout')).toBe(false)
    expect(isKnownTranslateError(undefined)).toBe(false)
  })
})
