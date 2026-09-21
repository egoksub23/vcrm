// ============================================================
// Web Widget v2 — turning an offered identity (a typed claim, a signed
// token, an enquiry form) into ONE contact.
//
// The rule that matters (owner decision 2): two REAL contacts are only
// ever merged automatically when the identity is VERIFIED (signed in-app
// token, later a confirmed code). An unverified claim that happens to
// match two different contacts (phone -> A, email -> B) attaches to A and
// leaves B alone: agents get a "Possible duplicate" suggestion and decide.
//
//   phone match | email match | verified            | unverified
//   ------------+-------------+---------------------+--------------------------
//   none        | none        | create              | create
//   A           | none        | use A               | use A
//   none        | B           | use B               | use B
//   A           | A           | use A               | use A
//   A           | B (!= A)    | merge B into A, A   | use A + suggest (A, B)
//
// The decision is a pure function (`decideMatch`); `resolveIdentityContact`
// runs it against an `IdentityStore` (Supabase in production, a fake in
// tests).
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

export type IdentityLevel = 'guest' | 'claimed' | 'verified'
export type IdentitySource = 'typed' | 'signed_app' | 'code'

export const IDENTITY_LEVEL_RANK: Record<IdentityLevel, number> = { guest: 0, claimed: 1, verified: 2 }

/** The higher of two levels; a level is never downgraded. */
export function maxLevel(a: IdentityLevel, b: IdentityLevel): IdentityLevel {
  return IDENTITY_LEVEL_RANK[a] >= IDENTITY_LEVEL_RANK[b] ? a : b
}

export type MatchDecision =
  | { kind: 'create' }
  | { kind: 'use'; contactId: string }
  | { kind: 'merge'; primaryId: string; secondaryId: string }
  | { kind: 'suggest'; useId: string; otherId: string }

export function decideMatch(
  phoneMatchId: string | null,
  emailMatchId: string | null,
  verified: boolean,
): MatchDecision {
  if (!phoneMatchId && !emailMatchId) return { kind: 'create' }
  if (phoneMatchId && (!emailMatchId || emailMatchId === phoneMatchId)) return { kind: 'use', contactId: phoneMatchId }
  if (!phoneMatchId && emailMatchId) return { kind: 'use', contactId: emailMatchId }
  // Both present and different.
  return verified
    ? { kind: 'merge', primaryId: phoneMatchId!, secondaryId: emailMatchId! }
    : { kind: 'suggest', useId: phoneMatchId!, otherId: emailMatchId! }
}

export interface StoreContact {
  id: string
  account_id?: string
  name?: string | null
  phone?: string | null
  email?: string | null
  wallet_id?: string | null
}

export interface IdentityInput {
  /** Digits only. */
  phone?: string | null
  /** Lower-cased. */
  email?: string | null
  walletId?: string | null
  name?: string | null
}

export interface IdentityStore {
  findByPhone(accountId: string, phone: string): Promise<StoreContact | null>
  findByEmail(accountId: string, email: string): Promise<StoreContact | null>
  findByWallet(accountId: string, walletId: string): Promise<StoreContact | null>
  createContact(
    accountId: string,
    ownerUserId: string,
    input: IdentityInput,
  ): Promise<{ id: string; created: boolean }>
  /** Fill ONLY the empty fields of an existing contact, from the given patch. */
  backfill(contact: StoreContact, patch: IdentityInput): Promise<void>
  /** Fold `secondaryId` into `primaryId`. Resolves false when the merge failed. */
  mergeContacts(accountId: string, primaryId: string, secondaryId: string): Promise<boolean>
  recordSuggestion(accountId: string, contactAId: string, contactBId: string): Promise<void>
}

export interface ResolveIdentityResult {
  contactId: string
  /** A brand-new contact row was created. */
  created: boolean
  /** An existing CRM contact matched (drives `claimFound`). */
  matched: boolean
  /** Two real contacts were merged (verified only). */
  merged: boolean
  /** A "possible duplicate" suggestion was recorded for agents. */
  suggested: boolean
}

