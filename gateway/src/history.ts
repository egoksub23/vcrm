// ============================================================
// Older messages for the app, asked of Halo (docs/vircle-chat-contract.md, section 3.5; docs/vircle-chat-app-protocol.md, section 7).
//
// The gateway keeps delivered messages for RETENTION_DAYS only; Halo keeps the conversation for good and is the source of
// anything older. When the app scrolls past what it holds it sends a `history` frame; this service turns that into one signed
// request to Halo and the answer into a `history_page` frame. Nothing is stored here: a page is passed through.
//
//   * The request is signed like every call to Halo (signing.ts) and goes to the same address as the webhook with the last
//     path segment replaced by `history`. It is a READ: Halo does not remember the request id, so a retry just works.
//   * Halo's answer is untrusted input: every field is checked, a message that does not pass is dropped, nothing is believed
//     beyond the fields the contract lists, and a page is never longer than the limit the app asked for.
//   * A file in an older message is not fetched now. The page names it with an id that carries the user and the Halo message
//     (`h_<user id>.<server id>`) and a signed link to this gateway. The first time the link is opened the gateway asks Halo
//     for a fresh download address (`file_for`), fetches the file through the same checks as any file from Halo, keeps it
//     for a day and serves it. A file the app never opens costs nothing.
// ============================================================

import type { GatewayConfig } from './config'
import type { FileKind, FileService } from './files'
import { signedHeaders } from './signing'
import type { Store, Subject, Workspace } from './store'
import { log } from './log'

export const HISTORY_DEFAULT_LIMIT = 30
export const HISTORY_MAX_LIMIT = 50
/** One reasonable wait for Halo: a page is a handful of rows and a few lookups. */
const HALO_TIMEOUT_MS = 15_000
/** The longest a quoted text is shown. */
const QUOTE_MAX = 140

export type HistoryErrorCode = 'history_unavailable' | 'history_disabled' | 'rate_limited' | 'bad_request'

export class HistoryError extends Error {
  constructor(
    readonly code: HistoryErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'HistoryError'
  }
}

export interface HistoryQuery {
  /** Older than this message: its time, and its id when the app holds one (absent when it holds nothing). */
  beforeSentAt: string
  beforeServerId: string | null
  limit: number
  /** Nothing older than this is wanted (the app cleared its chat at that moment). */
  notBefore: string | null
}

export interface HistoryPage {
  /** `deliver`-shaped messages, oldest first, without a `seq`. */
  messages: Record<string, unknown>[]
  more: boolean
  /** Why there is no more: `start` (the conversation begins) or `window` (older exists beyond Halo's limit). Null while `more`. */
  end: 'start' | 'window' | null
}

const MESSAGE_KINDS = ['text', 'image', 'video', 'audio', 'document'] as const
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FILE_ID = /^h_(u_[A-Za-z0-9]{1,40})\.([A-Za-z0-9_-]{1,64})$/

/** The id the app uses for a file in an older message: the user and the Halo message it belongs to. */
export const historyFileId = (userId: string, serverId: string): string => `h_${userId}.${serverId}`
export const isHistoryFileId = (fileId: string): boolean => FILE_ID.test(fileId)

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null)
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null)
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t < Date.UTC(2100, 0, 1) ? new Date(t).toISOString() : null
}

export interface HistoryServiceOptions {
  /** Replaceable in tests (and by the simulator, so "Halo offline" also stops history). */
  fetch?: typeof fetch
  now?: () => number
}

export class HistoryService {
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  /** One fetch per file at a time: two taps on the same photo must not fetch it twice. */
  private readonly inflight = new Map<string, Promise<boolean>>()

  constructor(
    private readonly store: Store,
    private readonly files: FileService,
    private readonly cfg: Pick<GatewayConfig, 'limits'>,
    opts: HistoryServiceOptions = {},
  ) {
    this.doFetch = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
  }

  /** Halo's history address: the webhook address with its last path segment replaced. */
  historyUrl(workspace: Workspace): string {
    const u = new URL(workspace.halo_webhook_url)
    u.pathname = u.pathname.replace(/\/[^/]*$/, '/history')
    u.search = ''
    return u.toString()
  }

