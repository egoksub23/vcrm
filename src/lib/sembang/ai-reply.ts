// ============================================================
// Sembang AI @mention reply — triggered when a channel message
// contains "@sembang" (case-insensitive).
//
// SERVER-ONLY: imports the AI layer, the admin DB client, and
// never runs in the browser.
//
// Multi-tenancy guarantee:
//   - Every DB query includes .eq('account_id', accountId).
//   - The AI config is loaded for ctx.accountId only — never a
//     global or fallback connection from another tenant.
//   - The inserted bot message carries account_id = accountId.
// ============================================================

import { createAdminPgDb } from '@/lib/postgres/db'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import type { ChatMessage } from '@/lib/ai/types'

const SEMBANG_AI_SYSTEM_PROMPT =
  'You are Halo AI, an assistant in the Halo school management team chat. Be helpful, concise, and professional.'

const CONTEXT_MESSAGE_COUNT = 10

interface TriggerArgs {
  /** Pre-created admin DB client (or omit to create a fresh one). */
  db?: ReturnType<typeof createAdminPgDb>
  /** The tenant this channel belongs to — REQUIRED for isolation. */
  accountId: string
  channelId: string
  /** ID of the message that contains @sembang — excluded from context. */
  triggerMessageId: string
  /** Full body of the trigger message (the final user turn). */
  triggerText: string
}

/**
 * Load context, call the AI, and insert a bot reply into the channel.
 *
 * Returns silently when:
 *   - the account has no active AI config
 *   - the AI returns empty text
 *
 * Never throws — callers fire this in a background `after()` block.
 */
export async function triggerSembangAiReply({
  db: dbArg,
  accountId,
  channelId,
  triggerMessageId,
  triggerText,
}: TriggerArgs): Promise<void> {
  const db = dbArg ?? createAdminPgDb()

  // ---- 1. Load AI config for THIS account only -------------------------
  // No task routing — use the account's default connection. If the owner
  // hasn't configured AI yet, or the master switch is off, bail silently.
  const config = await loadAiConfig(db, accountId, { requireActive: true })
  if (!config) return

  // ---- 2. Fetch recent context (last N messages, oldest first) ---------
  // Multi-tenancy: filter by BOTH channel_id AND account_id.
  const { data: contextRows, error: ctxErr } = await db
    .from('sembang_messages')
    .select('id, body, sender_type')
    .eq('channel_id', channelId)
    .eq('account_id', accountId)
    .neq('id', triggerMessageId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(CONTEXT_MESSAGE_COUNT)

  if (ctxErr) {
    console.error('[sembang-ai] context fetch error:', ctxErr)
    return
  }

  // The query returns newest-first; reverse for the model (oldest first).
  const contextMessages: ChatMessage[] = ((contextRows ?? []) as {
    id: string
    body: string
    sender_type: string
  }[])
    .slice()
    .reverse()
    .map((row) => ({
      role: row.sender_type === 'bot' ? 'assistant' : 'user',
      content: row.body,
    }))

  // ---- 3. Append the trigger message as the final user turn ------------
  const messages: ChatMessage[] = [
    ...contextMessages,
    { role: 'user', content: triggerText },
  ]

  // ---- 4. Call the AI --------------------------------------------------
  const { text } = await generateReply({
    config,
    systemPrompt: SEMBANG_AI_SYSTEM_PROMPT,
    messages,
  })

  if (!text) return // empty reply — nothing to post

  // ---- 5. Insert bot message -------------------------------------------
  // account_id is always ctx.accountId (tenant isolation).
  // author_id is NULL — migration 233 made the column nullable for bots.
  // sender_type = 'bot' so the UI can render the AI badge.
  const { error: insertErr } = await db
    .from('sembang_messages')
    .insert({
      channel_id: channelId,
      account_id: accountId,
      author_id: null,
      body: text.slice(0, 8000), // honour the CHECK constraint ceiling
      mentions: [],
      sender_type: 'bot',
    })

  if (insertErr) {
    console.error('[sembang-ai] bot message insert error:', insertErr)
  }
}
