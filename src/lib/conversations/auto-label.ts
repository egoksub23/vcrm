import type { SupabaseClient } from '@supabase/supabase-js'

import type { AutomationContext } from '@/lib/automations/engine'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { addConversationLabelAndDispatch } from './label-events'
import {
  AI_MAX_TEXT_LENGTH,
  AI_MIN_TEXT_LENGTH,
  buildClassifierPrompt,
  classifierCandidates,
  matchAutoLabelRules,
  parseClassifierOutput,
  type AutoLabelRule,
} from './auto-label-match'

export * from './auto-label-match'

/**
 * Auto-label by category (migration 067): on every inbound customer
 * message, apply the conversation labels an admin has set rules for —
 * keyword rules first, then (opt-in, bounded) an AI pass for messages no
 * keyword caught. Labels go through the same writer agents' manual labels
 * use, so filters and the `conversation_label_added` trigger see them.
 */

interface ApplyArgs {
  db: SupabaseClient
  accountId: string
  conversationId: string
  text: string
  context?: AutomationContext
}

export interface ApplyAutoLabelsResult {
  /** Label ids newly applied (not ones the conversation already had). */
  applied: string[]
  via: 'keywords' | 'ai' | null
}

/**
 * Never throws — it runs inside inbound webhook processing, where a
 * failure here must not affect the message being handled.
 */
export async function applyAutoLabels(args: ApplyArgs): Promise<ApplyAutoLabelsResult> {
  const none: ApplyAutoLabelsResult = { applied: [], via: null }
  const { db, accountId, conversationId } = args
  const text = args.text.trim()
  if (!text) return none

  try {
    const { data, error } = await db
      .from('auto_label_rules')
      .select('id, tag_id, keywords, match_type, description, tags(name)')
      .eq('account_id', accountId)
      .eq('is_active', true)
    if (error) throw error
    const rules: AutoLabelRule[] = ((data ?? []) as unknown as (Omit<AutoLabelRule, 'tag_name'> & {
      tags: { name: string } | { name: string }[] | null
    })[]).map((r) => {
      const tag = Array.isArray(r.tags) ? r.tags[0] : r.tags
      return { ...r, tag_name: tag?.name ?? null }
    })
    if (rules.length === 0) return none

    const apply = async (tagIds: string[], via: 'keywords' | 'ai'): Promise<ApplyAutoLabelsResult> => {
      const applied: string[] = []
      for (const tagId of tagIds) {
        const res = await addConversationLabelAndDispatch({
          db,
          accountId,
          conversationId,
          tagId,
          context: args.context,
        })
        if (res.added) applied.push(tagId)
      }
      return { applied, via: applied.length > 0 ? via : null }
    }

    const keywordHits = matchAutoLabelRules(rules, text)
    if (keywordHits.length > 0) return await apply(keywordHits, 'keywords')

    // ---- AI pass: opt-in, only for messages no keyword caught, and only
    // while the conversation has no label at all (bounds spend to about
    // one classification per unlabeled conversation).
    const candidates = classifierCandidates(rules)
    if (candidates.length === 0 || text.length < AI_MIN_TEXT_LENGTH) return none

    const { data: account } = await db
      .from('accounts')
      .select('auto_label_ai_enabled')
      .eq('id', accountId)
      .maybeSingle()
    if (!account?.auto_label_ai_enabled) return none

    const { count } = await db
      .from('conversation_labels')
      .select('tag_id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
    if ((count ?? 0) > 0) return none

    const config = await loadAiConfig(db, accountId, { task: 'auto_label' })
    if (!config) return none

    const result = await generateReply({
      config,
      systemPrompt: buildClassifierPrompt(candidates),
      messages: [{ role: 'user', content: text.slice(0, AI_MAX_TEXT_LENGTH) }],
      guard: { db, accountId },
    })
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_label',
      connectionId: config.connectionId,
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    })

    const tagId = parseClassifierOutput(result.text, candidates)
    return tagId ? await apply([tagId], 'ai') : none
  } catch (err) {
    console.error('[auto-label] failed:', err)
    return none
  }
}
