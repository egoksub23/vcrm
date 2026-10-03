// ============================================================
// Running a workspace deletion (migration 153).
//
//   1. begin       the database claims the workspace: suspended, channels off,
//                  a tombstone with the row counts and the logins to delete
//   2. teardown    external registrations switched off (teardown.ts)
//   3. files       every stored file of the workspace, and its members' avatars
//   4. data        delete_workspace_data(): every row, in one transaction
//   5. logins      the workspace's members and anonymous widget visitors
//   6. finish      the tombstone is closed with no personal data in it
//
// Each step is safe to run again, and progress is written to the tombstone, so a
// run that stopped half way (a deploy, a timeout) is picked up by the next one.
// The owner's 30-day request and the operator's immediate delete both end here.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import { teardownWorkspaceChannels } from './teardown'

const FILE_BATCH = 200
/** More rounds than any workspace needs; a guard against a removal that never takes effect. */
const MAX_ROUNDS = 5_000

export interface DeletionResult {
  accountId: string
  ok: boolean
  step: string
  storageRemoved: number
  error?: string
}

type ObjectRef = { bucket: string; name: string }

async function removeByPrefix(db: SupabaseClient, prefix: string): Promise<number> {
  let removed = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data, error } = await db.rpc('storage_objects_by_prefix', { p_prefix: prefix, p_limit: FILE_BATCH })
    if (error) throw new Error(`list files: ${error.message}`)
    const objects = (data ?? []) as ObjectRef[]
    if (objects.length === 0) return removed
    const byBucket = new Map<string, string[]>()
    for (const o of objects) byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.name])
    let progressed = false
    for (const [bucket, names] of byBucket) {
      const { error: rmError } = await db.storage.from(bucket).remove(names)
      if (rmError) throw new Error(`remove files from ${bucket}: ${rmError.message}`)
      removed += names.length
      progressed = true
    }
    if (!progressed) return removed
  }
  throw new Error('removing files did not finish')
}

async function deleteLogins(db: SupabaseClient, ids: string[]): Promise<void> {
  for (const id of ids) {
    const { error } = await db.auth.admin.deleteUser(id)
    // already gone is fine (a resumed run)
    if (error && !/not.?found/i.test(error.message)) throw new Error(`delete login: ${error.message}`)
  }
}

async function note(
  db: SupabaseClient,
  accountId: string,
  step: string,
  extra: { teardown?: Record<string, string>; storageRemoved?: number; error?: string } = {},
) {
  await db.rpc('workspace_deletion_note', {
    p_account: accountId,
    p_step: step,
    p_teardown: extra.teardown ?? null,
    p_storage_removed: extra.storageRemoved ?? null,
    p_error: extra.error ?? null,
  })
}

/** Delete one workspace. `force` skips the 30-day wait (the operator's "delete now"). Never throws. */
export async function runWorkspaceDeletion(
  db: SupabaseClient,
  accountId: string,
  opts: { force?: boolean } = {},
): Promise<DeletionResult> {
  let step = 'begin'
  let storageRemoved = 0
  try {
    const { data: tomb } = await db
      .from('workspace_deletions')
      .select('step, member_user_ids, visitor_user_ids, storage_objects_removed')
      .eq('account_id', accountId)
      .maybeSingle()

    let memberIds: string[] = []
    let visitorIds: string[] = []
    if (tomb) {
      memberIds = (tomb.member_user_ids ?? []) as string[]
      visitorIds = (tomb.visitor_user_ids ?? []) as string[]
      storageRemoved = Number(tomb.storage_objects_removed) || 0
    }

    const { data: stillThere } = await db.from('accounts').select('id').eq('id', accountId).maybeSingle()

    if (stillThere) {
      if (!tomb) {
        const { data, error } = await db.rpc('workspace_deletion_begin', { p_account: accountId, p_force: opts.force === true })
        if (error) throw new Error(error.message)
        const begun = data as { member_user_ids: string[]; visitor_user_ids: string[] }
        memberIds = begun.member_user_ids ?? []
        visitorIds = begun.visitor_user_ids ?? []
      }

      step = 'teardown'
      const teardown = await teardownWorkspaceChannels(db, accountId)
      await note(db, accountId, 'teardown_done', { teardown })

      step = 'files'
      storageRemoved += await removeByPrefix(db, `account-${accountId}/`)
      // a member's avatar (and older flow media) is kept under their own login id
      for (const id of memberIds) storageRemoved += await removeByPrefix(db, `${id}/`)
      await note(db, accountId, 'files_removed', { storageRemoved })

      step = 'data'
      const { error } = await db.rpc('delete_workspace_data', { p_account: accountId })
      if (error) throw new Error(error.message)
    }

    step = 'logins'
    await deleteLogins(db, [...memberIds, ...visitorIds])

    step = 'finish'
    await db.rpc('workspace_deletion_finish', { p_account: accountId })
    return { accountId, ok: true, step: 'done', storageRemoved }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error(`[workspace deletion] ${accountId} stopped at ${step}:`, message)
    await note(db, accountId, `failed_at_${step}`, { error: message }).catch(() => {})
    return { accountId, ok: false, step, storageRemoved, error: message }
  }
}

/** Run every deletion that has fallen due, or stopped half way. Returns what happened to each. */
export async function runDueDeletions(db: SupabaseClient, limit = 3): Promise<DeletionResult[]> {
  const { data, error } = await db.rpc('workspace_deletions_due', { p_limit: limit })
  if (error) {
    console.error('[workspace deletion] could not list due deletions:', error.message)
    return []
  }
  const results: DeletionResult[] = []
  for (const id of (data ?? []) as string[]) results.push(await runWorkspaceDeletion(db, id))
  return results
}
