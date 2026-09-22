import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: string
}

// Shown in place of a non-text message that carries no caption, so the
// model sees an unbroken turn-by-turn timeline instead of a silent gap.
// A gap is exactly what let it mistake an old, still-unanswered customer
// message for part of the question that just arrived (issue: an auto-reply
// answered a stale "reset my password" alongside the real, current
// question once two media messages between them were dropped from
// context). Never invented content — just names what was sent.
const MEDIA_PLACEHOLDER: Record<string, string> = {
  image: '[Photo]',
  video: '[Video]',
  audio: '[Voice message]',
  document: '[Document]',
  location: '[Location]',
  interactive: '[Interactive message]',
  template: '[Template message]',
}

/** The text to model for one row: its own text if it has any (covers
 *  template/interactive rows that do carry rendered text), otherwise a
 *  placeholder for a known media type, otherwise null (drop the row —
 *  matches the old behaviour for an empty/whitespace-only text row). */
function describe(m: DbMessage): string | null {
  const text = m.content_text?.trim()
  if (text) return text
  return MEDIA_PLACEHOLDER[m.content_type] ?? null
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
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Every message is represented —
 * a non-text one (media, template, interactive) with no caption becomes
 * a short placeholder (see `describe`) rather than being dropped, so the
 * model can see there was a turn there at all.
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
    .select('sender_type, content_text, content_type')
    .eq('conversation_id', conversationId)
    // Internal notes (teammate comments, the "AI answered from" note) are not
    // part of the conversation with the customer.
    .eq('is_internal', false)
    // A reply that failed to send was never seen by the customer.
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .map((m) => {
      const content = describe(m)
      return content ? { role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const), content } : null
    })
    .filter((m): m is ChatMessage => m !== null)
}
