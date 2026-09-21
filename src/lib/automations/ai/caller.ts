import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError, type AiConfig } from '@/lib/ai/types'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import {
  AI_CALL_TIMEOUT_MS,
  AI_REPLY_MAX_TOKENS,
  AiStepError,
  type AiCaller,
  type AiCallRequest,
  type AiCallResult,
} from './types'

// ============================================================
// The one place an AI step reaches the model.
//
//   routing   the `automation` job in Settings > AI Agents > Connections
//             (connection and per-job model override honoured)
//   privacy   an OpenAI-compatible host needs the "customer messages go to a
//             third party" notice confirmed, the same flag Setup uses
//   budget    generateReply's guard calls ensureWithinBudget (80% warning,
//             100% stop)
//   rate      the per-account AI rate limit, one bucket shared with auto-reply
//   timeout   a hard per-call timeout
//   usage     ai_usage_log, mode `automation`
// ============================================================

/** Why AI is not usable for automations right now; `ok` when it is. */
export type AiAvailability =
  | { ok: true; config: AiConfig }
  | { ok: false; code: 'ai_not_configured' | 'notice_required'; message: string }

export const NOT_CONFIGURED_MESSAGE =
  'AI is not set up, is switched off, or the Automations job is off in AI Agents > Connections. Set it up in AI Agents > Setup.'
export const NOTICE_MESSAGE =
  'Confirm that customer messages may be sent to your AI provider in AI Agents > Setup before AI steps can run.'

/**
 * Whether the account can run AI steps: a working configuration, the master
 * switch on, the `automation` job not switched off, and (for an
 * OpenAI-compatible host) the data notice confirmed.
 */
export async function checkAiAvailability(db: SupabaseClient, accountId: string): Promise<AiAvailability> {
  let config: AiConfig | null
  try {
    config = await loadAiConfig(db, accountId, { task: 'automation' })
  } catch (err) {
    console.error('[automation ai] loadAiConfig error:', err)
    return { ok: false, code: 'ai_not_configured', message: 'The stored AI key could not be decrypted. Re-enter it in AI Agents > Setup.' }
  }
  if (!config) return { ok: false, code: 'ai_not_configured', message: NOT_CONFIGURED_MESSAGE }
  if (!(await noticeConfirmed(db, accountId, config))) {
    return { ok: false, code: 'notice_required', message: NOTICE_MESSAGE }
  }
  return { ok: true, config }
}

/**
 * The privacy notice flag (`data_notice_ack_at`) is only asked for on
 * OpenAI-compatible hosts, on the connection that serves the job; OpenAI and
 * Anthropic are the account's own BYO key and never had it. Same rule as
 * Settings > AI Agents > Setup.
 */
export async function noticeConfirmed(db: SupabaseClient, accountId: string, config: AiConfig): Promise<boolean> {
  if (config.provider !== 'openai_compatible') return true
  const q = config.connectionId
    ? db.from('ai_connections').select('data_notice_ack_at').eq('id', config.connectionId).eq('account_id', accountId)
    : db.from('ai_configs').select('data_notice_ack_at').eq('account_id', accountId)
  const { data } = await q.maybeSingle()
  return !!(data as { data_notice_ack_at?: string | null } | null)?.data_notice_ack_at
}

/**
 * The real AI caller for one run. `logUsage` is on for the engine and for the
 * Test panel (a test spends real tokens, so it counts toward the budget); a
 * fake caller replaces this whole object in tests.
 */
export function createAiCaller(opts: {
  db: SupabaseClient
  accountId: string
  conversationId: string | null
  logUsage?: boolean
  /** Rate-limit bucket key; defaults to the bucket auto-reply uses. */
  rateKey?: string
}): AiCaller {
  const { db, accountId } = opts
  let cached: AiConfig | undefined

  async function getConfig(): Promise<AiConfig> {
    if (cached) return cached
    const a = await checkAiAvailability(db, accountId)
    if (!a.ok) throw new AiStepError(a.code, a.message)
    cached = a.config
    return cached
  }

  return {
    getConfig,
    async call(req: AiCallRequest): Promise<AiCallResult> {
      const config = await getConfig()

      const limit = checkRateLimit(opts.rateKey ?? `ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount)
      if (!limit.success) {
        throw new AiStepError('rate_limited', 'The account AI rate limit was reached. Try again in a minute.')
      }

      try {
        const out = await generateReply({
          config,
          systemPrompt: req.system,
          messages: req.messages,
          guard: { db, accountId },
          maxOutputTokens: req.maxOutputTokens ?? AI_REPLY_MAX_TOKENS,
          timeoutMs: AI_CALL_TIMEOUT_MS,
        })
        if (opts.logUsage !== false) {
          void logAiUsage(db, {
            accountId,
            conversationId: opts.conversationId,
            mode: 'automation',
            connectionId: config.connectionId,
            provider: config.provider,
            model: config.model,
            usage: out.usage,
          })
        }
        return {
          text: out.text,
          handoff: out.handoff,
          usage: out.usage,
          tokens: out.usage?.totalTokens ?? 0,
          model: config.model,
          provider: config.provider,
        }
      } catch (err) {
        if (err instanceof AiError) {
          if (err.code === 'budget_exceeded') throw new AiStepError('budget_exceeded', 'AI budget used up')
          if (err.code === 'timeout') throw new AiStepError('timeout', 'The AI provider took too long to respond.')
          throw new AiStepError('ai_error', err.message)
        }
        throw new AiStepError('ai_error', 'The AI request failed.')
      }
    },
  }
}
