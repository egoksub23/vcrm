import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeDb } from '@/lib/comments/fake-db'
import {
  candidateRoles,
  loadCapabilityRecipients,
  selectCapabilityRecipients,
} from './capability-recipients'

const members = [
  { user_id: 'owner-1', account_role: 'owner' },
  { user_id: 'admin-1', account_role: 'admin' },
  { user_id: 'admin-2', account_role: 'admin' },
  { user_id: 'agent-1', account_role: 'agent' },
  { user_id: 'viewer-1', account_role: 'viewer' },
  { user_id: 'weird-1', account_role: 'superuser' },
]

describe('selectCapabilityRecipients', () => {
  it('defaults to exactly the owners and admins for ai.configure (the old behaviour)', () => {
    expect(selectCapabilityRecipients(members, [], 'ai.configure')).toEqual([
      'owner-1',
      'admin-1',
      'admin-2',
    ])
  })

  it('defaults to owners and admins for conversations.manage when narrowed to those roles', () => {
    expect(
      selectCapabilityRecipients(members, [], 'conversations.manage', ['owner', 'admin']),
    ).toEqual(['owner-1', 'admin-1', 'admin-2'])
  })

  it('drops a role whose capability was switched off, never the owner', () => {
    const rows = [{ role: 'admin', capability: 'ai.configure', granted: false }]
    expect(selectCapabilityRecipients(members, rows, 'ai.configure')).toEqual(['owner-1'])
  })

  it('adds a lower role that was granted the capability, unless narrowed by roles', () => {
    const rows = [{ role: 'agent', capability: 'ai.configure', granted: true }]
    expect(selectCapabilityRecipients(members, rows, 'ai.configure')).toContain('agent-1')
    expect(
      selectCapabilityRecipients(members, rows, 'ai.configure', ['owner', 'admin']),
    ).not.toContain('agent-1')
  })

  it('ignores a grant below the capability minimum role and unknown roles', () => {
    const rows = [{ role: 'viewer', capability: 'ai.configure', granted: true }]
    const out = selectCapabilityRecipients(members, rows, 'ai.configure')
    expect(out).not.toContain('viewer-1')
    expect(out).not.toContain('weird-1')
  })

  it('returns nothing for an unknown capability or no members', () => {
    expect(selectCapabilityRecipients(members, [], 'not.a.capability')).toEqual([])
    expect(selectCapabilityRecipients(null, null, 'ai.configure')).toEqual([])
  })
})

describe('candidateRoles', () => {
  it('lists the roles that could ever hold the capability', () => {
    expect(candidateRoles('ai.configure')).toEqual(['agent', 'admin', 'owner'])
    expect(candidateRoles('roles.manage')).toEqual(['admin', 'owner'])
    expect(candidateRoles('conversations.manage', ['owner', 'admin'])).toEqual(['admin', 'owner'])
  })
})

describe('loadCapabilityRecipients', () => {
  const ACCT = 'acct-1'
  const profiles = members
    .filter((m) => m.account_role !== 'superuser')
    .map((m) => ({ ...m, account_id: ACCT }))

  it('gives owners and admins when there are no overrides', async () => {
    const f = makeFakeDb({ profiles })
    expect(await loadCapabilityRecipients(f.db, ACCT, 'ai.configure')).toEqual([
      'owner-1',
      'admin-1',
      'admin-2',
    ])
  })

  it('honours an override for the account and ignores another account', async () => {
    const f = makeFakeDb({
      profiles,
      role_capabilities: [
        { account_id: ACCT, role: 'admin', capability: 'ai.configure', granted: false },
        { account_id: 'other', role: 'agent', capability: 'ai.configure', granted: true },
      ],
    })
    expect(await loadCapabilityRecipients(f.db, ACCT, 'ai.configure')).toEqual(['owner-1'])
  })

  it('falls back to the defaults when the overrides cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = makeFakeDb({ profiles })
    const failing = {
      from: (table: string) => {
        if (table !== 'role_capabilities') return f.db.from(table)
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in']) b[m] = () => b
        b.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: { code: '42P01', message: 'missing' } })
        return b
      },
    } as unknown as SupabaseClient
    expect(await loadCapabilityRecipients(failing, ACCT, 'ai.configure')).toEqual([
      'owner-1',
      'admin-1',
      'admin-2',
    ])
  })
})
