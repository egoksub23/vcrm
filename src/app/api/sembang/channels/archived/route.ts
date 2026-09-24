// ============================================================
// /api/sembang/channels/archived
//
//   GET — archived channels the caller can see. `sembang_channels_select`
//         (RLS) doesn't filter by `archived_at` — only the sidebar RPC
//         (`list_sembang_channels_for_current_user`) does that, to keep
//         archived channels out of the normal list — so a plain
//         `account_id`-scoped select here is already correctly
//         moderator/admin-visibility-scoped by RLS. Excludes DMs: archive
//         is a channel-only action this pass (see SPEC-P2's frontend
//         section — archiving a DM would hide it for both participants
//         off one shared column, which isn't supported here).
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

interface ArchivedChannelRow {
  id: string
  name: string | null
  is_private: boolean
  archived_at: string
}

export async function GET() {
  try {
    const ctx = await requireCapability('menu.sembang')

    const { data, error } = await ctx.supabase
      .from('sembang_channels')
      .select('id, name, is_private, archived_at')
      .eq('account_id', ctx.accountId)
      .eq('is_dm', false)
      .not('archived_at', 'is', null)
      .order('archived_at', { ascending: false })

    if (error) {
      console.error('[GET /api/sembang/channels/archived] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load archived channels' }, { status: 500 })
    }

    const channels = ((data ?? []) as ArchivedChannelRow[]).map((row) => ({
      id: row.id,
      name: row.name ?? '',
      isPrivate: row.is_private,
      archivedAt: row.archived_at,
    }))

    return NextResponse.json({ channels })
  } catch (err) {
    return toErrorResponse(err)
  }
}
