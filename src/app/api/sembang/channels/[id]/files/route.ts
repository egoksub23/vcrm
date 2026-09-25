// ============================================================
// /api/sembang/channels/[id]/files
//
//   GET — `{ files: SembangFileItem[] }`. Every attachment ever sent in
//         the channel (across every message, not scoped to one), most
//         recently uploaded first. RLS on sembang_messages/sembang_
//         attachments already scopes this correctly — a private
//         channel's files are invisible to a non-member the same way
//         its messages are.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { resolveAttachmentUrls } from '@/lib/sembang/resolve-attachment-urls'
import type { SembangFileItem } from '@/types'

interface MessageRow {
  id: string
  author_id: string
  created_at: string
}

interface AttachmentRow {
  id: string
  message_id: string
  storage_path: string
  filename: string
  size_bytes: number
  mime_type: string | null
  created_at: string
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data: messageRows, error: msgErr } = await ctx.supabase
      .from('sembang_messages')
      .select('id, author_id, created_at')
      .eq('channel_id', channelId)
      .is('deleted_at', null)

    if (msgErr) {
      console.error('[GET /api/sembang/channels/[id]/files] message fetch error:', msgErr)
      return NextResponse.json({ error: 'Failed to load files' }, { status: 500 })
    }

    const messages = (messageRows ?? []) as MessageRow[]
    if (messages.length === 0) return NextResponse.json({ files: [] })

    const messageIds = messages.map((m) => m.id)
    const { data: attachmentRows, error: attErr } = await ctx.supabase
      .from('sembang_attachments')
      .select('*')
      .in('message_id', messageIds)
      .order('created_at', { ascending: false })

    if (attErr) {
      console.error('[GET /api/sembang/channels/[id]/files] attachment fetch error:', attErr)
      return NextResponse.json({ error: 'Failed to load files' }, { status: 500 })
    }

    const rows = (attachmentRows ?? []) as AttachmentRow[]
    if (rows.length === 0) return NextResponse.json({ files: [] })

    const messageById = new Map(messages.map((m) => [m.id, m]))
    const authorIds = Array.from(
      new Set(rows.map((r) => messageById.get(r.message_id)?.author_id).filter((v): v is string => !!v)),
    )
    const { data: profileRows } = await ctx.supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', authorIds)
    const nameByUser = new Map<string, string>()
    for (const p of profileRows ?? []) nameByUser.set(p.user_id, p.full_name ?? '')

    const pathById = new Map<string, string>()
    const files: SembangFileItem[] = rows.map((r) => {
      pathById.set(r.id, r.storage_path)
      const msg = messageById.get(r.message_id)
      return {
        id: r.id,
        messageId: r.message_id,
        filename: r.filename,
        sizeBytes: r.size_bytes,
        mimeType: r.mime_type,
        url: '',
        createdAt: r.created_at,
        authorId: msg?.author_id ?? '',
        authorName: msg ? (nameByUser.get(msg.author_id) ?? '') : '',
      }
    })

    await resolveAttachmentUrls(ctx.supabase, files, pathById)

    return NextResponse.json({ files })
  } catch (err) {
    return toErrorResponse(err)
  }
}
