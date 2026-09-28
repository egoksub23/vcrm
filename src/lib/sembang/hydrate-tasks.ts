// ============================================================
// Shared Sembang task hydration — joins `profiles` (assignees + creator),
// `sembang_task_assignees`, and a subtask-count aggregate onto raw
// `sembang_tasks` rows. Used by the channel tasks list/create route, the
// single-task update route, and the cross-channel "My Tasks" route. Full
// subtask/comment/activity rows are NOT joined here (list-only, keeps
// this cheap) — the task detail route hydrates those itself.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import type { SembangTask, SembangTaskStatus } from '@/types'

export interface SembangTaskRow {
  id: string
  channel_id: string
  account_id: string
  message_id: string | null
  title: string
  description: string | null
  status: SembangTaskStatus
  due_at: string | null
  created_by: string
  created_at: string
  completed_at: string | null
  completed_by: string | null
  /** Migration 103. Nullable, write-once — see sembang_tasks_guard(). */
  ticket_id: string | null
}

export async function hydrateTasks(
  supabase: SupabaseClient,
  rows: SembangTaskRow[],
): Promise<SembangTask[]> {
  if (rows.length === 0) return []

  const taskIds = rows.map((r) => r.id)

  const { data: assigneeRows } = await supabase
    .from('sembang_task_assignees')
    .select('task_id, user_id')
    .in('task_id', taskIds)

  const userIds = Array.from(
    new Set([
      ...(assigneeRows ?? []).map((a) => a.user_id as string),
      ...rows.map((r) => r.created_by),
    ]),
  )

  const { data: profileRows } = await supabase
    .from('profiles')
    .select('user_id, full_name, avatar_url')
    .in('user_id', userIds)

  const profileByUser = new Map<string, { full_name: string | null; avatar_url: string | null }>()
  for (const p of profileRows ?? []) profileByUser.set(p.user_id, p)

  const assigneesByTask = new Map<string, string[]>()
  for (const a of assigneeRows ?? []) {
    const list = assigneesByTask.get(a.task_id) ?? []
    list.push(a.user_id)
    assigneesByTask.set(a.task_id, list)
  }

  const { data: subtaskRows } = await supabase
    .from('sembang_subtasks')
    .select('task_id, status')
    .in('task_id', taskIds)

  const subtaskCounts = new Map<string, { total: number; done: number }>()
  for (const s of subtaskRows ?? []) {
    const counts = subtaskCounts.get(s.task_id) ?? { total: 0, done: 0 }
    counts.total += 1
    if (s.status === 'done') counts.done += 1
    subtaskCounts.set(s.task_id, counts)
  }

  const ticketIds = Array.from(new Set(rows.map((r) => r.ticket_id).filter((v): v is string => !!v)))
  const ticketNumberById = new Map<string, number>()
  if (ticketIds.length > 0) {
    const { data: ticketRows } = await supabase
      .from('tickets')
      .select('id, ticket_number')
      .in('id', ticketIds)
    for (const t of ticketRows ?? []) ticketNumberById.set(t.id, t.ticket_number)
  }

  return rows.map((row) => {
    const creatorProfile = profileByUser.get(row.created_by)
    const counts = subtaskCounts.get(row.id) ?? { total: 0, done: 0 }
    return {
      id: row.id,
      channelId: row.channel_id,
      accountId: row.account_id,
      messageId: row.message_id,
      title: row.title,
      description: row.description,
      assignees: (assigneesByTask.get(row.id) ?? []).map((userId) => {
        const p = profileByUser.get(userId)
        return { id: userId, fullName: p?.full_name ?? '', avatarUrl: p?.avatar_url ?? null }
      }),
      subtaskCount: counts.total,
      subtaskDoneCount: counts.done,
      status: row.status,
      dueAt: row.due_at,
      createdBy: row.created_by,
      createdByName: creatorProfile?.full_name ?? '',
      createdAt: row.created_at,
      completedAt: row.completed_at,
      completedBy: row.completed_by,
      ticketId: row.ticket_id,
      ticketNumber: row.ticket_id ? (ticketNumberById.get(row.ticket_id) ?? null) : null,
    }
  })
}
