// ============================================================
// Web Widget v2 — the few contact tags the widget applies by itself
// ("Claims existing user", "Web enquiry", "Enquiry: <role>").
//
// Runs with the service role. A tag that already exists (approved, not
// removed, matched case-insensitively) is reused; a missing one is
// created once. Tags an agent has proposed but a reviewer has not
// approved yet are never applied (migration 084), so the lookup filters
// on approval_status like every other server-side tag writer.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'

export const WIDGET_TAG_CLAIMS_EXISTING = 'Claims existing user'
export const WIDGET_TAG_ENQUIRY = 'Web enquiry'

export function enquiryRoleTag(role: string): string {
  return `Enquiry: ${role}`
}

const TAG_COLOR = '#f59e0b'

async function findTagId(db: SupabaseClient, accountId: string, name: string): Promise<string | null> {
  const { data } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('approval_status', 'approved')
    .is('deleted_at', null)
    .ilike('name', name.replace(/[\\%_]/g, (c) => `\\${c}`))
    .limit(1)
  return ((data ?? [])[0]?.id as string | undefined) ?? null
}

/** Apply a named tag to a contact, creating the tag definition if needed. Never throws. */
export async function applyContactTagByName(
  db: SupabaseClient,
  args: { accountId: string; ownerUserId: string; contactId: string; name: string },
): Promise<void> {
  try {
    let tagId = await findTagId(db, args.accountId, args.name)
    if (!tagId) {
      const { data, error } = await db
        .from('tags')
        .insert({
          account_id: args.accountId,
          user_id: args.ownerUserId,
          name: args.name,
          color: TAG_COLOR,
          for_contacts: true,
          for_conversations: false,
        })
        .select('id')
        .single()
      if (error || !data) {
        if (isUniqueViolation(error)) tagId = await findTagId(db, args.accountId, args.name)
        else throw error ?? new Error('tag insert returned nothing')
      } else {
        tagId = data.id as string
      }
    }
    if (!tagId) return
    const { error } = await db.from('contact_tags').insert({ contact_id: args.contactId, tag_id: tagId })
    if (error && !isUniqueViolation(error)) throw error
  } catch (err) {
    console.error('[widget/tags] could not apply tag', args.name, err instanceof Error ? err.message : err)
  }
}
