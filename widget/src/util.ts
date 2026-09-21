// ============================================================
// Pure helpers for the widget: formatting, file validation, message
// list logic (merge, day dividers, unread marker, ticks, receipts).
// No DOM, no Preact — unit-tested in util.test.ts.
// ============================================================
import type { Translate } from './i18n'
import type { Locale, LocalMessage, MediaKind, WidgetLimits, WidgetMessage } from './types'

// ---------- formatting ----------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

/** 75 -> "1:15". Non-finite / negative -> "0:00". */
export function formatDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const m = Math.floor(s / 60)
  const rest = s % 60
  return `${m}:${rest < 10 ? '0' : ''}${rest}`
}

/** Clock time for a bubble ("14:05" / "2:05 PM" depending on locale). */
export function formatTime(iso: string, locale: Locale): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d)
  } catch {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

/** Local calendar day key, "2026-09-21". */
export function dayKey(d: Date): string {
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${d.getFullYear()}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today" / "Yesterday" / weekday within the past week / full date. */
export function dayLabel(iso: string, now: Date, locale: Locale, t: Translate): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return t('today')
  if (diffDays === 1) return t('yesterday')
  try {
    if (diffDays > 1 && diffDays < 7) {
      return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d)
    }
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(d)
  } catch {
    return dayKey(d)
  }
}

// ---------- phone / email ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function isPlausibleEmail(value: string): boolean {
  const v = value.trim()
  return v.length <= 254 && EMAIL_RE.test(v)
}

/** Keep digits and a leading "+"; drop spaces, dashes, brackets. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim()
  const plus = trimmed.startsWith('+') ? '+' : ''
  return plus + trimmed.replace(/\D/g, '')
}

export function isPlausiblePhone(raw: string): boolean {
  const digits = normalizePhone(raw).replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15
}

// ---------- files ----------

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  '3gp': 'video/3gpp',
  '3gpp': 'video/3gpp',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  amr: 'audio/amr',
}

/** Lower-case the type, drop parameters ("audio/ogg; codecs=opus"), fix "image/jpg". */
export function baseMime(type: string): string {
  const base = type.split(';')[0].trim().toLowerCase()
  return base === 'image/jpg' ? 'image/jpeg' : base
}

/** Browser-reported type, or a guess from the extension when it is blank. */
export function guessMime(file: { name: string; type: string }): string {
  const t = baseMime(file.type || '')
  if (t) return t
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  return EXT_MIME[ext] ?? ''
}

export function kindForMime(mime: string): MediaKind {
  const m = baseMime(mime)
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return 'document'
}

export type FileCheck =
  | { ok: true; mime: string; kind: MediaKind }
  | { ok: false; reason: 'empty' | 'type' | 'too_large' }

export function validateFile(
  file: { name: string; type: string; size: number },
  limits: WidgetLimits,
): FileCheck {
  if (!file.size) return { ok: false, reason: 'empty' }
  const mime = guessMime(file)
  const allowed = limits.allowedMimeTypes.map(baseMime)
  if (!mime || !allowed.includes(mime)) return { ok: false, reason: 'type' }
  if (file.size > limits.maxFileBytes) return { ok: false, reason: 'too_large' }
  return { ok: true, mime, kind: kindForMime(mime) }
}

/** Value for <input accept>: the allowed types plus their extensions (helps phones' pickers). */
export function acceptAttribute(limits: WidgetLimits): string {
  // Voice notes are recorded in-widget; audio files are still allowed as attachments.
  return limits.allowedMimeTypes.map(baseMime).join(',')
}

/** "3f2a…-Report Q3.pdf" (as stored in chat-media) -> "Report Q3.pdf". */
export function fileNameFromUrl(url: string): string {
  let last = url.split('?')[0].split('#')[0].split('/').pop() ?? ''
  try {
    last = decodeURIComponent(last)
  } catch {
    /* keep raw */
  }
  return (
    last
      .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[-_]/i, '')
      .replace(/^\d{10,}[-_]/, '') || last
  )
}

// ---------- links in text ----------

