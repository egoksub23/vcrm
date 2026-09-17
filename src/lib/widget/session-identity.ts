// ============================================================
// Shared contact/conversation resolution for POST /api/widget/session
// (migration 054's verified-identity + self-service-linking work).
// Extracted from the route so the find-or-create-with-race-handling
// logic — the same shape resolve-conversation.ts uses for the public
// API's phone-based send — is independently testable.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { findExistingContact, isUniqueViolation, type ExistingContact } from '@/lib/contacts/dedupe';

export interface ContactUpsertOpts {
  name?: string;
  walletId?: string;
  email?: string;
}

/**
 * Find-or-create a contact by phone, backfilling name/wallet_id/email
 * on an existing contact only where it's currently empty — never
 * overwrites a value the contact already has.
 */
export async function resolveOrCreateContactByPhone(
  admin: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  phone: string,
  opts: ContactUpsertOpts,
): Promise<{ contactId: string; created: boolean }> {
  const existing = await findExistingContact(admin, accountId, phone);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (opts.name && !existing.name) patch.name = opts.name;
    if (opts.walletId && !(existing as ExistingContact).wallet_id) patch.wallet_id = opts.walletId;
    if (opts.email && !(existing as ExistingContact).email) patch.email = opts.email;
    if (Object.keys(patch).length > 0) {
      await admin.from('contacts').update(patch).eq('id', existing.id);
    }
    return { contactId: existing.id, created: false };
  }

  const { data: created, error: createErr } = await admin
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      widget_visitor_id: null,
      name: opts.name || 'Website visitor',
      wallet_id: opts.walletId || null,
      email: opts.email || null,
    })
    .select('id')
    .single();

  if (createErr || !created) {
    if (isUniqueViolation(createErr)) {
      const raced = await findExistingContact(admin, accountId, phone);
      if (!raced) throw new Error('Failed to resolve contact after race');
      return { contactId: raced.id, created: false };
    }
    throw createErr ?? new Error('Failed to create contact');
  }
  return { contactId: created.id, created: true };
}

/** Find-or-create the single (account, contact) conversation, same
 *  one-conversation-per-contact convention (migration 048) every other
 *  channel uses. */
export async function findOrCreatePrimaryConversation(
  admin: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
): Promise<string> {
  const { data: existingConv } = await admin
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (existingConv && existingConv.length > 0) return existingConv[0].id as string;

  const { data: newConv, error: convErr } = await admin
    .from('conversations')
    .insert({ account_id: accountId, user_id: ownerUserId, contact_id: contactId })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await admin
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (!raced || raced.length === 0) throw new Error('Failed to resolve conversation after race');
      return raced[0].id as string;
    }
    throw convErr ?? new Error('Failed to create conversation');
  }
  return newConv.id as string;
}
