// ============================================================
// The app's WebSocket endpoint (protocol.ts). One state machine per connection:
//
//   waiting for hello  --(valid token)-->  live  --(close)-->  gone
//        |  (10 s of silence, bad token, bad frame)
//        v
//     closed with 4401 / 4408
//
// A live connection can send messages (acknowledged and stored in order), report
// receipts, and ask to resume from the last sequence number it holds. The server
// pings every `heartbeatSeconds` and drops a connection that misses two.
// ============================================================

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'

import { WebSocket, WebSocketServer } from 'ws'

import type { GatewayConfig } from './config'
import { FileError, type FileKind, type FileRow, type FileService, type MessageMedia } from './files'
import { ackFrame, deliverFrame, errorFrame, fileUrlFrame, receiptFrame, uploadSlotFrame, welcomeFrame } from './frames'
import type { Hub, LiveConnection } from './hub'
import { parseClientFrame, type ClientFrame } from './protocol'
import type { Message, Store, Subject } from './store'
import { log } from './log'

/** Close codes the app can act on. */
export const CLOSE = {
  unauthorized: 4401,
  helloTimeout: 4408,
  replaced: 4409,
  tooManyErrors: 4400,
  serviceRestart: 1012,
} as const

/** What happens after the gateway stores something, for the Halo dispatcher (work package 2). */
export interface GatewayHooks {
  inboundStored?(subject: Subject, message: Message): void
  receiptsApplied?(subject: Subject, messages: Message[]): void
  /** The user is typing (the app sent a `typing` frame). */
  typing?(subject: Subject): void
}

class SendRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Seconds to wait if the user is over the limit, else 0 (and the send is counted). */
  hit(key: string, now = Date.now()): number {
    const w = this.windows.get(key)
    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs })
      return 0
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.resetAt - now) / 1000))
    w.count++
    return 0
  }

  sweep(now = Date.now()): void {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k)
  }
}

const MAX_BAD_FRAMES = 5

export interface WebSocketGateway {
  /** Close every connection (so clients resume against the next instance) and stop. */
  shutdown(): Promise<void>
}