  private async ask(workspace: Workspace, payload: Record<string, unknown>): Promise<{ status: number; retryAfter: number | null; json: unknown }> {
    const rawBody = JSON.stringify(payload)
    let res: Response
    try {
      res = await this.doFetch(this.historyUrl(workspace), {
        method: 'POST',
        headers: signedHeaders(this.store.haloSigningSecret(workspace), rawBody, this.now()),
        body: rawBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(HALO_TIMEOUT_MS),
      })
    } catch (err) {
      log.child('history').warn('Halo could not be reached', { error: err instanceof Error ? err.message : String(err) })
      throw new HistoryError('history_unavailable', 'Halo could not be reached: try again in a moment', 5)
    }
    const body = await res.text().catch(() => '')
    let json: unknown = null
    try {
      json = body ? JSON.parse(body) : null
    } catch {
      json = null
    }
    const retry = Number(res.headers.get('retry-after'))
    return { status: res.status, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null, json }
  }

  private failFor(status: number, retryAfter: number | null): never {
    if (status === 404) throw new HistoryError('history_disabled', 'Halo does not offer older messages for this workspace')
    if (status === 429) throw new HistoryError('rate_limited', 'Too many requests for older messages: wait a little', retryAfter ?? 10)
    log.child('history').warn('Halo refused a history request', { status })
    throw new HistoryError('history_unavailable', 'Older messages are not available right now: try again in a moment', retryAfter ?? 10)
  }

  // ----------------------------------------------------------
  // A page of older messages
  // ----------------------------------------------------------

  async page(subject: Subject, q: HistoryQuery): Promise<HistoryPage> {
    const payload: Record<string, unknown> = {
      v: 1,
      workspace_key: subject.workspace.workspace_key,
      conversation_id: subject.conversation.id,
      wallet_id: subject.user.wallet_id,
      before: { sent_at: q.beforeSentAt, ...(q.beforeServerId ? { server_id: q.beforeServerId } : {}) },
      limit: q.limit,
      ...(q.notBefore ? { not_before: q.notBefore } : {}),
    }
    const res = await this.ask(subject.workspace, payload)
    if (res.status !== 200) this.failFor(res.status, res.retryAfter)
    const body = rec(res.json)
    if (!body) throw new HistoryError('history_unavailable', 'Halo answered with something unreadable')
    // A paused or switched-off Halo workspace answers 200 `ignored`: there is nothing older to show.
    if (typeof body.ignored === 'string') return { messages: [], more: false, end: 'window' }

    const raw = Array.isArray(body.messages) ? body.messages : []
    const messages: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (const r of raw) {
      if (messages.length >= q.limit) break
      const frame = this.messageFrame(subject, r)
      const id = frame?.server_id
      if (!frame || typeof id !== 'string' || seen.has(id)) continue
      seen.add(id)
      messages.push(frame)
    }
    // Oldest first, as the app expects to prepend a page.
    messages.sort((a, b) => Date.parse(String(a.sent_at)) - Date.parse(String(b.sent_at)))
    const more = body.more === true && messages.length > 0
    const end = more ? null : body.end === 'window' ? 'window' : 'start'
    return { messages, more, end }
  }

