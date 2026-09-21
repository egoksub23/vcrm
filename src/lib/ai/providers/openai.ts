import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  joinSystemPrompt,
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: {
    message?: { content?: string | { type?: string; text?: string }[] | null }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    /** Reasoning tokens are already part of completion_tokens (billed as output). */
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

// ------------------------------------------------------------
// Reasoning models on api.openai.com (gpt-5 family, o-series).
// They think before answering by default; the thinking is billed as output,
// adds latency and shares `max_completion_tokens` with the reply, so a short
// limit can end with an empty `content`. For short customer replies we ask for
// little or no thinking.
// ------------------------------------------------------------

export type ReasoningEffort = 'none' | 'minimal' | 'low'

/** gpt-5*, o1*, o3*, o4* (not the non-reasoning `gpt-5-chat` alias). */
export function isOpenAiReasoningModel(model: string | null | undefined): boolean {
  const m = (model ?? '').trim().toLowerCase()
  if (!m) return false
  if (/^gpt-5-chat/.test(m)) return false
  return /^(gpt-5([.-]|$)|o[134]([.-]|$))/.test(m)
}

/**
 * The starting `reasoning_effort` per model family. Values come from OpenAI's
 * model pages (developers.openai.com/api/docs/models/<model>, checked
 * 2026-09-21), "Reasoning.effort supports: ...":
 *   - gpt-5 (and mini/nano): minimal, low, medium, high  -> `minimal`
 *   - gpt-5.1 to gpt-5.4:    none (default), low, medium, high[, xhigh] -> `none`
 *   - gpt-5.5 and later, o-series, anything unrecognised -> `low` (accepted by
 *     every reasoning model documented; `none` and `minimal` are not: e.g.
 *     GPT-6 Astra answers 400 to `none`).
 * A model that rejects the value is walked down `nextReasoningEffort`.
 */
export function defaultReasoningEffort(model: string): ReasoningEffort {
  const m = model.trim().toLowerCase()
  if (/^gpt-5(-|$)/.test(m)) return 'minimal'
  const minor = m.match(/^gpt-5\.(\d+)/)
  if (minor && Number(minor[1]) >= 1 && Number(minor[1]) <= 4) return 'none'
  return 'low'
}

/** Next-safest value after a 400 naming `reasoning_effort`; null = send none. */
export function nextReasoningEffort(effort: ReasoningEffort): ReasoningEffort | null {
  return effort === 'low' ? null : 'low'
}

/** Larger `max_completion_tokens` for the one retry after a reply that was
 *  cut off by `length` before any text: 4x, capped. */
const LENGTH_RETRY_FACTOR = 4
const LENGTH_RETRY_CAP = 32_768

/** What the API taught us about a model this process lifetime: the effort to
 *  send (null = none accepted), so a rejected value is not retried every call. */
const effortMemo = new Map<string, ReasoningEffort | null>()
/** Test hook. */
export function resetReasoningEffortMemo(): void {
  effortMemo.clear()
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function addUsage(
  a: OpenAiResponse['usage'],
  b: OpenAiResponse['usage'],
): OpenAiResponse['usage'] {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    prompt_tokens: n(a?.prompt_tokens) + n(b?.prompt_tokens),
    completion_tokens: n(a?.completion_tokens) + n(b?.completion_tokens),
    total_tokens: n(a?.total_tokens) + n(b?.total_tokens),
    completion_tokens_details: {
      reasoning_tokens:
        n(a?.completion_tokens_details?.reasoning_tokens) + n(b?.completion_tokens_details?.reasoning_tokens),
    },
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

/** Kimi (Moonshot) hosts — their models think before answering unless told not to. */
function isMoonshot(baseUrl: string | null | undefined): boolean {
  return !!baseUrl && /(^|\.)moonshot\.(ai|cn)$/.test(hostOfUrl(baseUrl).split(':')[0])
}

/** Moonshot counts thinking tokens against `max_tokens`, so a reasoning model needs far more room than a reply does. */
const MOONSHOT_THINKING_MAX_TOKENS = 4096

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 *
 * Kimi note: its models "think" by default, which can take 20–60 seconds
 * and spends the token budget on reasoning. A customer reply doesn't need
 * that, so for Moonshot hosts thinking is switched off
 * (`thinking: { type: "disabled" }`). Models that can't switch it off
 * (e.g. an always-on coding model) answer 400 naming the parameter; the
 * request is then retried once without it, with a larger token limit so
 * the reasoning doesn't eat the whole reply.
 *
 * OpenAI reasoning models (api.openai.com only, see isOpenAiReasoningModel):
 * `reasoning_effort` is sent low by default (per-family value in
 * defaultReasoningEffort). The setting is a constant, not a per-connection
 * choice. A 400 naming `reasoning_effort` walks it to the next-safest value
 * and finally drops it. An empty reply cut off by `length` (the reasoning
 * used the whole allowance) is retried once with a larger limit. No sampling
 * parameters (`temperature` etc.) are ever sent: these models reject them.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, systemPromptTail, messages, timeoutMs, baseUrl } = args
  const maxOutputTokens = args.maxOutputTokens ?? MAX_OUTPUT_TOKENS
  // A base URL means an OpenAI-*compatible* service (Kimi, DeepSeek, …):
  // same endpoint shape, but the classic `max_tokens` parameter is the one
  // they all accept, and errors should name that host rather than OpenAI.
  const compatible = !!baseUrl
  const url = compatible ? `${baseUrl.replace(/\/+$/, '')}/chat/completions` : OPENAI_URL
  const providerName = compatible ? hostOfUrl(baseUrl) : 'OpenAI'
  const moonshot = isMoonshot(baseUrl)

  const reasoning = !compatible && isOpenAiReasoningModel(model)
  let effort: ReasoningEffort | null = reasoning
    ? effortMemo.has(model)
      ? (effortMemo.get(model) ?? null)
      : defaultReasoningEffort(model)
    : null
  let completionLimit = maxOutputTokens
  const systemText = joinSystemPrompt(systemPrompt, systemPromptTail)

  const send = async (thinkingOff: boolean): Promise<Response> => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemText },
            ...mergeConsecutive(messages),
          ],
          ...(compatible
            ? { max_tokens: moonshot && !thinkingOff ? Math.max(MOONSHOT_THINKING_MAX_TOKENS, maxOutputTokens) : maxOutputTokens }
            : { max_completion_tokens: completionLimit }),
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(moonshot && thinkingOff ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
  }

  let res = await send(true)

  // The model refused the "thinking" switch: retry once, leaving it on.
  if (!res.ok && moonshot && res.status === 400 && typeof res.clone === 'function') {
    const detail = await res.clone().text().catch(() => '')
    if (/thinking/i.test(detail)) res = await send(false)
  }

  // The reasoning model refused the effort value (or the parameter): retry with
  // the next-safest value, and finally without it. At most twice.
  while (!res.ok && effort && res.status === 400 && typeof res.clone === 'function') {
    const detail = await res.clone().text().catch(() => '')
    if (!/reasoning[_.]effort/i.test(detail)) break
    effort = nextReasoningEffort(effort)
    effortMemo.set(model, effort)
    res = await send(true)
  }

  if (!res.ok) {
    throw await providerHttpError(providerName, res)
  }

  let data = (await res.json().catch(() => null)) as OpenAiResponse | null
  // Reasoning models (e.g. Kimi's thinking models) return their working in a
  // separate `reasoning_content`; only the final `content` is the reply.
  let text = contentToText(data?.choices?.[0]?.message?.content)

  // Nothing but hidden reasoning fit in the allowance: once, with more room.
  if (
    !text.trim() &&
    !compatible &&
    data?.choices?.[0]?.finish_reason === 'length' &&
    completionLimit < LENGTH_RETRY_CAP
  ) {
    completionLimit = Math.min(completionLimit * LENGTH_RETRY_FACTOR, LENGTH_RETRY_CAP)
    const retry = await send(true)
    if (!retry.ok) throw await providerHttpError(providerName, retry)
    const retryData = (await retry.json().catch(() => null)) as OpenAiResponse | null
    // Both calls were billed: fold the first call's usage into the second's.
    if (retryData) {
      retryData.usage = addUsage(data?.usage, retryData.usage)
      data = retryData
      text = contentToText(data.choices?.[0]?.message?.content)
    }
  }
  if (!text.trim()) {
    throw new AiError(`${providerName} returned an empty response.`, {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
    reasoning: data?.usage?.completion_tokens_details?.reasoning_tokens,
  })
  return { text, usage }
}
