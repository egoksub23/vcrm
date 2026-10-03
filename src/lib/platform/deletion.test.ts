import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('./teardown', () => ({
  teardownWorkspaceChannels: vi.fn(async () => ({ gmail: 'ok', whatsapp: 'not connected' })),
}))

import { runDueDeletions, runWorkspaceDeletion } from './deletion'
import { teardownWorkspaceChannels } from './teardown'

const ID = 'a067c4ed-4f53-4c1c-a007-bf6f3bc4d86b'
const MEMBER = '11111111-1111-1111-1111-111111111111'
const VISITOR = '22222222-2222-2222-2222-222222222222'

interface World {
  tomb: Record<string, unknown> | null
  accountExists: boolean
  /** objects still stored, by prefix */
  files: Record<string, { bucket: string; name: string }[]>
  failRpc?: string
  failRemove?: boolean
  authErrors?: Record<string, string>
}

function setup(world: World) {
  const log: string[] = []
  const removed: string[] = []
  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'workspace_deletions'
              ? { data: world.tomb }
              : { data: world.accountExists ? { id: ID } : null },
        }),
      }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      log.push(name)
      if (world.failRpc === name) return { data: null, error: { message: `${name} failed` } }
      if (name === 'workspace_deletion_begin') {
        world.tomb = { step: 'started', member_user_ids: [MEMBER], visitor_user_ids: [VISITOR], storage_objects_removed: 0 }
        return { data: { member_user_ids: [MEMBER], visitor_user_ids: [VISITOR] }, error: null }
      }
      if (name === 'storage_objects_by_prefix') {
        const prefix = args.p_prefix as string
        return { data: world.files[prefix] ?? [], error: null }
      }
      if (name === 'delete_workspace_data') world.accountExists = false
      return { data: null, error: null }
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (names: string[]) => {
          if (world.failRemove) return { error: { message: 'storage down' } }
          for (const n of names) removed.push(`${bucket}/${n}`)
          for (const k of Object.keys(world.files)) world.files[k] = world.files[k].filter((f) => !names.includes(f.name))
          return { error: null }
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          log.push(`deleteUser:${id}`)
          return { error: world.authErrors?.[id] ? { message: world.authErrors[id] } : null }
        },
      },
    },
  } as unknown as SupabaseClient
  return { db, log, removed }
}

beforeEach(() => vi.mocked(teardownWorkspaceChannels).mockClear())

describe('runWorkspaceDeletion', () => {
  it('runs the steps in order: begin, teardown, files, data, logins, finish', async () => {
    const world: World = {
      tomb: null,
      accountExists: true,
      files: {
        [`account-${ID}/`]: [{ bucket: 'chat-media', name: `account-${ID}/a.png` }],
        [`${MEMBER}/`]: [{ bucket: 'avatars', name: `${MEMBER}/avatar.png` }],
      },
    }
    const { db, log, removed } = setup(world)
    const r = await runWorkspaceDeletion(db, ID, { force: true })
    expect(r).toMatchObject({ ok: true, step: 'done', storageRemoved: 2 })
    expect(removed).toEqual([`chat-media/account-${ID}/a.png`, `avatars/${MEMBER}/avatar.png`])
    const order = log.filter((n) => !n.startsWith('storage_objects') && n !== 'workspace_deletion_note')
    expect(order).toEqual([
      'workspace_deletion_begin',
      'delete_workspace_data',
      `deleteUser:${MEMBER}`,
      `deleteUser:${VISITOR}`,
      'workspace_deletion_finish',
    ])
    expect(teardownWorkspaceChannels).toHaveBeenCalledTimes(1)
  })

  it('does not delete the data if removing the files failed, and records where it stopped', async () => {
    const world: World = {
      tomb: null,
      accountExists: true,
      files: { [`account-${ID}/`]: [{ bucket: 'chat-media', name: `account-${ID}/a.png` }] },
      failRemove: true,
    }
    const { db, log } = setup(world)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await runWorkspaceDeletion(db, ID)
    expect(r).toMatchObject({ ok: false, step: 'files' })
    expect(r.error).toMatch(/storage down/)
    expect(log).not.toContain('delete_workspace_data')
    expect(log).not.toContain('workspace_deletion_finish')
    expect(log).toContain('workspace_deletion_note')
  })

  it('resumes after the data was deleted: only the logins and the tombstone are left to do', async () => {
    const world: World = {
      tomb: { step: 'data_deleted', member_user_ids: [MEMBER], visitor_user_ids: [VISITOR], storage_objects_removed: 7 },
      accountExists: false,
      files: {},
    }
    const { db, log } = setup(world)
    const r = await runWorkspaceDeletion(db, ID)
    expect(r).toMatchObject({ ok: true, storageRemoved: 7 })
    expect(log).toEqual([`deleteUser:${MEMBER}`, `deleteUser:${VISITOR}`, 'workspace_deletion_finish'])
    expect(teardownWorkspaceChannels).not.toHaveBeenCalled()
  })

  it('treats a login that is already gone as done, but stops on any other failure', async () => {
    const gone: World = { tomb: { step: 'data_deleted', member_user_ids: [MEMBER], visitor_user_ids: [] }, accountExists: false, files: {}, authErrors: { [MEMBER]: 'User not found' } }
    expect((await runWorkspaceDeletion(setup(gone).db, ID)).ok).toBe(true)
    const broken: World = { tomb: { step: 'data_deleted', member_user_ids: [MEMBER], visitor_user_ids: [] }, accountExists: false, files: {}, authErrors: { [MEMBER]: 'database error' } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await runWorkspaceDeletion(setup(broken).db, ID)
    expect(r).toMatchObject({ ok: false, step: 'logins' })
  })

  it('stops at begin when the database refuses (not due, or an operator works there)', async () => {
    const world: World = { tomb: null, accountExists: true, files: {}, failRpc: 'workspace_deletion_begin' }
    const { db, log } = setup(world)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await runWorkspaceDeletion(db, ID)
    expect(r).toMatchObject({ ok: false, step: 'begin' })
    expect(teardownWorkspaceChannels).not.toHaveBeenCalled()
    expect(log).not.toContain('delete_workspace_data')
  })
})

describe('runDueDeletions', () => {
  it('runs each due workspace and reports every result', async () => {
    const calls: string[] = []
    const db = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'workspace_deletions_due') return { data: [ID], error: null }
        calls.push(`${name}:${args.p_account ?? ''}`)
        return { data: null, error: null }
      },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      auth: { admin: { deleteUser: async () => ({ error: null }) } },
    } as unknown as SupabaseClient
    const results = await runDueDeletions(db)
    expect(results).toHaveLength(1)
    // the account no longer exists and there is no tombstone: nothing to take apart, the tombstone is just closed
    expect(results[0].accountId).toBe(ID)
  })

  it('returns nothing when the list cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { rpc: async () => ({ data: null, error: { message: 'down' } }) } as unknown as SupabaseClient
    expect(await runDueDeletions(db)).toEqual([])
  })
})
