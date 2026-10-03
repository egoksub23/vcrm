// ============================================================
// Puts the pieces together: one HTTP server carrying the HTTP routes and the
// WebSocket endpoint, over a database, with the dispatcher that sends events to
// Halo. Used by the real server (server.ts) and by the tests, which pass an
// in-process database.
// ============================================================

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { GatewayConfig } from './config'
import { newId } from './crypto'
import type { Db } from './db'
import { DeliveryService, type DeliveryOptions } from './delivery'
import { Dispatcher, type DispatcherOptions } from './dispatcher'
import { FileService, type FileServiceOptions } from './files'
import { buildRoutes, handleRequest, type Route } from './http'
import { Hub } from './hub'
import { createPushAdapter, MockPushAdapter, type PushAdapter } from './push'
import { applySupportStatus } from './receipts'
import { buildSimulatorRoutes, SimulatorState, simulatorFetch } from './simulator/routes'
import { Store } from './store'
import { attachWebSocket, type GatewayHooks, type WebSocketGateway } from './ws-server'
import { log } from './log'
import { runRetention } from './retention'

export interface Gateway {
  server: Server
  store: Store
  hub: Hub
  cfg: GatewayConfig
  /** Sends events to Halo; null when the gateway was started without one (some tests). */
  dispatcher: Dispatcher | null
  /** Chooses socket or push for each message from Halo. */
  delivery: DeliveryService
  /** Files in both directions: upload slots, fetching from Halo, signed links. */
  files: FileService
  /** Where the alerts for simulator users go (the mock), whatever the real adapter is. */
  simulatedPush: MockPushAdapter
  /** The port actually listening (useful when started on port 0). */
  port: number
  close(): Promise<void>
}

/** The user is typing: Halo is told at most this often per user. */
const TYPING_EVENT_INTERVAL_MS = 3000
/** Upload slots nobody used are cleared this often. */
const FILE_HOUSEKEEPING_MS = 10 * 60_000

export async function startGateway(args: {
  cfg: GatewayConfig
  db: Db
  hooks?: GatewayHooks
  /** Extra HTTP routes, keyed "METHOD /path" (the later work packages add theirs here). */
  routes?: Record<string, Route>
  /** The dispatcher is on by default; `false` leaves the outbox untouched (a test that inspects it). */
  dispatcher?: false | DispatcherOptions
  /** The push adapter (default: the one PUSH_ADAPTER names). */
  push?: PushAdapter
  /** `sweeper: false` leaves unacknowledged messages alone (a test that drives `delivery.sweep()` itself). */
  delivery?: DeliveryOptions & { sweeper?: boolean }
  /** What the file service fetches Halo's files with (tests replace it). */
  files?: FileServiceOptions
  /** Where the simulator's page files are (gateway/public). Needed only when the simulator is enabled. */
  publicDir?: string
}): Promise<Gateway> {
  const { cfg, db } = args
  const store = new Store(db, cfg)
  const hub = new Hub(cfg.maxDevicesPerUser)
  const files = new FileService(db, cfg, args.files)
  const simulatedPush = new MockPushAdapter()
  const delivery = new DeliveryService(store, hub, args.push ?? createPushAdapter(cfg), simulatedPush, cfg, { ...args.delivery, files })
  const services = { store, hub, cfg, delivery, files, db }

  // The simulator may switch a Halo "off": the dispatcher's calls to it then fail like a network outage.
  const simulator = cfg.simulator.enabled ? new SimulatorState() : null
  const dispatcherOptions: DispatcherOptions = {
    ...(args.dispatcher || {}),
    ...(simulator ? { fetch: simulatorFetch(simulator, args.dispatcher ? args.dispatcher.fetch : undefined) } : {}),
    // A file in an event becomes a fresh signed link every time the event is sent.
    transformPayload: (payload) => files.signEventMedia(payload),
    // Halo accepted a message from the user: that message is now "delivered" to support, and the app is told.
    onDispatched: async (event) => {
      if (event.kind !== 'message.inbound') return
      const message = event.payload.message as { server_id?: string } | undefined
      const conversationId = event.payload.conversation_id
      if (!message?.server_id || typeof conversationId !== 'string') return
      const subject = await store.subjectByConversation(conversationId)
      if (subject) await applySupportStatus({ store, hub }, subject, [message.server_id], 'delivered')
    },
  }
  const dispatcher = args.dispatcher === false ? null : new Dispatcher(store, cfg, dispatcherOptions)

  const routes = {
    ...buildRoutes(),
    ...(simulator ? buildSimulatorRoutes({ state: simulator, dispatcher: () => dispatcher, simulatedPush, publicDir: args.publicDir ?? 'public' }) : {}),
    ...args.routes,
  }

  // What the connection layer stores, the dispatcher is told about at once.
  const lastTypingEvent = new Map<string, number>()
  const hooks: GatewayHooks = {
    inboundStored: (subject, message) => {
      args.hooks?.inboundStored?.(subject, message)
      dispatcher?.kick()
    },
    receiptsApplied: (subject, messages) => {
      args.hooks?.receiptsApplied?.(subject, messages)
      dispatcher?.kick()
    },
    // The user is typing: Halo hears at most once every few seconds, once, with no retry.
    typing: (subject) => {
      args.hooks?.typing?.(subject)
      if (!dispatcher) return
      const now = Date.now()
      if (now - (lastTypingEvent.get(subject.user.id) ?? 0) < TYPING_EVENT_INTERVAL_MS) return
      lastTypingEvent.set(subject.user.id, now)
      if (lastTypingEvent.size > 5000) for (const [k, t] of lastTypingEvent) if (now - t > 60_000) lastTypingEvent.delete(k)
      void dispatcher.sendEphemeral(subject.workspace, {
        event: 'user.typing',
        event_id: newId('evt_'),
        workspace_key: subject.workspace.workspace_key,
        user: { wallet_id: subject.user.wallet_id },
        conversation_id: subject.conversation.id,
        at: new Date().toISOString(),
      })
    },
  }

  const server = createServer((req, res) => void handleRequest(req, res, services, routes))
  const ws: WebSocketGateway = attachWebSocket({ server, hub, store, files, cfg, hooks })

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve))
  const port = (server.address() as AddressInfo).port
  // Behind a proxy the links carry the public address; on this machine, the port actually listening.
  if (!cfg.files.publicBaseUrl) files.baseUrl = `http://127.0.0.1:${port}`
  dispatcher?.start()
  if (args.delivery?.sweeper !== false) delivery.start()
  const housekeeping = setInterval(() => void files.purgeStalePending().catch(() => undefined), FILE_HOUSEKEEPING_MS)
  housekeeping.unref()
  // Retention: a first run a minute after start (not during the busy moment of a restart), then on a schedule.
  const retain = () =>
    runRetention(db, { days: cfg.retention.days })
      .then((r) => {
        if (r.messages + r.files + r.events + r.pushLog + r.sessions > 0) log.info('retention', { ...r })
      })
      .catch((err) => log.error('retention failed', { error: err instanceof Error ? err.message : String(err) }))
  const retentionFirst = setTimeout(retain, 60_000)
  const retentionTimer = setInterval(retain, cfg.retention.intervalMinutes * 60_000)
  retentionFirst.unref()
  retentionTimer.unref()

  return {
    server,
    store,
    hub,
    cfg,
    dispatcher,
    delivery,
    files,
    simulatedPush,
    port,
    async close() {
      clearInterval(housekeeping)
      clearTimeout(retentionFirst)
      clearInterval(retentionTimer)
      await dispatcher?.stop()
      await delivery.stop()
      await ws.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
