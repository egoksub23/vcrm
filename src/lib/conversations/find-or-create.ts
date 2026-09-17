import type { SupabaseClient } from '@supabase/supabase-js'
import { isUniqueViolation } from '@/lib/contacts/dedupe'

/**
 * Find-or-create the single conversation for `(accountId, contactId)`.
 *
 * Extracted verbatim (behavior-preserving move, not a rewrite) from the
 * WhatsApp webhook route so the Messenger and Instagram webhook routes
 * can share it instead of forking the same ~50 lines a second and third
 * time. Already fully channel-agnostic — it keys only on account/contact,
 * never touches `channel_type` — because a single conversation can span
 * every channel a contact has messaged on since migration 048's merge.
 */
export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Oldest-first, one row — NOT `.single()` (which errors on both 0 and
  // ≥2 rows). Resolves to the same canonical survivor the dedup
  // migration (036) keeps, so any pre-existing duplicates converge
  // instead of compounding. See issue #363.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[findOrCreateConversation] error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // rejected the duplicate. Re-resolve the winning row instead of
    // dropping the message.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[findOrCreateConversation] error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