export function attachWebSocket(args: {
  server: Server
  hub: Hub
  store: Store
  files: FileService
  cfg: GatewayConfig
  hooks?: GatewayHooks
}): WebSocketGateway {
  const { server, hub, store, files, cfg, hooks } = args
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes })
  const limiter = new SendRateLimiter(cfg.sendRateLimit.limit, cfg.sendRateLimit.windowMs)
  // Twenty upload slots per user every ten minutes: enough for a gallery, not for filling the disk.
  const uploadLimiter = new SendRateLimiter(20, 600_000)
  const sockets = new Set<WebSocket>()
  const alive = new WeakMap<WebSocket, boolean>()

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== cfg.wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws)
    alive.set(ws, true)
    let subject: Subject | null = null
    let live: LiveConnection | null = null
    let badFrames = 0
    let closed = false
    const connectionId = randomUUID()

    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
    }
    const fail = (code: number, errCode: string, message: string) => {
      send(errorFrame(errCode, message))
      ws.close(code, errCode)
    }

    const helloTimer = setTimeout(() => {
      if (!subject) fail(CLOSE.helloTimeout, 'hello_timeout', 'No hello arrived in time')
    }, cfg.helloTimeoutMs)

    ws.on('pong', () => alive.set(ws, true))

    ws.on('close', () => {
      closed = true
      clearTimeout(helloTimer)
      sockets.delete(ws)
      if (live) hub.remove(live)
    })
    ws.on('error', () => ws.terminate())

    // Messages are handled one at a time per connection, in the order they arrived.
    let chain: Promise<void> = Promise.resolve()
    ws.on('message', (data, isBinary) => {
      alive.set(ws, true)
      chain = chain.then(async () => {
        if (closed) return
        if (isBinary) return void send(errorFrame('bad_frame', 'Binary frames are not supported'))
        const parsed = parseClientFrame(data.toString('utf8'), cfg.limits)
        if (!parsed.ok) {
          if (++badFrames >= MAX_BAD_FRAMES) return fail(CLOSE.tooManyErrors, 'too_many_errors', 'Too many bad frames')
          if (!subject) return fail(CLOSE.unauthorized, parsed.code, parsed.message)
          return void send(errorFrame(parsed.code, parsed.message))
        }
        try {
          await handle(parsed.frame)
        } catch (err) {
          log.child('ws').error('frame failed', { error: err instanceof Error ? err.message : String(err) })
          send(errorFrame('internal', 'Something went wrong; try again'))
        }
      })
    })

    async function handle(frame: ClientFrame): Promise<void> {
      if (!subject) {
        if (frame.type !== 'hello') return fail(CLOSE.unauthorized, 'hello_required', 'The first frame must be hello')
        const found = await store.consumeSession(frame.token)
        if (!found) return fail(CLOSE.unauthorized, 'unauthorized', 'The connect token is not valid')
        subject = found
        clearTimeout(helloTimer)
        // The conversation row may have moved on since the session was made.
        const current = await store.findSubjectByWallet(found.workspace, found.user.wallet_id)
        if (current) subject = current
        if (closed) return
        // The user is here: the away period (and any outstanding alert) is over.
        await store.clearAlert(subject.conversation.id)
        send(welcomeFrame(subject, cfg))
        // Join the live set only after the welcome, so nothing another device sends can reach this one
        // ahead of it, and so a connection that dropped during the lookups is never counted as online.
        live = { id: connectionId, userId: found.user.id, deviceId: frame.deviceId, send, close: (code, reason) => ws.close(code, reason) }
        for (const old of hub.add(live)) old.close(CLOSE.replaced, 'replaced')
        if (frame.lastSeq !== null) await replay(frame.lastSeq)
        // Ticks that changed while the app was closed: the replay only carries messages the app does not have yet.
        const own = await store.ownMessageStatuses(subject.conversation.id, 100)
        for (const status of ['delivered', 'read'] as const) {
          const list = own.filter((m) => m.status === status)
          if (list.length > 0) send(receiptFrame(subject.conversation.id, status, list))
        }
        return
      }

      switch (frame.type) {
        case 'hello':
          return void send(errorFrame('already_connected', 'hello was already accepted'))
        case 'ping':
          return void send({ type: 'pong', t: frame.t ?? null })
        case 'typing':
          hooks?.typing?.(subject)
          return
        case 'resume':
          return replay(frame.lastSeq)
        case 'receipt': {
          await store.clearAlert(subject.conversation.id)
          const changed = await store.applyReceipt(subject, frame.upToSeq, frame.status)
          if (changed.length > 0) hooks?.receiptsApplied?.(subject, changed)
          return
        }
        case 'send': {
          const wait = limiter.hit(subject.user.id)
          if (wait > 0) return void send(errorFrame('rate_limited', 'You are sending too fast', wait, { client_id: frame.clientId }))
          await store.clearAlert(subject.conversation.id)
          // A retry of a message that was stored is answered with the original, before any file is claimed again.
          const prior = await store.findInboundByClientId(subject, frame.clientId)
          if (prior) return void send(ackFrame(frame.clientId, prior, true))

          let claimed: FileRow | null = null
          let media: MessageMedia | null = null
          if (frame.messageType !== 'text') {
            try {
              claimed = await files.claimForMessage(subject, frame.media!.fileId, frame.messageType as FileKind)
              media = files.mediaOf(claimed)
            } catch (err) {
              if (err instanceof FileError) return void send(errorFrame(err.code, err.message, undefined, { client_id: frame.clientId }))
              throw err
            }
          }
          try {
            const quote = frame.replyTo ? await store.quoteFor(subject, frame.replyTo) : null
            const { message, duplicate } = await store.appendInbound(subject, {
              clientId: frame.clientId,
              type: frame.messageType,
              text: frame.text,
              media,
              replyTo: quote,
            })
            send(ackFrame(frame.clientId, message, duplicate))
            if (!duplicate) {
              // The user's other devices see what this one sent.
              hub.send(subject.user.id, deliverFrame(message, files), connectionId)
              hooks?.inboundStored?.(subject, message)
            } else if (claimed) {
              await files.release(claimed.id) // raced with another copy of the same send: the file was not used
            }
          } catch (err) {
            if (claimed) await files.release(claimed.id).catch(() => undefined)
            throw err
          }
          return
        }
        case 'upload_request': {
          const slotWait = uploadLimiter.hit(subject.user.id)
          if (slotWait > 0) return void send(errorFrame('rate_limited', 'Too many uploads: wait a little', slotWait, { request_id: frame.requestId }))
          try {
            const slot = await files.createUploadSlot(subject, {
              kind: frame.kind,
              mimeType: frame.mimeType,
              fileName: frame.fileName,
              sizeBytes: frame.sizeBytes,
              durationSeconds: frame.durationSeconds,
              animated: frame.animated,
            })
            send(uploadSlotFrame(frame.requestId, slot))
          } catch (err) {
            if (err instanceof FileError) return void send(errorFrame(err.code, err.message, undefined, { request_id: frame.requestId }))
            throw err
          }
          return
        }
        case 'file_url': {
          const link = await files.linkForUser(subject, frame.fileId)
          if (!link) return void send(errorFrame('file_not_found', 'No such file in your conversation'))
          return void send(fileUrlFrame(frame.fileId, link))
        }
      }
    }

    /** Send everything after `lastSeq`, oldest first, then say where it stopped. */
    async function replay(lastSeq: number): Promise<void> {
      if (!subject) return
      const batch = await store.listAfter(subject.conversation.id, lastSeq, cfg.replayBatch)
      for (const m of batch) send(deliverFrame(m, files))
      const upTo = batch.length > 0 ? batch[batch.length - 1]!.seq : lastSeq
      send({ type: 'resume_done', conversation_id: subject.conversation.id, up_to_seq: upTo, more: batch.length >= cfg.replayBatch })
    }
  })

  const heartbeat = setInterval(() => {
    limiter.sweep()
    for (const ws of sockets) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, cfg.heartbeatSeconds * 1000)
  heartbeat.unref()

  return {
    async shutdown() {
      clearInterval(heartbeat)
      hub.closeAll(CLOSE.serviceRestart, 'service restart')
      for (const ws of sockets) ws.close(CLOSE.serviceRestart, 'service restart')
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
