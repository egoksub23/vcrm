// ============================================================
// Shared Sembang task hydration — joins `profiles` (assignee +
// creator) onto raw `sembang_tasks` rows. Used by both the channel
// tasks list/create route and the single-task update route.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import type { SembangTask, SembangTaskStatus } from '@/types'

export interface SembangTaskRow {
  id: string
  channel_id: string
  account_id: string
  message_id: string | null
  title: string
  assignee_id: string | null
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

  const userIds = Array.from(
    new Set(rows.flatMap((r) => [r.assignee_id, r.created_by]).filter((v): v is string => !!v)),
  )

  const { data: profileRows } = await supabase
    .from('profiles')
    .select('user_id, full_name, avatar_url')
    .in('user_id', userIds)

  const profileByUser = new Map<string, { full_name: string | null; avatar_url: string | null }>()
  for (const p of profileRows ?? []) profileByUser.set(p.user_id, p)

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
    const assigneeProfile = row.assignee_id ? profileByUser.get(row.assignee_id) : undefined
    const creatorProfile = profileByUser.get(row.created_by)
    return {
      id: row.id,
      channelId: row.channel_id,
      accountId: row.account_id,
      messageId: row.message_id,
      title: row.title,
      assigneeId: row.assignee_id,
      assignee: row.assignee_id
        ? {
            id: row.assignee_id,
            fullName: assigneeProfile?.full_name ?? '',
            avatarUrl: assigneeProfile?.avatar_url ?? null,
          }
        : null,
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
