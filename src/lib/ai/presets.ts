import type { AiProvider } from './types'

/**
 * Provider presets for the AI connection form. A preset is a UI concept
 * only — what is stored is `provider` plus, for OpenAI-compatible
 * services, a `base_url`. The preset is re-derived from those on load,
 * so there is nothing extra to keep in sync in the database.
 */

export type AiPresetId = 'openai' | 'anthropic' | 'kimi' | 'deepseek' | 'custom'
export type KimiRegion = 'global' | 'cn'

/** Kimi API keys are bound to the region they were created in. */
export const KIMI_BASE_URLS: Record<KimiRegion, string> = {
  global: 'https://api.moonshot.ai/v1',
  cn: 'https://api.moonshot.cn/v1',
}

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'

export const AI_PRESET_IDS: AiPresetId[] = ['kimi', 'openai', 'anthropic', 'deepseek', 'custom']

export const PRESET_KEY_PLACEHOLDER: Record<AiPresetId, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  kimi: 'sk-...',
  deepseek: 'sk-...',
  custom: 'API key',
}

export interface PresetSelection {
  preset: AiPresetId
  region: KimiRegion
  customUrl: string
}

/** Strip whitespace and trailing slashes so equal URLs compare equal. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** What a stored provider + base URL looks like in the form. */
export function selectionFromConfig(provider: AiProvider, baseUrl: string | null): PresetSelection {
  if (provider === 'openai') return { preset: 'openai', region: 'global', customUrl: '' }
  if (provider === 'anthropic') return { preset: 'anthropic', region: 'global', customUrl: '' }
  const url = normalizeBaseUrl(baseUrl ?? '')
  if (url === KIMI_BASE_URLS.global) return { preset: 'kimi', region: 'global', customUrl: '' }
  if (url === KIMI_BASE_URLS.cn) return { preset: 'kimi', region: 'cn', customUrl: '' }
  if (url === DEEPSEEK_BASE_URL) return { preset: 'deepseek', region: 'global', customUrl: '' }
  return { preset: 'custom', region: 'global', customUrl: url }
}

/** The `provider` and `base_url` to send/store for a form selection. */
export function resolveSelection(sel: PresetSelection): { provider: AiProvider; baseUrl: string | null } {
  switch (sel.preset) {
    case 'openai':
      return { provider: 'openai', baseUrl: null }
    case 'anthropic':
      return { provider: 'anthropic', baseUrl: null }
    case 'kimi':
      return { provider: 'openai_compatible', baseUrl: KIMI_BASE_URLS[sel.region] }
    case 'deepseek':
      return { provider: 'openai_compatible', baseUrl: DEEPSEEK_BASE_URL }
    case 'custom':
      return { provider: 'openai_compatible', baseUrl: normalizeBaseUrl(sel.customUrl) || null }
  }
}

/** Host part of a URL for display ("api.moonshot.ai"); the raw text if it doesn't parse. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * A short, actionable hint for a failed check, keyed to an i18n string.
 * The one worth having: a Kimi key rejected on the wrong region looks
 * exactly like a bad key.
 */
export function failureHint(baseUrl: string | null, code: string | undefined): 'kimi_region' | null {
  if (code !== 'invalid_key' || !baseUrl) return null
  const host = hostOf(baseUrl)
  return host.endsWith('moonshot.ai') || host.endsWith('moonshot.cn') ? 'kimi_region' : null
}