export interface TextPart {
  text: string
  href?: string
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/

/** Split text into plain runs and http(s) links (trailing punctuation stays outside the link). */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    let url = match[0]
    const trailing = url.match(TRAILING_PUNCT_RE)?.[0] ?? ''
    if (trailing) url = url.slice(0, url.length - trailing.length)
    if (!url) continue
    if (start > last) parts.push({ text: text.slice(last, start) })
    parts.push({ text: url, href: url })
    last = start + url.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts.length ? parts : [{ text }]
}

// ---------- ticks & receipts ----------

export type TickState = 'pending' | 'failed' | 'sent' | 'delivered' | 'read'

/** Tick state of one of the VISITOR's own messages; null for agent/bot messages. */
export function tickState(m: LocalMessage): TickState | null {
  if (m.sender_type !== 'customer') return null
  if (m.failed) return 'failed'
  if (m.pending) return 'pending'
  switch (m.status) {
    case 'read':
      return 'read'
    case 'delivered':
      return 'delivered'
    case 'failed':
      return 'failed'
    default:
      return 'sent'
  }
}

const STATUS_RANK: Record<string, number> = { sent: 0, delivered: 1, read: 2 }

function rank(status: string | null | undefined): number {
  return status ? (STATUS_RANK[status] ?? 0) : 0
}

/** True when `next` is not a downgrade of `prev` (read > delivered > sent). */
export function isStatusUpgrade(prev: string | null | undefined, next: string | null | undefined): boolean {
  return rank(next) >= rank(prev)
}

/**
 * Ids of AGENT/BOT messages the widget still has to report as
 * `target` (delivered | read) to /api/widget/receipt. Skips anything
 * the row already says is at least that far and anything already
 * reported this session, so it never downgrades or double-reports.
 */
export function receiptTargets(
  messages: LocalMessage[],
  reported: ReadonlyMap<string, 'delivered' | 'read'>,
  target: 'delivered' | 'read',
): string[] {
  const want = rank(target)
  const ids: string[] = []
  for (const m of messages) {
    if (m.sender_type === 'customer' || m.pending || m.id.startsWith('temp-')) continue
    if (rank(m.status) >= want) continue
    if (rank(reported.get(m.id)) >= want) continue
    ids.push(m.id)
  }
  return ids
}

// ---------- merging & grouping ----------

export const TEMP_PREFIX = 'temp-'

export function isTemp(m: { id: string }): boolean {
  return m.id.startsWith(TEMP_PREFIX)
}

function time(iso: string): number {
  const n = Date.parse(iso)
  return Number.isNaN(n) ? 0 : n
}

/**
 * Merge server rows into the local list by id (server fields win, local-only
 * fields such as `localUrl` survive), sorted oldest first, with in-flight
 * optimistic messages kept at the end in the order they were typed.
 */
export function mergeMessages(existing: LocalMessage[], incoming: WidgetMessage[]): LocalMessage[] {
  const byId = new Map<string, LocalMessage>()
  for (const m of existing) byId.set(m.id, m)
  for (const row of incoming) {
    const prev = byId.get(row.id)
    if (prev && !isStatusUpgrade(prev.status, row.status)) {
      // Never let a stale row (older poll / out-of-order event) roll a tick back.
      byId.set(row.id, { ...prev, ...row, status: prev.status })
    } else {
      byId.set(row.id, { ...prev, ...row })
    }
  }
  const all = [...byId.values()]
  const settled = all.filter((m) => !isTemp(m))
  const temps = all.filter((m) => isTemp(m))
  settled.sort((a, b) => time(a.created_at) - time(b.created_at) || (a.id < b.id ? -1 : 1))
  return [...settled, ...temps]
}

export interface UnreadMarker {
  /** id of the first message the visitor has not seen. */
  firstId: string
  count: number
}

/**
 * The first agent/bot message newer than the last time the visitor had this
 * conversation open, and how many there are. `lastSeenIso` null means "never
 * recorded on this browser" — no marker (nothing to compare against).
 */