  /** One message as the app sees it, or null when Halo's row does not pass the checks. */
  private messageFrame(subject: Subject, raw: unknown): Record<string, unknown> | null {
    const m = rec(raw)
    if (!m) return null
    const serverId = typeof m.server_id === 'string' && SAFE_ID.test(m.server_id) ? m.server_id : null
    const sentAt = isoOrNull(m.sent_at)
    if (!serverId || !sentAt) return null
    const direction = m.direction === 'in' ? 'in' : m.direction === 'out' ? 'out' : null
    let kind = typeof m.kind === 'string' && (MESSAGE_KINDS as readonly string[]).includes(m.kind) ? (m.kind as FileKind | 'text') : null
    if (!direction || !kind) return null

    let body = text(m.text, this.cfg.limits.textMax)
    let media: Record<string, unknown> | null = null
    const rm = rec(m.media)
    if (kind !== 'text') {
      const mime = rm ? text(rm.mime_type, 100) : null
      if (rm && mime) {
        const fileId = historyFileId(subject.user.id, serverId)
        const link = this.files.linkForApp(fileId)
        media = {
          file_id: fileId,
          url: link.url,
          expires_at: link.expiresAt.toISOString(),
          mime_type: mime,
          file_name: text(rm.file_name, 200),
          size_bytes: whole(rm.size_bytes) ?? 0,
          duration_seconds: whole(rm.duration_seconds),
          ...(rm.animated === true ? { animated: true } : {}),
        }
      } else {
        // A file Halo no longer has: show what is left rather than an empty bubble.
        kind = 'text'
        body = body ? `${body}\n\n[Attachment not available]` : '[Attachment not available]'
      }
    }
    if (kind === 'text' && !body) return null

    const rq = rec(m.reply_to)
    const quoteId = rq && typeof rq.server_id === 'string' && SAFE_ID.test(rq.server_id) ? rq.server_id : null
    const quoteKind = rq && typeof rq.kind === 'string' && (MESSAGE_KINDS as readonly string[]).includes(rq.kind) ? rq.kind : 'text'
    const replyTo = quoteId ? { server_id: quoteId, kind: quoteKind, text: text(rq!.text, QUOTE_MAX), from: rq!.from === 'you' ? 'you' : 'support' } : null

    const status = m.status === 'read' || m.status === 'delivered' ? m.status : 'sent'
    const sender = rec(m.sender)
    return {
      type: 'deliver',
      server_id: serverId,
      seq: null,
      conversation_id: subject.conversation.id,
      direction,
      kind,
      text: body,
      media,
      reply_to: replyTo,
      sender: { name: direction === 'out' ? text(sender?.name, 200) : null },
      sent_at: sentAt,
      status,
    }
  }

  // ----------------------------------------------------------
  // A file in an older message
  // ----------------------------------------------------------

  /** Is `fileId` one of this user's own history files? (The app may only ask for a fresh link to its own.) */
  ownedBy(subject: Subject, fileId: string): boolean {
    const m = FILE_ID.exec(fileId)
    return !!m && m[1] === subject.user.id
  }

  /**
   * Make sure the file is stored here, fetching it from Halo the first time. True when it is there now; false when Halo
   * does not have it (or no longer lets this user see it). Throws HistoryError when Halo cannot be reached.
   */
  materialise(fileId: string): Promise<boolean> {
    const running = this.inflight.get(fileId)
    if (running) return running
    const job = this.fetchFile(fileId).finally(() => this.inflight.delete(fileId))
    this.inflight.set(fileId, job)
    return job
  }

  private async fetchFile(fileId: string): Promise<boolean> {
    const m = FILE_ID.exec(fileId)
    if (!m) return false
    if (await this.files.read(fileId)) return true
    const subject = await this.store.subjectByUserId(m[1]!)
    if (!subject) return false
    const res = await this.ask(subject.workspace, {
      v: 1,
      workspace_key: subject.workspace.workspace_key,
      conversation_id: subject.conversation.id,
      wallet_id: subject.user.wallet_id,
      file_for: m[2],
    })
    if (res.status === 404) return false
    if (res.status !== 200) this.failFor(res.status, res.retryAfter)
    const media = rec(rec(res.json)?.media)
    const url = media ? text(media.download_url, 2000) : null
    const kind = media && typeof media.kind === 'string' && (MESSAGE_KINDS as readonly string[]).includes(media.kind) && media.kind !== 'text' ? (media.kind as FileKind) : null
    const mime = media ? text(media.mime_type, 100) : null
    if (!media || !url || !kind || !mime) return false
    const fetched = await this.files.fetchFromHalo(kind, {
      url,
      mimeType: mime,
      fileName: text(media.file_name, 200),
      sizeBytes: whole(media.size_bytes),
      durationSeconds: whole(media.duration_seconds),
      animated: media.animated === true,
    })
    try {
      await this.files.storeBytes(subject, 'halo', { ...fetched, id: fileId })
    } catch (err) {
      // Two instances raced to store the same file: the other one won, which is fine.
      if (!(await this.files.read(fileId))) throw err
    }
    return true
  }
}
