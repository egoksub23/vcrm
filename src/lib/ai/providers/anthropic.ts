import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  joinSystemPrompt,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: { type?: string; text?: string }[]
  usage?: {
    /** With caching on, only the tokens AFTER the last cache breakpoint. */
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  }
}

/**
 * Minimum cacheable prefix length, in tokens, per model family. Source:
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * ("Cache limitations", checked 2026-09-21). A shorter prefix is processed
 * without caching and without an error, so this only avoids pointless
 * `cache_control` markers (and the 1.25x write price on a prefix that can
 * never be read back). An unrecognised model gets the highest minimum
 * (4096): better to skip caching than to guess low.
 */
export function anthropicCacheMinTokens(model: string): number {
  const m = model.toLowerCase()
  if (/mythos.*preview/.test(m)) return 2048
  if (/(fable|mythos)-5/.test(m) || /opus-5/.test(m)) return 512
  if (/haiku-4[-.]5/.test(m)) return 4096
  if (/3[-.]5-haiku|haiku-3[-.]5|3-haiku|haiku-3/.test(m)) return 2048
  const opus4 = m.match(/opus-4[-.](\d{1,2})(?!\d)/)
  if (opus4) {
    const minor = Number(opus4[1])
    if (minor === 5 || minor === 6) return 4096
    if (minor === 7) return 2048
    return 1024 // 4.1, 4.8
  }
  if (/opus-4/.test(m)) return 1024 // claude-opus-4-YYYYMMDD
  if (/sonnet-(5|4)/.test(m)) return 1024 // sonnet 5, 4.6, 4.5, 4
  return 4096
}

/** Rough token estimate (about 4 characters per token for Latin text; it
 *  under-counts CJK, which only means we skip caching a borderline prefix). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Build the `system` field. Stable prefix first (workspace scaffold, business
 * context and rules), then the per-question part (retrieved knowledge
 * excerpts). When the stable prefix is long enough to be cacheable it becomes
 * its own block carrying a 5-minute `cache_control` marker, so a follow-up
 * call within 5 minutes with the same prefix reads it at 0.1x the input
 * price; the variable part follows unmarked. Otherwise the prompt is sent as
 * the plain string it always was. Either way the model reads the same text.
 */
export function buildAnthropicSystem(
  model: string,
  stable: string,
  tail?: string | null,
):
  | string
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] {
  const hasTail = !!tail && tail.trim() !== ''
  if (estimateTokens(stable) < anthropicCacheMinTokens(model)) {
    return hasTail ? `${stable}\n\n${tail}` : stable
  }
  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    ...(hasTail ? [{ type: 'text' as const, text: tail as string }] : []),
  ]
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, systemPromptTail, messages, timeoutMs } = args
  const maxOutputTokens = args.maxOutputTokens ?? MAX_OUTPUT_TOKENS

  const send = async (cache: boolean): Promise<Response> => {
    try {
      return await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          system: cache
            ? buildAnthropicSystem(model, systemPrompt, systemPromptTail)
            : joinSystemPrompt(systemPrompt, systemPromptTail),
          max_tokens: maxOutputTokens,
          messages: normalizeForAnthropic(messages),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
  }

  let res = await send(true)

  // Caching is an optimisation, never a requirement: if the API (or a proxy
  // in front of it) rejects the cache marker, resend the plain prompt.
  if (!res.ok && res.status === 400 && typeof res.clone === 'function') {
    const detail = await res.clone().text().catch(() => '')
    if (/cache_control/i.test(detail)) res = await send(false)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  // With prompt caching, `input_tokens` covers only what follows the cache
  // breakpoint; cache reads and writes are reported separately. Every input
  // token still counts toward the monthly budget (prompt = all three), so
  // the budget stays conservative and behaves as it did before caching.
  const cacheRead = num(data?.usage?.cache_read_input_tokens)
  const cacheWrite = num(data?.usage?.cache_creation_input_tokens)
  const usage = normalizeUsage({
    prompt: num(data?.usage?.input_tokens) + cacheRead + cacheWrite,
    completion: data?.usage?.output_tokens,
    cacheRead,
    cacheWrite,
  })
  return { text, usage }
}
