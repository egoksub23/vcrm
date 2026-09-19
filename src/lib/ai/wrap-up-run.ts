import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { generateReply } from './generate'
import { logAiUsage } from './usage'
import { AiError, type AiConfig } from './types'
import { languageName } from '@/lib/contacts/locale-options'
import type { AiTask } from './tasks'

// ============================================================
// Shared plumbing for the wrap-up jobs (closing note, summary): load the
// job's connection, turn the recent chat into one transcript, run the
// model with the budget guard, log the spend.
// ============================================================

const SUPPORTED_LOCALES = ['en', 'es', 'ko', 'pt']
const TRANSCRIPT_MESSAGES = 40

/** The UI language the note or summary should be written in. */
export function outputLanguage(locale: unknown): string {
  const code = typeof locale === 'string' && SUPPORTED_LOCALES.includes(locale) ? locale : 'en'
  return languageName(code, 'en')
}

export async function runWrapUpJob(args: {
  /** The signed-in user's client: reads run under RLS. */
  db: SupabaseClient
  /** Service-role client: usage log and the budget alert. */
  admin: SupabaseClient
  accountId: string
  conversationId: string
  task: Extract<AiTask, 'closing_note' | 'summary'>
  systemPrompt: string
  /** Extra text appended to the transcript turn (e.g. nothing). */
  configure?: (config: AiConfig) => void
}): Promise<string> {
  const { db, admin, accountId, conversationId, task } = args

  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conv) throw new AiError('Conversation not found.', { code: 'not_found', status: 404 })

  const config = await loadAiConfig(db, accountId, { task }).catch((err) => {
    console.error(`[ai/${task}] loadAiConfig error:`, err)
    throw new AiError('Stored API key could not be decrypted.', { code: 'key_decrypt_failed', status: 400 })
  })
  if (!config) {
    throw new AiError('AI is not set up, or this job is switched off in AI Agents → Connections.', {
      code: 'ai_not_configured',
      status: 400,
    })
  }

  const messages = await buildConversationContext(db, conversationId, TRANSCRIPT_MESSAGES)
  if (messages.length === 0) {
    throw new AiError('There is nothing in this conversation to work from yet.', { code: 'no_messages', status: 400 })
  }

  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.content}`)
    .join('\n')

  const { text, usage } = await generateReply({
    config,
    systemPrompt: args.systemPrompt,
    messages: [{ role: 'user', content: `Conversation:\n\n${transcript}` }],
    guard: { db: admin, accountId },
  })

  void logAiUsage(admin, {
    accountId,
    conversationId,
    mode: task,
    connectionId: config.connectionId,
    provider: config.provider,
    model: config.model,
    usage,
  })
  return text
}
