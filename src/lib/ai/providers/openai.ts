import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: { message?: { content?: string | { type?: string; text?: string }[] | null } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Message content is a string, or (on some compatible services) a list of text parts. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('')
  }
  return ''
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl } = args
  // A base URL means an OpenAI-*compatible* service (Kimi, DeepSeek, …):
  // same endpoint shape, but the classic `max_tokens` parameter is the one
  // they all accept, and errors should name that host rather than OpenAI.
  const compatible = !!baseUrl
  const url = compatible ? `${baseUrl.replace(/\/+$/, '')}/chat/completions` : OPENAI_URL
  const providerName = compatible ? hostOfUrl(baseUrl) : 'OpenAI'

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        ...(compatible
          ? { max_tokens: MAX_OUTPUT_TOKENS }
          : { max_completion_tokens: MAX_OUTPUT_TOKENS }),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError(providerName, res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  // Reasoning models (e.g. Kimi's thinking models) return their working in a
  // separate `reasoning_content`; only the final `content` is the reply.
  const text = contentToText(data?.choices?.[0]?.message?.content)
  if (!text.trim()) {
    throw new AiError(`${providerName} returned an empty response.`, {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
