// ============================================================
// /api/sembang/channels/[id]/messages
//
//   GET  — most recent 50 (default) non-deleted messages before an
//          optional `?before=<ISO timestamp>` cursor, each hydrated with
//          its author's profile and attachments (join `profiles` /
//          `sembang_attachments` manually — no FK from these tables to
//          `profiles` for PostgREST to embed, same reasoning as
//          `/api/account/teams`). Returned ascending by `created_at`
//          (oldest first) so the client can just append. Attachments
//          resolve a short-lived signed URL server-side since the
//          `sembang-files` bucket is private.
//   POST — post a message (requires actual channel membership — RLS
//          enforces it, a 42501 here means "not a member yet"). Inserts
//          any attachment rows against the new message id, then returns
//          it hydrated the same shape as GET.
//
// Both return SembangMessage (camelCase, nested `author`/`attachments` —
// see @/types, the frontend's own type for this exact shape).
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangAttachment, SembangMessage } from '@/types'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const BODY_MAX = 8000
/** Matches `SEMBANG_SIGNED_URL_TTL_SECONDS` in `@/lib/storage/upload-sembang-file`
 *  (kept as a plain literal here rather than imported — that module pulls
 *  in the browser Supabase client and must stay client-only). */
const SIGNED_URL_TTL_SECONDS = 60 * 60

interface MessageRow {
  id: string
  channel_id: string
  account_id: string
  author_id: string
  body: string
  mentions: string[] | null
  deleted_at: string | null
  deleted_by: string | null
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

async function hydrateMessages(
  supabase: SupabaseClient,
  rows: MessageRow[],
): Promise<SembangMessage[]> {
  if (rows.length === 0) return []

  const authorIds = Array.from(new Set(rows.map((r) => r.author_id)))
  const messageIds = rows.map((r) => r.id)

  const [{ data: profileRows }, { data: attachmentRows }] = await Promise.all([
    supabase.from('profiles').select('user_id, full_name, avatar_url').in('user_id', authorIds),
    supabase.from('sembang_attachments').select('*').in('message_id', messageIds),
  ])

  const profileByUser = new Map<string, { full_name: string | null; avatar_url: string | null }>()
  for (const p of profileRows ?? []) profileByUser.set(p.user_id, p)

  const attachmentsByMessage = new Map<string, SembangAttachment[]>()
  const pathById = new Map<string, string>()
  for (const a of (attachmentRows ?? []) as AttachmentRow[]) {
    pathById.set(a.id, a.storage_path)
    const attachment: SembangAttachment = {
      id: a.id,
      messageId: a.message_id,
      filename: a.filename,
      sizeBytes: a.size_bytes,
      mimeType: a.mime_type,
      // Resolved below, in parallel, then patched back in.
      url: '',
      createdAt: a.created_at,
    }
    const list = attachmentsByMessage.get(a.message_id) ?? []
    list.push(attachment)
    attachmentsByMessage.set(a.message_id, list)
  }

  // Resolve a signed URL per attachment, in parallel. A failed signed-URL
  // fetch (object went missing, etc.) does not fail the whole request —
  // the attachment just renders with an empty url.
  const allAttachments = Array.from(attachmentsByMessage.values()).flat()
  await Promise.all(
    allAttachments.map(async (a) => {
      const path = pathById.get(a.id)
      if (!path) return
      const { data, error } = await supabase.storage
        .from('sembang-files')
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
      if (error) {
        console.error('[hydrateMessages] createSignedUrl error:', error)
        return
      }
      a.url = data?.signedUrl ?? ''
    }),
  )

  return rows.map((row) => {
    const profile = profileByUser.get(row.author_id)
    return {
      id: row.id,
      channelId: row.channel_id,
      accountId: row.account_id,
      authorId: row.author_id,
      body: row.body,
      mentions: row.mentions ?? [],
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      createdAt: row.created_at,
      author: profile
        ? { id: row.author_id, fullName: profile.full_name ?? '', avatarUrl: profile.avatar_url }
        : null,
      attachments: attachmentsByMessage.get(row.id) ?? [],
    }
  })
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const url = new URL(request.url)
    const before = url.searchParams.get('before')
    const limitParam = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.trunc(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT

    let query = ctx.supabase
      .from('sembang_messages')
      .select('*')
      .eq('channel_id', channelId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (before) {
      const beforeDate = new Date(before)
      if (Number.isNaN(beforeDate.getTime())) {
        return NextResponse.json({ error: 'before must be a valid ISO timestamp' }, { status: 400 })
      }
      query = query.lt('created_at', beforeDate.toISOString())
    }

    const { data, error } = await query
    if (error) {
      console.error('[GET /api/sembang/channels/[id]/messages] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 })
    }

    // Descending from the DB (most recent first, for the LIMIT/cursor to
    // mean anything) — flip to ascending (oldest first) for the client.
    const rows = ((data ?? []) as MessageRow[]).slice().reverse()
    const messages = await hydrateMessages(ctx.supabase, rows)

    return NextResponse.json({ messages })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const payload = (await request.json().catch(() => null)) as {
      body?: unknown
      mentions?: unknown
      attachments?: unknown
    } | null

    const messageBody = typeof payload?.body === 'string' ? payload.body.trim() : ''
    if (!messageBody || messageBody.length > BODY_MAX) {
      return NextResponse.json(
        { error: `Message must be between 1 and ${BODY_MAX} characters` },
        { status: 400 },
      )
    }

    const mentions = Array.isArray(payload?.mentions)
      ? Array.from(new Set(payload.mentions.filter((v): v is string => typeof v === 'string')))
      : []

    const attachmentInputs = Array.isArray(payload?.attachments)
      ? payload.attachments.filter(
          (a): a is { storagePath: string; filename: string; sizeBytes: number; mimeType?: string } =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as Record<string, unknown>).storagePath === 'string' &&
            typeof (a as Record<string, unknown>).filename === 'string' &&
            typeof (a as Record<string, unknown>).sizeBytes === 'number',
        )
      : []

    const { data: row, error } = await ctx.supabase
      .from('sembang_messages')
      .insert({
        channel_id: channelId,
        account_id: ctx.accountId,
        author_id: ctx.userId,
        body: messageBody,
        mentions,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You must join this channel to post messages' },
          { status: 403 },
        )
      }
      console.error('[POST /api/sembang/channels/[id]/messages] insert error:', error)
      return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
    }

    if (attachmentInputs.length > 0) {
      const { error: attachErr } = await ctx.supabase.from('sembang_attachments').insert(
        attachmentInputs.map((a) => ({
          message_id: (row as MessageRow).id,
          account_id: ctx.accountId,
          storage_path: a.storagePath,
          filename: a.filename,
          size_bytes: a.sizeBytes,
          mime_type: a.mimeType ?? null,
        })),
      )
      if (attachErr) {
        console.error('[POST /api/sembang/channels/[id]/messages] attachment insert error:', attachErr)
        return NextResponse.json(
          { error: 'Message was sent, but attachments failed to save' },
          { status: 500 },
        )
      }
    }

    const [message] = await hydrateMessages(ctx.supabase, [row as MessageRow])

    return NextResponse.json({ message }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
