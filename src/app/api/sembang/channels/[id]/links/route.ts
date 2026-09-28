// ============================================================
// /api/sembang/channels/[id]/links
//
//   GET — `{ links: SembangLinkItem[] }`. Every http(s) URL found in the
//         channel's message bodies, most recent message first (see
//         extract-links.ts). `preview` is joined from the message's own
//         `sembang_link_previews` row (migration 107) when its unfurled
//         URL matches this link exactly — a message only ever unfurls
//         its first URL, so a second/third link in the same message has
//         no preview of its own. A message with several links in its
//         body produces several rows sharing one `messageId`.
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

    const messageIds = Array.from(new Set(withLinks.map((l) => l.messageId)))
    const { data: previewRows } = await ctx.supabase
      .from('sembang_link_previews')
      .select('message_id, url, title, description, image_url, domain')
      .in('message_id', messageIds)
    const previewByMessage = new Map((previewRows ?? []).map((p) => [p.message_id as string, p]))

    const links: SembangLinkItem[] = withLinks.map((l) => {
      const p = previewByMessage.get(l.messageId)
      const preview = p && p.url === l.url
        ? { title: p.title, description: p.description, imageUrl: p.image_url, domain: p.domain }
        : null
      return { ...l, authorName: nameByUser.get(l.authorId) ?? '', preview }
    })

    return NextResponse.json({ links })
  } catch (err) {
    return toErrorResponse(err)
  }
}
