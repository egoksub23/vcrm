// ============================================================
// The simulator's server side (docs/vircle-chat-gateway-scope.md, section 4). Off unless
// SIMULATOR_ENABLED=true. Everything is under /simulator:
//
//   GET  /simulator, /simulator/app.js, /simulator/app.css      the page (public/)
//   POST /simulator/api/login          { token }   the launch token from Halo -> a simulator session
//   (the rest need the header x-sim-session)
//   GET  /simulator/api/config         what this gateway is set to (timeouts, push adapter, Halo address)
//   GET  /simulator/api/users          the test users of this workspace
//   POST /simulator/api/users          create a test user
//   POST /simulator/api/connect-token  a connect token for a test user (what the Vircle backend would mint)
//   POST /simulator/api/agent-message  send a message to a test user as Halo would (no Halo needed); may quote one
//   POST /simulator/api/agent-file     send a file (the request body is the file) as Halo would
//   POST /simulator/api/agent-read     mark the user's messages read, as Halo does when an agent opens the chat
//   POST /simulator/api/agent-typing   show "support is typing" in the user's app
//   GET  /simulator/api/push           the alerts the gateway raised for a test user (mock only)
//   GET  /simulator/api/events         the calls to Halo (the outbox): state, attempts, last error
//   POST /simulator/api/halo-offline   pretend Halo is unreachable (or restore it)
//   POST /simulator/api/replay-event   post an old event to Halo again; Halo must ignore the repeat
//   POST /simulator/api/reset          forget the test users
//
// SAFETY: the simulator can only act on users it created (wallet ids `sim_...`, flagged in the database),
// their alerts always go to the mock push adapter whatever PUSH_ADAPTER is, and the page is reachable only
// with a launch token signed by Halo for that workspace.
// ============================================================

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import { acceptHaloMessage } from '../halo-messages'
import { FILE_KINDS, mimeMatchesKind, type FileKind } from '../files'
import { HttpError, readBody, readJson, sendJson, type Route, type Services } from '../http'
import { applySupportStatus, showAgentTyping } from '../receipts'
import type { Dispatcher } from '../dispatcher'
import type { MockPushAdapter } from '../push'
import type { Workspace } from '../store'
import { peekWorkspaceKey, verifyLaunchToken } from './token'

const SESSION_HOURS = 8

interface SimSession {
  workspaceId: string
  expiresAt: number
}

/** What the simulator keeps in memory: who is logged in, which launch tokens were used, which Halos are "down". */
export class SimulatorState {
  private readonly sessions = new Map<string, SimSession>()
  private readonly usedNonces = new Map<string, number>()
  private readonly offline = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  open(workspaceId: string): string {
    const id = randomBytes(24).toString('base64url')
    this.sessions.set(id, { workspaceId, expiresAt: this.now() + SESSION_HOURS * 3_600_000 })
    return id
  }

  workspaceOf(sessionId: string | undefined): string | null {
    if (!sessionId) return null
    const s = this.sessions.get(sessionId)
    if (!s) return null
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(sessionId)
      return null
    }
    return s.workspaceId
  }

  /** True the first time a nonce is seen. */
  spend(nonce: string, expUnixSeconds: number): boolean {
    for (const [n, exp] of this.usedNonces) if (exp * 1000 < this.now()) this.usedNonces.delete(n)
    if (this.usedNonces.has(nonce)) return false
    this.usedNonces.set(nonce, expUnixSeconds)
    return true
  }

  setHaloOffline(webhookUrl: string, offline: boolean): void {
    if (offline) this.offline.add(webhookUrl)
    else this.offline.delete(webhookUrl)
  }
  isHaloOffline(webhookUrl: string): boolean {
    return this.offline.has(webhookUrl)
  }
}

/** A fetch for the dispatcher that fails like a network outage while the simulator has switched a Halo off. */
export function simulatorFetch(state: SimulatorState, real: typeof fetch = fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    if (state.isHaloOffline(url)) return Promise.reject(new TypeError('simulated outage: Halo is switched off in the simulator'))
    return real(input, init)
  }) as typeof fetch
}

const STATIC: Record<string, { file: string; type: string }> = {
  'GET /simulator': { file: 'simulator.html', type: 'text/html; charset=utf-8' },
  'GET /simulator/app.js': { file: 'simulator.js', type: 'text/javascript; charset=utf-8' },
  'GET /simulator/app.css': { file: 'simulator.css', type: 'text/css; charset=utf-8' },
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const simUsername = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null)

