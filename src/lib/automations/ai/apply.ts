import type { SupabaseClient } from '@supabase/supabase-js'
import { logKnowledgeGap, logKnowledgeUse } from '@/lib/ai/knowledge'
import { sendSourcesAfterReply } from '@/lib/ai/auto-reply'
import { postInternalComment } from '@/lib/conversations/comment-write'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import type { AiEffect } from './types'

// ============================================================
// Applying what an AI step planned. Only the engine calls this, and never in
// a dry run: the plan (`executeAiStep`) has no write access at all.
// ============================================================

export interface ApplyContext {
  /** Service-role client. */
  db: SupabaseClient
  accountId: string
  conversationId: string | null
  contactId: string | null
  /** Label / tag writers supplied by the engine, so an AI-applied label
   *  behaves exactly like the Add label / Add tag steps (chained triggers and
   *  their depth cap included). Each returns a short detail line. */
  applyLabel: (tagId: string) => Promise<string>
  applyTag: (tagId: string) => Promise<string>
}

/**
 * Apply effects in order. Sending the reply is the point of an AI reply, so a
 * failed send throws (the engine records the step as failed). Every other
 * effect is a side benefit: a failure is reported in the returned notes and the
 * step carries on.
 */
export async function applyEffects(effects: AiEffect[], ctx: ApplyContext): Promise<string[]> {
  const notes: string[] = []
  for (const e of effects) {
    if (e.kind === 'send_reply') {
      if (!ctx.conversationId) throw new Error('cannot send: no conversation')
      await sendMessageToConversation(ctx.db, ctx.accountId, {
        conversationId: ctx.conversationId,
        messageType: 'text',
        contentText: e.text,
        // Sent by the automation (a bot), badged as AI-written like the auto-reply bot's.
        senderType: 'bot',
        aiGenerated: true,
      })
      if (e.cited.length > 0 || e.citedDocs.length > 0) {
        await sendSourcesAfterReply(ctx.db, ctx.accountId, ctx.conversationId, e.cited, e.citedDocs)
      }
      continue
    }
    try {
      switch (e.kind) {
        case 'internal_note':
          if (!ctx.conversationId) break
          await postInternalComment(ctx.db, {
            accountId: ctx.accountId,
            conversationId: ctx.conversationId,
            userId: null,
            senderType: 'bot',
            text: e.text,
            kbSources: e.kbSources,
          })
          break
        case 'log_gap':
          await logKnowledgeGap(ctx.db, ctx.accountId, e.question, ctx.conversationId)
          break
        case 'log_knowledge_use':
          await logKnowledgeUse(ctx.db, {
            accountId: ctx.accountId,
            conversationId: ctx.conversationId,
            mode: 'auto_reply',
            hits: e.hits,
          })
          break
        case 'contact_field':
          if (!ctx.contactId) break
          await ctx.db
            .from('contacts')
            .update({ [e.field]: e.value, updated_at: new Date().toISOString() })
            .eq('id', ctx.contactId)
            .eq('account_id', ctx.accountId)
          notes.push(`${e.field} saved`)
          break
        case 'custom_field':
          if (!ctx.contactId) break
          await ctx.db
            .from('contact_custom_values')
            .upsert(
              { contact_id: ctx.contactId, custom_field_id: e.customFieldId, value: e.value },
              { onConflict: 'contact_id,custom_field_id' },
            )
          notes.push('custom field saved')
          break
        case 'label':
          notes.push(await ctx.applyLabel(e.tagId))
          break
        case 'tag':
          notes.push(await ctx.applyTag(e.tagId))
          break
      }
    } catch (err) {
      console.error('[automation ai] effect failed:', e.kind, err)
      notes.push(`${e.kind} failed`)
    }
  }
  return notes
}
