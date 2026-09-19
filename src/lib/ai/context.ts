import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * The preferred conversation language an agent set on the conversation's
 * contact (migration 069), or null. Best-effort: a lookup failure must
 * never block a draft or an auto-reply, so errors resolve to null.
 */
export async function getPreferredLanguage(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  try {
    const { data } = await db
      .from('conversations')
      .select('contact:contacts(language)')
      .eq('id', conversationId)
      .maybeSingle()
    const contact = (data as { contact?: { language?: string | null } | { language?: string | null }[] | null } | null)
      ?.contact
    const row = Array.isArray(contact) ? contact[0] : contact
    return row?.language ?? null
  } catch {
    return null
  }
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