export function findUnread(messages: LocalMessage[], lastSeenIso: string | null): UnreadMarker | null {
  if (!lastSeenIso) return null
  const seen = time(lastSeenIso)
  let firstId: string | null = null
  let count = 0
  for (const m of messages) {
    if (m.sender_type === 'customer' || isTemp(m)) continue
    if (time(m.created_at) > seen) {
      if (!firstId) firstId = m.id
      count += 1
    }
  }
  return firstId ? { firstId, count } : null
}

export type ListItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'unread'; key: string; count: number }
  | { type: 'message'; key: string; message: LocalMessage }

/** Messages interleaved with day dividers and (optionally) the unread marker. */
export function groupMessages(
  messages: LocalMessage[],
  opts: { locale: Locale; now: Date; t: Translate; unread?: UnreadMarker | null },
): ListItem[] {
  const items: ListItem[] = []
  let currentDay = ''
  for (const m of messages) {
    const d = new Date(m.created_at)
    const key = Number.isNaN(d.getTime()) ? currentDay : dayKey(d)
    if (key && key !== currentDay) {
      currentDay = key
      items.push({ type: 'day', key: `day-${key}`, label: dayLabel(m.created_at, opts.now, opts.locale, opts.t) })
    }
    if (opts.unread && opts.unread.firstId === m.id) {
      items.push({ type: 'unread', key: 'unread', count: opts.unread.count })
    }
    items.push({ type: 'message', key: m.id, message: m })
  }
  return items
}

/** Keep only the columns the widget renders (Realtime payloads carry the whole row). */
export function toWidgetMessage(raw: Record<string, unknown> | null | undefined): WidgetMessage | null {
  // A row without an id or a parseable timestamp cannot be placed in the list: skip it
  // rather than let it poison the merge / grouping for every other message.
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  const created = raw.created_at
  if (typeof created !== 'string' || Number.isNaN(Date.parse(created))) return null
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    id: raw.id,
    sender_type: (str(raw.sender_type) ?? 'agent') as WidgetMessage['sender_type'],
    content_text: str(raw.content_text),
    content_type: str(raw.content_type),
    media_url: str(raw.media_url),
    status: str(raw.status),
    created_at: created,
    is_internal: typeof raw.is_internal === 'boolean' ? raw.is_internal : null,
  }
}

/** Rows from a query/Realtime batch, minus any that cannot be rendered. */
export function toWidgetMessages(rows: unknown): WidgetMessage[] {
  if (!Array.isArray(rows)) return []
  const out: WidgetMessage[] = []
  for (const r of rows) {
    const m = toWidgetMessage(r as Record<string, unknown>)
    if (m) out.push(m)
  }
  return out
}

/**
 * groupMessages that can never throw: if the day-divider / unread logic hits
 * something unexpected, the chat still shows its messages (without dividers)
 * instead of going blank.
 */
export function safeGroupMessages(
  messages: LocalMessage[],
  opts: { locale: Locale; now: Date; t: Translate; unread?: UnreadMarker | null },
): ListItem[] {
  try {
    return groupMessages(messages, opts)
  } catch {
    return messages.map((message) => ({ type: 'message' as const, key: message.id, message }))
  }
}

/**
 * Whether a conversation still needs its history fetched + live channel opened.
 * `connectedId` is only ever set once BOTH succeeded, so a failed first attempt
 * is retried by the next session response instead of being skipped (which used
 * to leave the chat empty, with no live updates and no receipts).
 */
export function needsConnect(sessionConversationId: string, connectedId: string | null): boolean {
  return sessionConversationId !== connectedId
}

/**
 * True when history came back EMPTY although this browser has shown messages in
 * this conversation before (its last-seen marker is set). That is a failed or
 * blocked read, not a new conversation, and must be surfaced.
 */
export function historyLooksMissing(rowCount: number, lastSeenIso: string | null): boolean {
  return rowCount === 0 && !!lastSeenIso
}

/**
 * Safety-net poll for messages Realtime missed. Slow while the socket is up,
 * fast while it is down; none when the panel is closed or the tab is hidden.
 */
export function pollDelayMs(state: { open: boolean; visible: boolean; live: boolean }): number | null {
  if (!state.open || !state.visible) return null
  return state.live ? 30_000 : 8_000
}
