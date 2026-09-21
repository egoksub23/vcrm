import type { SupabaseClient } from '@supabase/supabase-js'

// WhatsApp only lets a business send free-form messages within 24 hours of
// the customer's last message; after that only an approved template goes out.
// The inbox session timer applies the same rule client-side.
export const WHATSAPP_WINDOW_HOURS = 24

/** True while the customer's last WhatsApp message is less than 24 hours old. */
export function isWhatsappWindowOpen(
  lastCustomerMessageAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastCustomerMessageAt) return false
  const last = new Date(lastCustomerMessageAt).getTime()
  if (Number.isNaN(last)) return false
  return now.getTime() - last < WHATSAPP_WINDOW_HOURS * 60 * 60 * 1000
}

/** Reads the customer's last WhatsApp message time for a conversation and applies the rule. */
export async function loadWhatsappWindowOpen(
  db: SupabaseClient,
  conversationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .eq('channel_type', 'whatsapp')
    .eq('is_internal', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return isWhatsappWindowOpen((data as { created_at: string } | null)?.created_at, now)
}
