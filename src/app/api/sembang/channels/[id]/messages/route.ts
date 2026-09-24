// ============================================================
// /api/sembang/channels/[id]/messages
//
//   GET  — most recent 50 (default) non-deleted, TOP-LEVEL messages
//          (`parent_message_id IS NULL` — replies only show up inside
//          their thread, via .../messages/[messageId]/replies) before an
//          optional `?before=<ISO timestamp>` cursor, each hydrated with
//          its author's profile, attachments, reactions, and (top-level
//          only) a replyCount/lastReplyAt thread summary. Returned
//          ascending by `created_at` (oldest first) so the client can
//          just append.
//
//          `?q=<text>` switches this into a search: ignores
//          `before`/pagination and returns up to 50 non-deleted messages
//          (top-level AND replies — search should find replies too)
//          whose body ILIKE-matches, most recent first, hydrated the
//          same way.
//
//          Attachments resolve a short-lived signed URL server-side
//          since the `sembang-files` bucket is private.
//   POST — post a message (requires actual channel membership — RLS
//          enforces it, a 42501 here means "not a member yet"). Accepts
//          an optional `parentMessageId` to post as a thread reply — the
//          migration 099 trigger validates it's a real top-level message
//          in the same channel and we surface a friendly 400 if it
//          isn't. Inserts any attachment rows against the new message
//          id, then returns it hydrated the same shape as GET.
//
// Both return SembangMessage (camelCase, nested `author`/`attachments`/
// `reactions` — see @/types, the frontend's own type for this exact
// shape).
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SEARCH_LIMIT = 50
const BODY_MAX = 8000

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim()

    if (q) {
      const { data, error } = await ctx.supabase
        .from('sembang_messages')
        .select('*')
        .eq('channel_id', channelId)
        .is('deleted_at', null)
        .ilike('body', `%${q}%`)
        .order('created_at', { ascending: false })
        .limit(SEARCH_LIMIT)

      if (error) {
        console.error('[GET /api/sembang/channels/[id]/messages] search error:', error)
        return NextResponse.json({ error: 'Failed to search messages' }, { status: 500 })
      }

      const messages = await hydrateMessages(ctx.supabase, (data ?? []) as SembangMessageRow[], ctx.userId)
      return NextResponse.json({ messages })
    }

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
      .is('parent_message_id', null)
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
    const rows = ((data ?? []) as SembangMessageRow[]).slice().reverse()
    const messages = await hydrateMessages(ctx.supabase, rows, ctx.userId)

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
      parentMessageId?: unknown
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

    const parentMessageId = typeof payload?.parentMessageId === 'string' ? payload.parentMessageId : null

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
        parent_message_id: parentMessageId,
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
      const msg = error.message ?? ''
      if (msg.includes('sembang_reply_parent_missing')) {
        return NextResponse.json(
          { error: 'The message you are replying to no longer exists' },
          { status: 400 },
        )
      }
      if (msg.includes('sembang_reply_parent_wrong_channel')) {
        return NextResponse.json({ error: 'That message is not in this channel' }, { status: 400 })
      }
      if (msg.includes('sembang_reply_parent_is_itself_a_reply')) {
        return NextResponse.json(
          { error: 'You can only reply to a top-level message' },
          { status: 400 },
        )
      }
      console.error('[POST /api/sembang/channels/[id]/messages] insert error:', error)
      return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
    }

    if (attachmentInputs.length > 0) {
      const { error: attachErr } = await ctx.supabase.from('sembang_attachments').insert(
        attachmentInputs.map((a) => ({
          message_id: (row as SembangMessageRow).id,
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

    const [message] = await hydrateMessages(ctx.supabase, [row as SembangMessageRow], ctx.userId)

    return NextResponse.json({ message }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
