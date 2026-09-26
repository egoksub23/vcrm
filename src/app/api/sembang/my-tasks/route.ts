// ============================================================
// /api/sembang/my-tasks
//
//   GET — every `sembang_tasks` row assigned to the caller, across every
//         channel/DM, open tasks first (by `created_at` ascending within
//         status — same ordering the per-channel tasks route uses), then
//         done (most recently completed first). Hydrated with `assignee`/
//         `createdByName` (`hydrateTasks`, shared with the per-channel
//         tasks routes) and channel context (name/DM participants — same
//         `loadChannelContexts` shape as `/api/sembang/mentions`,
//         `/search` and `/stars`, kept local per this codebase's
//         per-route convention rather than a shared helper).
//
//   RLS (`sembang_tasks_select`, migration 099) already requires
//   channel membership or account-admin per row, so filtering only by
//   `assignee_id = caller` here is enough — a task assigned to someone
//   who has since left its channel simply won't come back.
//
//   Mutating a task (toggle status, delete, link a ticket) reuses the
//   existing PATCH/DELETE `/api/sembang/channels/[id]/tasks/[taskId]`
//   routes — each hydrated task already carries its own `channelId`, so
//   no new mutation route is needed here.
//
// Returns `{ results: SembangMyTaskItem[] }`.
// ============================================================
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireCapability, toErrorResponse } from '@/lib/auth/account';
import { hydrateTasks, type SembangTaskRow } from '@/lib/sembang/hydrate-tasks';
import type { SembangMyTaskItem } from '@/types';

interface ChannelContextRow {
  id: string;
  name: string | null;
  is_dm: boolean;
}

/** Resolves `{id, name, isDm, dmParticipantNames}` for a batch of channel
 *  ids — identical shape to the helper in `/api/sembang/mentions`,
 *  `/search` and `/stars`. */
async function loadChannelContexts(
  supabase: SupabaseClient,
  channelIds: string[],
  callerUserId: string
): Promise<Map<string, SembangMyTaskItem['channel']>> {
  const contexts = new Map<string, SembangMyTaskItem['channel']>();
  if (channelIds.length === 0) return contexts;

  const { data: channelRows, error } = await supabase
    .from('sembang_channels')
    .select('id, name, is_dm')
    .in('id', channelIds);

  if (error) {
    console.error('[loadChannelContexts] channel fetch error:', error);
    return contexts;
  }

  const rows = (channelRows ?? []) as ChannelContextRow[];
  const dmChannelIds = rows.filter((r) => r.is_dm).map((r) => r.id);

  const namesByChannel = new Map<string, string[]>();
  if (dmChannelIds.length > 0) {
    const { data: memberRows } = await supabase
      .from('sembang_channel_members')
      .select('channel_id, user_id')
      .in('channel_id', dmChannelIds)
      .neq('user_id', callerUserId);

    const otherUserIds = Array.from(
      new Set((memberRows ?? []).map((m) => m.user_id as string))
    );
    const nameByUser = new Map<string, string>();
    if (otherUserIds.length > 0) {
      const { data: profileRows } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', otherUserIds);
      for (const p of profileRows ?? [])
        nameByUser.set(p.user_id, p.full_name ?? '');
    }

    for (const m of memberRows ?? []) {
      const list = namesByChannel.get(m.channel_id) ?? [];
      list.push(nameByUser.get(m.user_id) ?? '');
      namesByChannel.set(m.channel_id, list);
    }
  }

  for (const row of rows) {
    contexts.set(row.id, {
      id: row.id,
      name: row.name,
      isDm: row.is_dm,
      dmParticipantNames: row.is_dm ? (namesByChannel.get(row.id) ?? []) : null,
    });
  }

  return contexts;
}

export async function GET() {
  try {
    const ctx = await requireCapability('menu.sembang');

    const { data, error } = await ctx.supabase
      .from('sembang_tasks')
      .select('*')
      .eq('assignee_id', ctx.userId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[GET /api/sembang/my-tasks] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load your tasks' },
        { status: 500 }
      );
    }

    const rows = (data ?? []) as SembangTaskRow[];
    if (rows.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const open = rows.filter((r) => r.status === 'open');
    const done = rows
      .filter((r) => r.status === 'done')
      .sort((a, b) => {
        const at = a.completed_at ? new Date(a.completed_at).getTime() : 0;
        const bt = b.completed_at ? new Date(b.completed_at).getTime() : 0;
        return bt - at;
      });
    const ordered = [...open, ...done];

    const channelIds = Array.from(new Set(ordered.map((r) => r.channel_id)));

    const [tasks, channelContexts] = await Promise.all([
      hydrateTasks(ctx.supabase, ordered),
      loadChannelContexts(ctx.supabase, channelIds, ctx.userId),
    ]);

    // A task whose channel no longer resolves (shouldn't normally happen
    // — sembang_tasks.channel_id cascades on delete) is dropped rather
    // than shown with no context to act on.
    const results: SembangMyTaskItem[] = tasks
      .map((task): SembangMyTaskItem | null => {
        const channel = channelContexts.get(task.channelId);
        if (!channel) return null;
        return { task, channel };
      })
      .filter((r): r is SembangMyTaskItem => r !== null);

    return NextResponse.json({ results });
  } catch (err) {
    return toErrorResponse(err);
  }
}
