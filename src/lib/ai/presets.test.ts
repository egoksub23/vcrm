import { describe, expect, it } from 'vitest'

import {
  DEEPSEEK_BASE_URL,
  KIMI_BASE_URLS,
  failureHint,
  hostOf,
  normalizeBaseUrl,
  resolveSelection,
  selectionFromConfig,
} from './presets'

describe('resolveSelection', () => {
  it('maps built-in providers to no base URL', () => {
    expect(resolveSelection({ preset: 'openai', region: 'global', customUrl: '' })).toEqual({ provider: 'openai', baseUrl: null })
    expect(resolveSelection({ preset: 'anthropic', region: 'global', customUrl: '' })).toEqual({ provider: 'anthropic', baseUrl: null })
  })

  it('maps Kimi to the region-specific endpoint and DeepSeek to its own', () => {
    expect(resolveSelection({ preset: 'kimi', region: 'global', customUrl: '' })).toEqual({
      provider: 'openai_compatible',
      baseUrl: KIMI_BASE_URLS.global,
    })
    expect(resolveSelection({ preset: 'kimi', region: 'cn', customUrl: '' }).baseUrl).toBe(KIMI_BASE_URLS.cn)
    expect(resolveSelection({ preset: 'deepseek', region: 'global', customUrl: '' }).baseUrl).toBe(DEEPSEEK_BASE_URL)
  })

  it('normalises a custom URL and treats blank as missing', () => {
    expect(resolveSelection({ preset: 'custom', region: 'global', customUrl: ' https://gw.example.com/v1/ ' }).baseUrl).toBe(
      'https://gw.example.com/v1',
    )
    expect(resolveSelection({ preset: 'custom', region: 'global', customUrl: '  ' }).baseUrl).toBeNull()
  })
})

describe('selectionFromConfig', () => {
  it('round-trips every preset', () => {
    for (const sel of [
      { preset: 'openai', region: 'global', customUrl: '' },
      { preset: 'anthropic', region: 'global', customUrl: '' },
      { preset: 'kimi', region: 'global', customUrl: '' },
      { preset: 'kimi', region: 'cn', customUrl: '' },
      { preset: 'deepseek', region: 'global', customUrl: '' },
      { preset: 'custom', region: 'global', customUrl: 'https://gw.example.com/v1' },
    ] as const) {
      const { provider, baseUrl } = resolveSelection(sel)
      expect(selectionFromConfig(provider, baseUrl)).toEqual(sel)
    }
  })

  it('tolerates a trailing slash on a stored URL', () => {
    expect(selectionFromConfig('openai_compatible', 'https://api.moonshot.ai/v1/').preset).toBe('kimi')
  })
})

describe('helpers', () => {
  it('normalizeBaseUrl strips whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl(' https://a.b/v1// ')).toBe('https://a.b/v1')
  })
  it('hostOf returns the host, or the raw text when unparseable', () => {
    expect(hostOf('https://api.moonshot.ai/v1')).toBe('api.moonshot.ai')
    expect(hostOf('nonsense')).toBe('nonsense')
    expect(hostOf(null)).toBe('')
  })
  it('hints at a region mismatch only for a rejected Kimi key', () => {
    expect(failureHint(KIMI_BASE_URLS.global, 'invalid_key')).toBe('kimi_region')
    expect(failureHint(KIMI_BASE_URLS.cn, 'invalid_key')).toBe('kimi_region')
    expect(failureHint(KIMI_BASE_URLS.global, 'rate_limited')).toBeNull()
    expect(failureHint(DEEPSEEK_BASE_URL, 'invalid_key')).toBeNull()
    expect(failureHint(null, 'invalid_key')).toBeNull()
  })
})
