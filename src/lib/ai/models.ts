import { AiError, type AiProvider } from './types'
import { providerHttpError, toNetworkError } from './providers/shared'

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100'
const ANTHROPIC_VERSION = '2023-06-01'
const MODELS_TIMEOUT_MS = 15_000
const MAX_MODELS = 200

/**
 * The model ids the caller's key can use, read live from the provider so
 * the settings form never hard-codes names that change every few months.
 * Every OpenAI-compatible service we target exposes `GET {base}/models`.
 *
 * Throws `AiError`: `invalid_key` when the key is rejected (which makes
 * this a fast key check too), `network_error` / `timeout` when the host
 * can't be reached, `provider_error` for anything else — including a
 * service that simply has no models endpoint, which callers treat as
 * "no list available" rather than a failed connection.
 */
export async function listModels(args: {
  provider: AiProvider
  apiKey: string
  baseUrl: string | null
}): Promise<string[]> {
  const { provider, apiKey, baseUrl } = args
  const compatible = provider === 'openai_compatible'
  if (compatible && !baseUrl) {
    throw new AiError('A base URL is required.', { code: 'base_url_required', status: 400 })
  }

  const url =
    provider === 'anthropic'
      ? ANTHROPIC_MODELS_URL
      : compatible
        ? `${baseUrl!.replace(/\/+$/, '')}/models`
        : OPENAI_MODELS_URL
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
      : { Authorization: `Bearer ${apiKey}` }

  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError(compatible ? hostOf(baseUrl!) : provider, res)

  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null
  const ids = (body?.data ?? [])
    .map((m) => (typeof m?.id === 'string' ? m.id : ''))
    .filter(Boolean)
  return [...new Set(ids)].sort().slice(0, MAX_MODELS)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
