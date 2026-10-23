// ============================================================
// Older messages for the Vircle Chat app (docs/vircle-chat-contract.md, section 3.5).
//
// The app scrolls up past what it holds; the gateway keeps messages for a short time only, so it asks Halo, which keeps the
// conversation for good. Two requests share one signed address (`POST /api/vircle-chat/history`):
//
//   a page    { before: { sent_at, server_id? }, limit?, not_before? }   -> up to `limit` messages strictly older than the cursor
//   a file    { file_for: <server_id> }                                  -> a fresh download address for the file of one message
//
// Both are READS: nothing is stored and no event id is remembered, so a retry just works. What may be returned is narrow on
// purpose: the person's own Vircle Chat messages (never their WhatsApp or web chat, never internal notes, never a failed or
// unsent message), no further back than the workspace's `history_days`, and a file only for a message of that same person.
// The wallet id in the request names the person; the signature proves the gateway of THIS workspace asked.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { signMediaUrl } from '@/lib/storage/sign-media'
import { createSupabaseIdentityStore } from '@/lib/widget/identity-resolve'

import { HISTORY_DAYS_DEFAULT, HISTORY_DAYS_MAX, HISTORY_DAYS_MIN } from './history-limits'

export { HISTORY_DAYS_DEFAULT, HISTORY_DAYS_MAX, HISTORY_DAYS_MIN }
export const HISTORY_LIMIT_DEFAULT = 30
export const HISTORY_LIMIT_MAX = 50
/** How long the download address of a file stays good. The gateway fetches it at once; a day is generous. */
export const HISTORY_FILE_LINK_SECONDS = 24 * 3600

const DAY_MS = 24 * 3600 * 1000
/** A message id the gateway made: letters, digits, `_` and `-`. Anything else is refused before it reaches a query. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const KINDS = ['text', 'image', 'video', 'audio', 'document'] as const
type Kind = (typeof KINDS)[number]
const SHOWN_STATUSES = ['sent', 'delivered', 'read']

// ------------------------------------------------------------
// The request
// ------------------------------------------------------------

export type HistoryRequest =
  | { kind: 'page'; walletId: string; beforeSentAt: string; beforeServerId: string | null; limit: number; notBefore: string | null }
  | { kind: 'file'; walletId: string; serverId: string }

export type ParsedHistoryRequest = { ok: true; request: HistoryRequest } | { ok: false; error: string }

const isoTime = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t < Date.UTC(2100, 0, 1) ? new Date(t).toISOString() : null
}

/** The body of a history request, after the signature has been checked. Strict: a field that is not understood is an error, not a guess. */
export function parseHistoryRequest(body: unknown): ParsedHistoryRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>
  if (b.v !== 1) return { ok: false, error: 'v must be 1' }
  if (typeof b.wallet_id !== 'string' || b.wallet_id.length < 1 || b.wallet_id.length > 100) return { ok: false, error: 'wallet_id is required' }
  const walletId = b.wallet_id

  if (b.file_for !== undefined) {
    if (typeof b.file_for !== 'string' || !SAFE_ID.test(b.file_for)) return { ok: false, error: 'file_for must be the id of a message' }
    return { ok: true, request: { kind: 'file', walletId, serverId: b.file_for } }
  }

  const before = b.before && typeof b.before === 'object' && !Array.isArray(b.before) ? (b.before as Record<string, unknown>) : null
  const beforeSentAt = isoTime(before?.sent_at)
  if (!before || !beforeSentAt) return { ok: false, error: 'before.sent_at must be a time' }
  let beforeServerId: string | null = null
  if (before.server_id !== undefined && before.server_id !== null) {
    if (typeof before.server_id !== 'string' || !SAFE_ID.test(before.server_id)) return { ok: false, error: 'before.server_id must be the id of a message' }
    beforeServerId = before.server_id
  }
  let limit = HISTORY_LIMIT_DEFAULT
  if (b.limit !== undefined && b.limit !== null) {
    if (typeof b.limit !== 'number' || !Number.isFinite(b.limit)) return { ok: false, error: 'limit must be a number' }
    limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.trunc(b.limit)))
  }
  let notBefore: string | null = null
  if (b.not_before !== undefined && b.not_before !== null) {
    notBefore = isoTime(b.not_before)
    if (!notBefore) return { ok: false, error: 'not_before must be a time' }
  }
  return { ok: true, request: { kind: 'page', walletId, beforeSentAt, beforeServerId, limit, notBefore } }
}

