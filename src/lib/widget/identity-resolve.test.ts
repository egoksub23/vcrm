import { describe, expect, it } from 'vitest'

import {
  decideMatch,
  escapeLikeExact,
  maxLevel,
  resolveIdentityContact,
  type IdentityStore,
  type StoreContact,
} from './identity-resolve'
import { strongestIdentity } from './identity-summary'

describe('decideMatch (0 / 1 / 2 matches x verified / unverified)', () => {
  it.each([true, false])('no match creates a contact (verified=%s)', (verified) => {
    expect(decideMatch(null, null, verified)).toEqual({ kind: 'create' })
  })

  it.each([true, false])('a phone match alone uses it (verified=%s)', (verified) => {
    expect(decideMatch('A', null, verified)).toEqual({ kind: 'use', contactId: 'A' })
  })

  it.each([true, false])('an email match alone uses it (verified=%s)', (verified) => {
    expect(decideMatch(null, 'B', verified)).toEqual({ kind: 'use', contactId: 'B' })
  })

  it.each([true, false])('phone and email on the SAME contact uses it (verified=%s)', (verified) => {
    expect(decideMatch('A', 'A', verified)).toEqual({ kind: 'use', contactId: 'A' })
  })

  it('two different contacts + VERIFIED merges the email one into the phone one', () => {
    expect(decideMatch('A', 'B', true)).toEqual({ kind: 'merge', primaryId: 'A', secondaryId: 'B' })
  })

  it('two different contacts + UNVERIFIED never merges: uses the phone one and suggests', () => {
    expect(decideMatch('A', 'B', false)).toEqual({ kind: 'suggest', useId: 'A', otherId: 'B' })
  })
})

function fakeStore(seed: { byPhone?: StoreContact; byEmail?: StoreContact; byWallet?: StoreContact; mergeOk?: boolean }) {
  const calls = {
    created: [] as unknown[],
    backfills: [] as { id: string; patch: unknown }[],
    merges: [] as [string, string][],
    suggestions: [] as [string, string][],
  }
  const store: IdentityStore = {
    findByPhone: async () => seed.byPhone ?? null,
    findByEmail: async () => seed.byEmail ?? null,
    findByWallet: async () => seed.byWallet ?? null,
    createContact: async (_a, _o, input) => {
      calls.created.push(input)
      return { id: 'NEW', created: true }
    },
    backfill: async (c, patch) => {
      calls.backfills.push({ id: c.id, patch })
    },
    mergeContacts: async (_a, p, s) => {
      calls.merges.push([p, s])
      return seed.mergeOk !== false
    },
    recordSuggestion: async (_a, x, y) => {
      calls.suggestions.push([x, y])
    },
  }
  return { store, calls }
}

const A: StoreContact = { id: 'A', name: null, phone: '60111', email: null, wallet_id: null }
const B: StoreContact = { id: 'B', name: 'Bee', phone: '', email: 'b@example.com', wallet_id: null }
const args = (verified: boolean, identity = { phone: '60111', email: 'b@example.com', name: 'Typed Name', walletId: 'w1' }) => ({
  accountId: 'acct',
  ownerUserId: 'owner',
  identity,
  verified,
})

describe('resolveIdentityContact', () => {
  it('creates a contact when nothing matches, reporting claimFound=false', async () => {
    const { store, calls } = fakeStore({})
    const r = await resolveIdentityContact(store, args(false))
    expect(r).toMatchObject({ contactId: 'NEW', created: true, matched: false, merged: false, suggested: false })
    expect(calls.created).toHaveLength(1)
  })

  it('uses the single match and reports matched', async () => {
    const { store, calls } = fakeStore({ byPhone: A })
    const r = await resolveIdentityContact(store, args(false))
    expect(r).toMatchObject({ contactId: 'A', created: false, matched: true, merged: false })
    expect(calls.merges).toHaveLength(0)
    expect(calls.suggestions).toHaveLength(0)
  })

  it('VERIFIED + two different contacts merges B into A and returns A', async () => {
    const { store, calls } = fakeStore({ byPhone: A, byEmail: B })
    const r = await resolveIdentityContact(store, args(true))
    expect(r).toMatchObject({ contactId: 'A', merged: true, suggested: false })
    expect(calls.merges).toEqual([['A', 'B']])
    expect(calls.suggestions).toHaveLength(0)
  })

  it('UNVERIFIED + two different contacts NEVER merges, and records a suggestion', async () => {
    const { store, calls } = fakeStore({ byPhone: A, byEmail: B })
    const r = await resolveIdentityContact(store, args(false))
    expect(r).toMatchObject({ contactId: 'A', merged: false, suggested: true })
    expect(calls.merges).toHaveLength(0)
    expect(calls.suggestions).toEqual([['A', 'B']])
  })

  it('a failed verified merge falls back to a suggestion instead of losing the duplicate', async () => {
    const { store, calls } = fakeStore({ byPhone: A, byEmail: B, mergeOk: false })
    const r = await resolveIdentityContact(store, args(true))
    expect(r).toMatchObject({ contactId: 'A', merged: false, suggested: true })
    expect(calls.suggestions).toEqual([['A', 'B']])
  })

  it('unverified backfills ONLY the name: it cannot plant an email, phone or wallet id on a real contact', async () => {
    const { store, calls } = fakeStore({ byPhone: A })
    await resolveIdentityContact(store, args(false))
    expect(calls.backfills).toEqual([{ id: 'A', patch: { name: 'Typed Name' } }])
  })

  it('verified backfills everything (empty fields only, decided by the store)', async () => {
    const { store, calls } = fakeStore({ byPhone: A })
    await resolveIdentityContact(store, args(true, { phone: '60111', email: 'b@example.com', name: 'N', walletId: 'w1' }))
    expect(calls.backfills[0].patch).toEqual({ phone: '60111', email: 'b@example.com', name: 'N', walletId: 'w1' })
  })

  it('a wallet id matches only for a VERIFIED identity with no phone/email match', async () => {
    const W: StoreContact = { id: 'W', name: 'Wally', phone: '', email: null, wallet_id: 'w1' }
    const onlyWallet = { walletId: 'w1' }
    const verified = fakeStore({ byWallet: W })
    expect(await resolveIdentityContact(verified.store, args(true, onlyWallet as never))).toMatchObject({
      contactId: 'W',
      matched: true,
    })
    const unverified = fakeStore({ byWallet: W })
    expect(await resolveIdentityContact(unverified.store, args(false, onlyWallet as never))).toMatchObject({
      contactId: 'NEW',
      created: true,
    })
  })
})

describe('helpers', () => {
  it('maxLevel never downgrades', () => {
    expect(maxLevel('guest', 'claimed')).toBe('claimed')
    expect(maxLevel('verified', 'claimed')).toBe('verified')
    expect(maxLevel('claimed', 'guest')).toBe('claimed')
  })

  it('escapeLikeExact escapes wildcards so an email matches exactly', () => {
    expect(escapeLikeExact('a_b%c@x.com')).toBe('a\\_b\\%c@x.com')
  })

  it('strongestIdentity picks verified over claimed over guest', () => {
    expect(strongestIdentity([])).toEqual({ level: null, source: null })
    expect(
      strongestIdentity([
        { identity_level: 'guest', identity_source: null },
        { identity_level: 'verified', identity_source: 'signed_app' },
        { identity_level: 'claimed', identity_source: 'typed' },
      ]),
    ).toEqual({ level: 'verified', source: 'signed_app' })
    expect(strongestIdentity([{ identity_level: 'claimed', identity_source: 'typed' }]).level).toBe('claimed')
  })
})
