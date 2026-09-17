import type { SupabaseClient } from '@supabase/supabase-js'
import { isUniqueViolation } from '@/lib/contacts/dedupe'

/**
 * Find-or-create a contact by an external channel identity — the
 * direct-column pattern (migration 040/055), not WhatsApp's
 * phone-fuzzy dedupe.
 *
 * `messenger_psid` / `instagram_igsid` are asserted server-side by
 * Meta's webhook, so an exact match is the correct (and only
 * meaningful) lookup — no trunk-variant ambiguity like a phone number
 * has. `email` (migration 056) is different: it's an ordinary, mutable
 * CRM field that predates the Email channel, not a fresh dedicated
 * column, and email addresses are conventionally case-insensitive in
 * the local part's domain and often in practice for the whole address —
 * so this matches it case-insensitively (`ilike`) rather than the exact
 * `eq` the two Meta identities use. See migration 056's header for why
 * `contacts.email` has no uniqueness constraint to lean on here.
 */
export async function findOrCreateContactByExternalId(
  db: SupabaseClient,
  args: {
    accountId: string
    configOwnerUserId: string
    /** Which identity column this channel uses. */
    column: 'messenger_psid' | 'instagram_igsid' | 'email'
    externalId: string
    /** Only invoked when actually creating a new contact — an existing
     *  contact's name is never re-fetched/overwritten on a later
     *  message, so this skips the profile-lookup API call on the (much
     *  more common) already-exists path. */
    resolveDisplayName: () => Promise<string>
  },
): Promise<{ contact: { id: string; [key: string]: unknown }; wasCreated: boolean } | null> {
  const { accountId, configOwnerUserId, column, externalId, resolveDisplayName } = args
  const caseInsensitive = column === 'email'

  const findQuery = db.from('contacts').select('*').eq('account_id', accountId)
  const { data: existing, error: findError } = await (
    caseInsensitive ? findQuery.ilike(column, externalId) : findQuery.eq(column, externalId)
  ).maybeSingle()

  if (findError) {
    console.error(`[findOrCreateContactByExternalId] lookup error (${column}):`, findError)
    return null
  }
  if (existing) return { contact: existing, wasCreated: false }

  const displayName = await resolveDisplayName()

  const { data: created, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      // Empty string, not NULL — phone stays NOT NULL account-wide, same
      // convention as a BSUID-only or widget-only contact.
      phone: '',
      name: displayName,
      [column]: externalId,
    })
    .select('*')
    .single()

  if (createError) {
    // Lost a race: a concurrent delivery created the contact between
    // our lookup and insert. Re-resolve the winning row.
    if (isUniqueViolation(createError)) {
      const racedQuery = db.from('contacts').select('*').eq('account_id', accountId)
      const { data: raced } = await (
        caseInsensitive ? racedQuery.ilike(column, externalId) : racedQuery.eq(column, externalId)
      ).maybeSingle()
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error(`[findOrCreateContactByExternalId] create error (${column}):`, createError)
    return null
  }

  return { contact: created, wasCreated: true }
}
