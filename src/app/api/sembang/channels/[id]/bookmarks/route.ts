// ============================================================
// /api/sembang/channels/[id]/bookmarks
//
//   GET  — `{ bookmarks: SembangBookmark[] }`, most recently added
//          first. Joins `profiles` for the adder's name.
//   POST — body `{ url: string; title?: string }`. `added_by =
//          ctx.userId`. The `sembang_bookmarks` CHECK constraint
//          (migration 104) rejects anything that isn't a plain http(s)
//          URL — mapped here to a friendly 400 rather than a raw
//          Postgres error. Returns the created bookmark, hydrated.
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangBookmark } from '@/types'

interface BookmarkRow {
  id: string
  channel_id: string
  url: string
  title: string | null
  added_by: string
  added_at: string
}

async function hydrateBookmarks(
  supabase: SupabaseClient,
  rows: BookmarkRow[],
): Promise<SembangBookmark[]> {
  if (rows.length === 0) return []
  const userIds = Array.from(new Set(rows.map((r) => r.added_by)))
  const { data: profileRows } = await supabase.from('profiles').select('user_id, full_name').in('user_id', userIds)
  const nameByUser = new Map<string, string>()
  for (const p of profileRows ?? []) nameByUser.set(p.user_id, p.full_name ?? '')
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    url: r.url,
    title: r.title,
    addedBy: r.added_by,
    addedByName: nameByUser.get(r.added_by) ?? '',
    addedAt: r.added_at,
  }))
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_bookmarks')
      .select('*')
      .eq('channel_id', channelId)
      .order('added_at', { ascending: false })

    if (error) {
      console.error('[GET /api/sembang/channels/[id]/bookmarks] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load bookmarks' }, { status: 500 })
    }

    const bookmarks = await hydrateBookmarks(ctx.supabase, (data ?? []) as BookmarkRow[])
    return NextResponse.json({ bookmarks })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const body = (await request.json().catch(() => null)) as { url?: unknown; title?: unknown } | null

    const url = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!url || !/^https?:\/\//i.test(url) || url.length > 2000) {
      return NextResponse.json({ error: 'url must be a valid http(s) link' }, { status: 400 })
    }
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : null

    const { data, error } = await ctx.supabase
      .from('sembang_bookmarks')
      .insert({
        channel_id: channelId,
        account_id: ctx.accountId,
        url,
        title,
        added_by: ctx.userId,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You must be a member of this channel to add bookmarks' },
          { status: 403 },
        )
      }
      console.error('[POST /api/sembang/channels/[id]/bookmarks] insert error:', error)
      return NextResponse.json({ error: 'Failed to add bookmark' }, { status: 500 })
    }

    const [bookmark] = await hydrateBookmarks(ctx.supabase, [data as BookmarkRow])
    return NextResponse.json({ bookmark }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