// ------------------------------------------------------------
// The person's Vircle Chat conversations
// ------------------------------------------------------------

/** The conversations of the contact that owns this wallet id, in this workspace. Empty when there is no such contact. */
async function conversationIdsOf(admin: SupabaseClient, accountId: string, walletId: string): Promise<string[]> {
  const contact = await createSupabaseIdentityStore(admin).findByWallet(accountId, walletId)
  if (!contact) return []
  const { data, error } = await admin.from('conversations').select('id').eq('account_id', accountId).eq('contact_id', contact.id)
  if (error) throw error
  return ((data ?? []) as { id: string }[]).map((c) => c.id)
}

interface MessageRow {
  id: string
  message_id: string
  conversation_id: string
  sender_type: string
  sender_id: string | null
  content_type: string
  content_text: string | null
  media_url: string | null
  media_type: string | null
  media_animated: boolean | null
  status: string
  reply_to_message_id: string | null
  created_at: string
}
const COLUMNS =
  'id, message_id, conversation_id, sender_type, sender_id, content_type, content_text, media_url, media_type, media_animated, status, reply_to_message_id, created_at'

/** What every history answer is drawn from: the person's own messages the app may see. */
function shownMessages(admin: SupabaseClient, conversationIds: string[]) {
  return admin
    .from('messages')
    .select(COLUMNS)
    .in('conversation_id', conversationIds)
    .eq('channel_type', 'vircle_chat')
    .eq('is_internal', false)
    .eq('pending_delete', false)
    .not('message_id', 'is', null)
    .in('status', SHOWN_STATUSES)
    .in('content_type', [...KINDS])
}

// ------------------------------------------------------------
// A page
// ------------------------------------------------------------

export interface HistoryPageAnswer {
  messages: Record<string, unknown>[]
  more: boolean
  end: 'start' | 'window' | null
}

/** The first moment after `iso` in the database's own precision: a cursor carries milliseconds, a stored time microseconds. */
const nextMillisecond = (iso: string) => new Date(Date.parse(iso) + 1).toISOString()

export async function answerHistoryPage(
  admin: SupabaseClient,
  cfg: { account_id: string; history_days?: number | null },
  req: Extract<HistoryRequest, { kind: 'page' }>,
  now: number = Date.now(),
): Promise<HistoryPageAnswer> {
  const days = Math.min(HISTORY_DAYS_MAX, Math.max(HISTORY_DAYS_MIN, cfg.history_days ?? HISTORY_DAYS_DEFAULT))
  const windowStart = now - days * DAY_MS
  const notBeforeMs = req.notBefore ? Date.parse(req.notBefore) : 0
  // The nearer of Halo's limit and the moment the app cleared its chat.
  const floorMs = Math.max(windowStart, notBeforeMs)
  const floorIsWindow = windowStart >= notBeforeMs

  const ids = await conversationIdsOf(admin, cfg.account_id, req.walletId)
  if (ids.length === 0) return { messages: [], more: false, end: 'start' }

  let q = shownMessages(admin, ids).gt('created_at', new Date(floorMs).toISOString())
  if (req.beforeServerId) {
    // Older than the cursor, and among messages in the same millisecond only those with a smaller id.
    q = q.or(`created_at.lt.${req.beforeSentAt},and(created_at.gte.${req.beforeSentAt},created_at.lt.${nextMillisecond(req.beforeSentAt)},message_id.lt.${req.beforeServerId})`)
  } else {
    q = q.lt('created_at', req.beforeSentAt)
  }
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('message_id', { ascending: false })
    .limit(req.limit + 1)
  if (error) throw error
  const found = (data ?? []) as MessageRow[]
  const more = found.length > req.limit
  const rows = found.slice(0, req.limit).reverse()

  let end: HistoryPageAnswer['end'] = null
  if (!more) {
    end = 'start'
    if (floorIsWindow) {
      // Is there anything beyond Halo's limit? Then the app is told the conversation goes further back than it may show.
      const { data: older, error: olderError } = await shownMessages(admin, ids).lte('created_at', new Date(windowStart).toISOString()).limit(1)
      if (olderError) throw olderError
      if ((older ?? []).length > 0) end = 'window'
    }
  }
  return { messages: await toMessages(admin, cfg.account_id, rows), more, end }
}

