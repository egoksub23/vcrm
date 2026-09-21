import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft' | 'auto_label' | 'closing_note' | 'summary' | 'translate' | 'automation'
  /** The additional connection that served the call (null = default). */
  connectionId?: string | null
  provider: AiProvider
  model: string
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route — writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  try {
    const row = {
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      connection_id: args.connectionId ?? null,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage.promptTokens,
      completion_tokens: args.usage.completionTokens,
      total_tokens: args.usage.totalTokens,
    }
    // Prompt-cache numbers (migration 091) are subsets of prompt_tokens, kept
    // for the report only; the budget sums total_tokens, which already
    // includes every cached token. Sent only when there is something to say.
    const { cacheReadTokens, cacheWriteTokens } = args.usage
    const withCache =
      cacheReadTokens || cacheWriteTokens
        ? { ...row, cache_read_tokens: cacheReadTokens ?? 0, cache_write_tokens: cacheWriteTokens ?? 0 }
        : row
    let { error } = await db.from('ai_usage_log').insert(withCache)
    // Before 091 is applied the cache columns do not exist: log the row
    // without them rather than losing the usage (and the budget count).
    if (error && withCache !== row) {
      ;({ error } = await db.from('ai_usage_log').insert(row))
    }
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
