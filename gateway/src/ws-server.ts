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
import { ackFrame, deliverFrame, errorFrame, welcomeFrame } from './frames'
import type { Hub, LiveConnection } from './hub'
import { parseClientFrame, type ClientFrame } from './protocol'
import type { Message, Store, Subject } from './store'

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
  cfg: GatewayConfig
  hooks?: GatewayHooks
}): WebSocketGateway {
  const { server, hub, store, cfg, hooks } = args
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes })
  const limiter = new SendRateLimiter(cfg.sendRateLimit.limit, cfg.sendRateLimit.windowMs)
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
          console.error('[ws] frame failed:', err)
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
        send(welcomeFrame(subject, cfg))
        // Join the live set only after the welcome, so nothing another device sends can reach this one
        // ahead of it, and so a connection that dropped during the lookups is never counted as online.
        live = { id: connectionId, userId: found.user.id, deviceId: frame.deviceId, send, close: (code, reason) => ws.close(code, reason) }
        for (const old of hub.add(live)) old.close(CLOSE.replaced, 'replaced')
        if (frame.lastSeq !== null) await replay(frame.lastSeq)
        return
      }

      switch (frame.type) {
        case 'hello':
          return void send(errorFrame('already_connected', 'hello was already accepted'))
        case 'ping':
          return void send({ type: 'pong', t: frame.t ?? null })
        case 'typing':
          return // accepted and ignored for now; Halo has no typing event in contract version 1
        case 'resume':
          return replay(frame.lastSeq)
        case 'receipt': {
          const changed = await store.applyReceipt(subject, frame.upToSeq, frame.status)
          if (changed.length > 0) hooks?.receiptsApplied?.(subject, changed)
          return
        }
        case 'send': {
          if (frame.messageType !== 'text') {
            return void send(errorFrame('unsupported_kind', 'Files are not available yet'))
          }
          const wait = limiter.hit(subject.user.id)
          if (wait > 0) return void send(errorFrame('rate_limited', 'You are sending too fast', wait))
          const { message, duplicate } = await store.appendInbound(subject, {
            clientId: frame.clientId,
            type: frame.messageType,
            text: frame.text,
          })
          send(ackFrame(frame.clientId, message, duplicate))
          if (!duplicate) {
            // The user's other devices see what this one sent.
            hub.send(subject.user.id, deliverFrame(message), connectionId)
            hooks?.inboundStored?.(subject, message)
          }
          return
        }
      }
    }

    /** Send everything after `lastSeq`, oldest first, then say where it stopped. */
    async function replay(lastSeq: number): Promise<void> {
      if (!subject) return
      const batch = await store.listAfter(subject.conversation.id, lastSeq, cfg.replayBatch)
      for (const m of batch) send(deliverFrame(m))
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