/** The rows as the contract lists them: who wrote (the agent's name), the quoted message, the file's description (never its address). */
async function toMessages(admin: SupabaseClient, accountId: string, rows: MessageRow[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return []
  const agentIds = [...new Set(rows.filter((r) => r.sender_type === 'agent' && r.sender_id).map((r) => r.sender_id as string))]
  const names = new Map<string, string>()
  if (agentIds.length > 0) {
    const { data, error } = await admin.from('profiles').select('user_id, full_name').eq('account_id', accountId).in('user_id', agentIds)
    if (error) throw error
    for (const p of (data ?? []) as { user_id: string; full_name: string | null }[]) if (p.full_name) names.set(p.user_id, p.full_name)
  }

  const quotedIds = [...new Set(rows.map((r) => r.reply_to_message_id).filter((v): v is string => !!v))]
  const quoted = new Map<string, { message_id: string | null; content_type: string; content_text: string | null; sender_type: string }>()
  if (quotedIds.length > 0) {
    const { data, error } = await admin.from('messages').select('id, message_id, content_type, content_text, sender_type').in('id', quotedIds)
    if (error) throw error
    for (const m of (data ?? []) as { id: string; message_id: string | null; content_type: string; content_text: string | null; sender_type: string }[]) quoted.set(m.id, m)
  }

  return rows.map((r) => {
    const q = r.reply_to_message_id ? quoted.get(r.reply_to_message_id) : undefined
    const kind = r.content_type as Kind
    return {
      server_id: r.message_id,
      direction: r.sender_type === 'customer' ? 'in' : 'out',
      kind,
      text: r.content_text || null,
      sent_at: new Date(r.created_at).toISOString(),
      status: r.status,
      sender: { name: r.sender_type === 'agent' && r.sender_id ? (names.get(r.sender_id) ?? null) : null },
      reply_to:
        q && q.message_id
          ? { server_id: q.message_id, kind: (KINDS as readonly string[]).includes(q.content_type) ? q.content_type : 'text', text: q.content_text ? q.content_text.slice(0, 140) : null, from: q.sender_type === 'customer' ? 'you' : 'support' }
          : null,
      // The description only. The address is asked for separately, at the moment the file is opened (`file_for`).
      media: kind !== 'text' && r.media_url ? { mime_type: r.media_type || 'application/octet-stream', file_name: null, size_bytes: null, duration_seconds: null, animated: r.media_animated === true } : null,
    }
  })
}

// ------------------------------------------------------------
// A file
// ------------------------------------------------------------

export interface HistoryFileAnswer {
  media: {
    download_url: string
    kind: Exclude<Kind, 'text'>
    mime_type: string
    file_name: string | null
    size_bytes: number | null
    duration_seconds: number | null
    animated: boolean
  }
}

/** A fresh address for the file of one message of this person, or null when there is no such message or file. */
export async function answerHistoryFile(
  admin: SupabaseClient,
  cfg: { account_id: string },
  req: Extract<HistoryRequest, { kind: 'file' }>,
): Promise<HistoryFileAnswer | null> {
  const ids = await conversationIdsOf(admin, cfg.account_id, req.walletId)
  if (ids.length === 0) return null
  const { data, error } = await shownMessages(admin, ids).eq('message_id', req.serverId).limit(1)
  if (error) throw error
  const row = ((data ?? [])[0] as MessageRow | undefined) ?? null
  if (!row || !row.media_url || row.content_type === 'text') return null
  const url = await signMediaUrl(admin, row.media_url, cfg.account_id, HISTORY_FILE_LINK_SECONDS)
  if (!url || !/^https:\/\//.test(url)) return null
  return {
    media: {
      download_url: url,
      kind: row.content_type as Exclude<Kind, 'text'>,
      mime_type: row.media_type || 'application/octet-stream',
      file_name: null,
      size_bytes: null,
      duration_seconds: null,
      animated: row.media_animated === true,
    },
  }
}
