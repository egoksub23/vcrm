// ============================================================
// /api/sembang/channels/[id]/links
//
//   GET — `{ links: SembangLinkItem[] }`. Every http(s) URL found in the
//         channel's message bodies, most recent message first. No
//         unfurl/preview generation — just the raw URL plus who posted
//         it and when (see extract-links.ts). A message with several
//         links in its body produces several rows sharing one
//         `messageId`.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { extractLinks } from '@/lib/sembang/extract-links'
import type { SembangLinkItem } from '@/types'

interface MessageRow {
  id: string
  author_id: string
  body: string
  created_at: string
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data: messageRows, error } = await ctx.supabase
      .from('sembang_messages')
      .select('id, author_id, body, created_at')
      .eq('channel_id', channelId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[GET /api/sembang/channels/[id]/links] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load links' }, { status: 500 })
    }

    const messages = (messageRows ?? []) as MessageRow[]
    const withLinks = messages.flatMap((m) =>
      extractLinks(m.body).map((url) => ({
        url,
        messageId: m.id,
        authorId: m.author_id,
        createdAt: m.created_at,
      })),
    )

    if (withLinks.length === 0) return NextResponse.json({ links: [] })

    const authorIds = Array.from(new Set(withLinks.map((l) => l.authorId)))
    const { data: profileRows } = await ctx.supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', authorIds)
    const nameByUser = new Map<string, string>()
    for (const p of profileRows ?? []) nameByUser.set(p.user_id, p.full_name ?? '')

    const links: SembangLinkItem[] = withLinks.map((l) => ({
      ...l,
      authorName: nameByUser.get(l.authorId) ?? '',
    }))

    return NextResponse.json({ links })
  } catch (err) {
    return toErrorResponse(err)
  }
}