export function buildSimulatorRoutes(args: { state: SimulatorState; dispatcher: () => Dispatcher | null; simulatedPush: MockPushAdapter; publicDir: string }): Record<string, Route> {
  const { state, simulatedPush, publicDir } = args

  const routes: Record<string, Route> = {}

  for (const [route, { file, type }] of Object.entries(STATIC)) {
    routes[route] = async (_req, res) => {
      let body: Buffer
      try {
        body = await readFile(join(publicDir, file))
      } catch {
        throw new HttpError(404, 'not_found', 'The simulator page is not installed on this gateway')
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
      res.end(body)
    }
  }

  async function workspaceFor(req: IncomingMessage, s: Services): Promise<Workspace> {
    const id = state.workspaceOf(typeof req.headers['x-sim-session'] === 'string' ? req.headers['x-sim-session'] : undefined)
    const workspace = id ? await s.store.getWorkspaceById(id) : null
    if (!workspace) throw new HttpError(401, 'unauthorized', 'The simulator session has ended: open the simulator again from Halo')
    return workspace
  }

  const authed =
    (fn: (req: IncomingMessage, res: ServerResponse, s: Services, workspace: Workspace) => Promise<void>): Route =>
    async (req, res, s) =>
      fn(req, res, s, await workspaceFor(req, s))

  const query = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://x').searchParams

  routes['POST /simulator/api/login'] = async (req, res, s) => {
    const body = (await readJson(req)) as { token?: unknown }
    const token = typeof body.token === 'string' ? body.token : ''
    const key = peekWorkspaceKey(token)
    const workspace = key ? await s.store.getWorkspaceByKey(key) : null
    // One answer for every way this can fail, so it cannot be used to probe for workspaces.
    const refuse = () => new HttpError(401, 'unauthorized', 'This simulator link is not valid or has expired: open it again from Halo')
    if (!workspace) throw refuse()
    const check = verifyLaunchToken(s.store.haloSigningSecret(workspace), token)
    if (!check.ok || !state.spend(check.claims.nonce, check.claims.exp)) throw refuse()
    sendJson(res, 200, { session: state.open(workspace.id), workspace: { key: workspace.workspace_key, name: workspace.name } })
  }

  routes['GET /simulator/api/config'] = authed(async (_req, res, s, workspace) => {
    const host = (() => {
      try {
        return new URL(workspace.halo_webhook_url).host
      } catch {
        return workspace.halo_webhook_url
      }
    })()
    sendJson(res, 200, {
      workspace: { key: workspace.workspace_key, name: workspace.name },
      halo: { host, offline: state.isHaloOffline(workspace.halo_webhook_url) },
      ws_path: s.cfg.wsPath,
      push: { adapter: 'mock (simulator users never cause a real alert)', ack_timeout_ms: s.cfg.push.ackTimeoutMs, window_minutes: s.cfg.push.windowMinutes, realert_hours: s.cfg.push.realertHours },
      limits: { text_max: s.cfg.limits.textMax },
    })
  })

  routes['GET /simulator/api/users'] = authed(async (_req, res, s, workspace) => {
    const users = await s.store.listSimulatedUsers(workspace.id)
    sendJson(res, 200, {
      users: users.map((u) => ({ wallet_id: u.wallet_id, name: u.name, phone: u.phone, email: u.email, conversation_id: u.conversation_id, last_seq: u.last_seq, online: s.hub.isOnline(u.id) })),
    })
  })

  routes['POST /simulator/api/users'] = authed(async (req, res, s, workspace) => {
    const body = (await readJson(req)) as Record<string, unknown>
    const walletId = `sim_${randomBytes(4).toString('hex')}`
    const base = simUsername(body.name, 60) ?? 'Test user'
    const subject = await s.store.upsertUser(workspace, {
      walletId,
      // The suffix makes a test user obvious in Halo's inbox.
      name: /\(sim\)$/i.test(base) ? base : `${base} (sim)`,
      phone: simUsername(body.phone, 40) ?? `+6012${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      email: simUsername(body.email, 200) ?? `${walletId}@sim.example.com`,
      simulated: true,
    })
    sendJson(res, 201, { wallet_id: walletId, name: subject.user.name, phone: subject.user.phone, email: subject.user.email, conversation_id: subject.conversation.id })
  })

  async function simUser(s: Services, workspace: Workspace, walletId: unknown) {
    const subject = typeof walletId === 'string' ? await s.store.findSubjectByWallet(workspace, walletId) : null
    if (!subject || !subject.user.simulated) throw new HttpError(404, 'user_not_found', 'No such test user')
    return subject
  }

  routes['POST /simulator/api/connect-token'] = authed(async (req, res, s, workspace) => {
    const subject = await simUser(s, workspace, ((await readJson(req)) as { wallet_id?: unknown }).wallet_id)
    const { token, expiresAt } = await s.store.createSession(subject)
    sendJson(res, 201, { token, expires_at: expiresAt.toISOString(), ws_path: s.cfg.wsPath, conversation_id: subject.conversation.id })
  })

  routes['POST /simulator/api/agent-message'] = authed(async (req, res, s, workspace) => {
    const body = (await readJson(req)) as { wallet_id?: unknown; text?: unknown; reply_to_server_id?: unknown }
    const subject = await simUser(s, workspace, body.wallet_id)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new HttpError(400, 'bad_request', 'The message needs text')
    if (text.length > s.cfg.limits.textMax) throw new HttpError(400, 'message_too_long', `A message may be at most ${s.cfg.limits.textMax} characters`)
    const answer = await acceptHaloMessage(s, workspace, {
      idempotencyKey: `sim-${randomBytes(8).toString('hex')}`,
      text,
      replyToServerId: typeof body.reply_to_server_id === 'string' ? body.reply_to_server_id : null,
      senderName: 'Support (sim)',
      recipient: { walletId: subject.user.wallet_id, name: subject.user.name, phone: subject.user.phone, email: subject.user.email },
    })
    sendJson(res, 202, answer)
  })

  /** The request body is the file; the rest is in headers (x-wallet-id, x-file-name, x-kind, x-caption, x-duration, x-reply-to). */
  routes['POST /simulator/api/agent-file'] = authed(async (req, res, s, workspace) => {
    const header = (name: string) => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : null)
    const subject = await simUser(s, workspace, header('x-wallet-id'))
    const mimeType = (header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const kind = FILE_KINDS.find((k) => mimeMatchesKind(k, mimeType)) as FileKind | undefined
    if (!kind) throw new HttpError(400, 'invalid_media', `Files of type ${mimeType || 'unknown'} are not allowed`)
    const bytes = await readBody(req, s.cfg.limits.fileMaxBytes)
    const duration = Number(header('x-duration'))
    const caption = decodeURIComponent(header('x-caption') ?? '').trim()
    const answer = await acceptHaloMessage(s, workspace, {
      idempotencyKey: `sim-${randomBytes(8).toString('hex')}`,
      text: caption ? caption.slice(0, s.cfg.limits.captionMax) : null,
      replyToServerId: header('x-reply-to'),
      senderName: 'Support (sim)',
      media: { kind, bytes, mimeType, fileName: header('x-file-name') ? decodeURIComponent(header('x-file-name')!) : null, durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null },
      recipient: { walletId: subject.user.wallet_id, name: subject.user.name, phone: subject.user.phone, email: subject.user.email },
    }).catch((err) => {
      if (err && typeof err === 'object' && 'code' in err && 'status' in err) throw new HttpError(400, 'invalid_media', (err as Error).message)
      throw err
    })
    sendJson(res, 202, answer)
  })

  routes['POST /simulator/api/agent-read'] = authed(async (req, res, s, workspace) => {
    const subject = await simUser(s, workspace, ((await readJson(req)) as { wallet_id?: unknown }).wallet_id)
    const all = await s.store.listAfter(subject.conversation.id, 0, 1000)
    const ids = all.filter((m) => m.direction === 'in' && m.status !== 'read').map((m) => m.id)
    sendJson(res, 200, { updated: ids.length ? await applySupportStatus(s, subject, ids, 'read') : 0 })
  })

  routes['POST /simulator/api/agent-typing'] = authed(async (req, res, s, workspace) => {
    const subject = await simUser(s, workspace, ((await readJson(req)) as { wallet_id?: unknown }).wallet_id)
    sendJson(res, 200, { delivered_to: showAgentTyping(s, subject) })
  })

  routes['GET /simulator/api/push'] = authed(async (req, res, s, workspace) => {
    const subject = await simUser(s, workspace, query(req).get('wallet_id'))
    const alerts = simulatedPush.sent
      .filter((p) => p.walletId === subject.user.wallet_id)
      .map((p) => ({ at: p.at.toISOString(), title: p.title, body: p.body, deep_link: p.deepLink, collapse_key: p.collapseKey, phone: p.phone, email: p.email, result: p.result.status }))
    const log = await s.store.pushLog(subject.conversation.id, 30)
    sendJson(res, 200, { alerts, decisions: log })
  })

  /** The conversation as Halo's agent sees it: every message, with the status the app's receipts moved it to. */
  routes['GET /simulator/api/messages'] = authed(async (req, res, s, workspace) => {
    const subject = await simUser(s, workspace, query(req).get('wallet_id'))
    const after = Math.max(0, subject.conversation.last_seq - 100)
    const messages = await s.store.listAfter(subject.conversation.id, after, 100)
    sendJson(res, 200, {
      messages: messages.map((m) => ({
        server_id: m.id,
        seq: m.seq,
        direction: m.direction,
        text: m.text,
        kind: m.type,
        reply_to: m.reply_to,
        media: m.media ? { file_name: m.media.file_name, mime_type: m.media.mime_type, size_bytes: m.media.size_bytes, url: s.files.linkForApp(m.media.file_id).url } : null,
        status: m.status,
        delivery: m.delivery,
        created_at: new Date(m.created_at).toISOString(),
        delivered_at: m.delivered_at ? new Date(m.delivered_at).toISOString() : null,
        read_at: m.read_at ? new Date(m.read_at).toISOString() : null,
      })),
    })
  })

  routes['GET /simulator/api/events'] = authed(async (_req, res, s, workspace) => {
    const events = await s.store.recentEvents(workspace.id, 40)
    sendJson(res, 200, {
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        state: e.dispatched_at ? 'sent' : e.failed_at ? 'given_up' : e.attempts > 0 ? 'retrying' : 'waiting',
        attempts: e.attempts,
        created_at: new Date(e.created_at).toISOString(),
        next_attempt_at: e.dispatched_at || e.failed_at ? null : new Date(e.next_attempt_at).toISOString(),
        last_error: e.last_error,
        summary: summarise(e.kind, e.payload),
      })),
    })
  })

  routes['POST /simulator/api/halo-offline'] = authed(async (req, res, s, workspace) => {
    const body = (await readJson(req)) as { offline?: unknown }
    state.setHaloOffline(workspace.halo_webhook_url, body.offline === true)
    if (body.offline !== true) {
      // Halo is back: send what built up now, not at the end of the retry waits.
      await s.store.retryNow(workspace.id)
      args.dispatcher()?.kick()
    }
    sendJson(res, 200, { offline: state.isHaloOffline(workspace.halo_webhook_url) })
  })

  routes['POST /simulator/api/replay-event'] = authed(async (req, res, s, workspace) => {
    const id = ((await readJson(req)) as { event_id?: unknown }).event_id
    const event = typeof id === 'string' ? await s.store.getEvent(workspace.id, id) : null
    const dispatcher = args.dispatcher()
    if (!event || !dispatcher) throw new HttpError(404, 'not_found', 'No such event, or the dispatcher is off')
    const outcome = await dispatcher.replay(workspace, event)
    sendJson(res, 200, { outcome: outcome.kind, http_status: 'status' in outcome ? (outcome.status ?? null) : null, answer: outcome.kind === 'ok' ? (outcome.detail ?? '') : outcome.error })
  })

  routes['POST /simulator/api/reset'] = authed(async (_req, res, s, workspace) => {
    const removed = await s.store.deleteSimulatedUsers(workspace.id)
    simulatedPush.reset()
    sendJson(res, 200, { removed })
  })

  return routes
}

function summarise(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'message.inbound') {
    const m = (payload.message ?? {}) as { text?: string | null; type?: string }
    const u = (payload.user ?? {}) as { wallet_id?: string }
    return `${u.wallet_id ?? '?'}: ${m.text ?? `[${m.type ?? 'file'}]`}`
  }
  if (kind === 'message.receipt') return `${String(payload.status)} for ${String(payload.server_id)}`
  return kind
}