export async function resolveIdentityContact(
  store: IdentityStore,
  args: {
    accountId: string
    ownerUserId: string
    identity: IdentityInput
    verified: boolean
  },
): Promise<ResolveIdentityResult> {
  const { accountId, ownerUserId, identity, verified } = args

  const phoneMatch = identity.phone ? await store.findByPhone(accountId, identity.phone) : null
  const emailMatch = identity.email ? await store.findByEmail(accountId, identity.email) : null
  // A signed wallet id is a strong key, but only when nothing else matched
  // and only for a verified identity.
  const walletMatch =
    verified && identity.walletId && !phoneMatch && !emailMatch
      ? await store.findByWallet(accountId, identity.walletId)
      : null

  const decision = decideMatch(phoneMatch?.id ?? walletMatch?.id ?? null, emailMatch?.id ?? null, verified)

  // Unverified: only the (cosmetic) name may be filled on an existing
  // contact. A stranger typing someone's phone must not be able to plant
  // their own email, phone or wallet id on that contact.
  const backfillPatch: IdentityInput = verified
    ? identity
    : { name: identity.name }

  if (decision.kind === 'create') {
    const { id, created } = await store.createContact(accountId, ownerUserId, identity)
    return { contactId: id, created, matched: !created, merged: false, suggested: false }
  }

  if (decision.kind === 'use') {
    const existing = [phoneMatch, emailMatch, walletMatch].find((c) => c?.id === decision.contactId)!
    await store.backfill(existing, backfillPatch)
    return { contactId: decision.contactId, created: false, matched: true, merged: false, suggested: false }
  }

  if (decision.kind === 'merge') {
    const ok = await store.mergeContacts(accountId, decision.primaryId, decision.secondaryId)
    if (ok) {
      await store.backfill(phoneMatch!, backfillPatch)
      return { contactId: decision.primaryId, created: false, matched: true, merged: true, suggested: false }
    }
    // The merge failed: never lose the visitor, and never leave two
    // duplicates unflagged. Fall back to the suggestion path.
    await store.recordSuggestion(accountId, decision.primaryId, decision.secondaryId)
    await store.backfill(phoneMatch!, backfillPatch)
    return { contactId: decision.primaryId, created: false, matched: true, merged: false, suggested: true }
  }

  // suggest
  await store.recordSuggestion(accountId, decision.useId, decision.otherId)
  await store.backfill(phoneMatch!, backfillPatch)
  return { contactId: decision.useId, created: false, matched: true, merged: false, suggested: true }
}

// ------------------------------------------------------------
// Supabase-backed store
// ------------------------------------------------------------

/** Escape LIKE/ILIKE wildcards so an email is matched exactly (case-insensitively). */
export function escapeLikeExact(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function createSupabaseIdentityStore(admin: SupabaseClient): IdentityStore {
  return {
    async findByPhone(accountId, phone) {
      return (await findExistingContact(admin, accountId, phone)) as StoreContact | null
    },

    async findByEmail(accountId, email) {
      const { data, error } = await admin
        .from('contacts')
        .select('id, account_id, name, phone, email, wallet_id')
        .eq('account_id', accountId)
        .ilike('email', escapeLikeExact(email))
        .order('created_at', { ascending: true })
        .limit(1)
      if (error) throw error
      return ((data ?? [])[0] as StoreContact | undefined) ?? null
    },

    async findByWallet(accountId, walletId) {
      const { data, error } = await admin
        .from('contacts')
        .select('id, account_id, name, phone, email, wallet_id')
        .eq('account_id', accountId)
        .eq('wallet_id', walletId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (error) throw error
      return ((data ?? [])[0] as StoreContact | undefined) ?? null
    },

    async createContact(accountId, ownerUserId, input) {
      const row = {
        account_id: accountId,
        user_id: ownerUserId,
        phone: input.phone ?? '',
        widget_visitor_id: null,
        name: input.name || 'Website visitor',
        email: input.email || null,
        wallet_id: input.walletId || null,
        lifecycle_stage: 'lead',
      }
      const { data, error } = await admin.from('contacts').insert(row).select('id').single()
      if (error || !data) {
        // A racing request created the same phone first: use that one.
        if (isUniqueViolation(error) && input.phone) {
          const raced = await findExistingContact(admin, accountId, input.phone)
          if (raced) return { id: raced.id, created: false }
        }
        throw error ?? new Error('Failed to create contact')
      }
      return { id: data.id as string, created: true }
    },

    async backfill(contact, patch) {
      const update: Record<string, unknown> = {}
      if (patch.name && !contact.name) update.name = patch.name
      if (patch.email && !contact.email) update.email = patch.email
      if (patch.walletId && !contact.wallet_id) update.wallet_id = patch.walletId
      // A phone can only be filled when nothing else in the account owns it
      // (the unique phone index would reject it otherwise).
      if (patch.phone && !contact.phone) {
        const owner = await findExistingContact(admin, contact.account_id ?? '', patch.phone)
        if (!owner) update.phone = patch.phone
      }
      if (Object.keys(update).length === 0) return
      const { error } = await admin.from('contacts').update(update).eq('id', contact.id)
      if (error) console.error('[widget/identity] backfill failed:', error.message)
    },

    async mergeContacts(accountId, primaryId, secondaryId) {
      const { error } = await admin.rpc('merge_contacts', {
        p_account_id: accountId,
        p_primary_contact_id: primaryId,
        p_secondary_contact_id: secondaryId,
      })
      if (error) {
        console.error('[widget/identity] merge_contacts failed:', error.message)
        return false
      }
      return true
    },

    async recordSuggestion(accountId, contactAId, contactBId) {
      const { error } = await admin.from('contact_merge_suggestions').insert({
        account_id: accountId,
        contact_a_id: contactAId,
        contact_b_id: contactBId,
        source: 'web_widget',
      })
      // The pair already exists (pending, or dismissed by an agent): leave it be.
      if (error && !isUniqueViolation(error)) {
        console.error('[widget/identity] suggestion insert failed:', error.message)
      }
    },
  }
}
