// ============================================================
// Puts the pieces together: one HTTP server carrying the HTTP routes and the
// WebSocket endpoint, over a database, with the dispatcher that sends events to
// Halo. Used by the real server (server.ts) and by the tests, which pass an
// in-process database.
// ============================================================

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { GatewayConfig } from './config'
import type { Db } from './db'
import { DeliveryService, type DeliveryOptions } from './delivery'
import { Dispatcher, type DispatcherOptions } from './dispatcher'
import { buildRoutes, handleRequest, type Route } from './http'
import { Hub } from './hub'
import { createPushAdapter, MockPushAdapter, type PushAdapter } from './push'
import { buildSimulatorRoutes, SimulatorState, simulatorFetch } from './simulator/routes'
import { Store } from './store'
import { attachWebSocket, type GatewayHooks, type WebSocketGateway } from './ws-server'

export interface Gateway {
  server: Server
  store: Store
  hub: Hub
  cfg: GatewayConfig
  /** Sends events to Halo; null when the gateway was started without one (some tests). */
  dispatcher: Dispatcher | null
  /** Chooses socket or push for each message from Halo. */
  delivery: DeliveryService
  /** Where the alerts for simulator users go (the mock), whatever the real adapter is. */
  simulatedPush: MockPushAdapter
  /** The port actually listening (useful when started on port 0). */
  port: number
  close(): Promise<void>
}

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
  /** Where the simulator's page files are (gateway/public). Needed only when the simulator is enabled. */
  publicDir?: string
}): Promise<Gateway> {
  const { cfg, db } = args
  const store = new Store(db, cfg)
  const hub = new Hub(cfg.maxDevicesPerUser)
  const simulatedPush = new MockPushAdapter()
  const delivery = new DeliveryService(store, hub, args.push ?? createPushAdapter(cfg), simulatedPush, cfg, args.delivery)
  const services = { store, hub, cfg, delivery }

  // The simulator may switch a Halo "off": the dispatcher's calls to it then fail like a network outage.
  const simulator = cfg.simulator.enabled ? new SimulatorState() : null
  const dispatcher =
    args.dispatcher === false
      ? null
      : new Dispatcher(store, cfg, simulator ? { ...args.dispatcher, fetch: simulatorFetch(simulator, args.dispatcher?.fetch) } : args.dispatcher)
  const routes = {
    ...buildRoutes(),
    ...(simulator ? buildSimulatorRoutes({ state: simulator, dispatcher: () => dispatcher, simulatedPush, publicDir: args.publicDir ?? 'public' }) : {}),
    ...args.routes,
  }
  // What the connection layer stores, the dispatcher is told about at once.
  const hooks: GatewayHooks = {
    inboundStored: (subject, message) => {
      args.hooks?.inboundStored?.(subject, message)
      dispatcher?.kick()
    },
    receiptsApplied: (subject, messages) => {
      args.hooks?.receiptsApplied?.(subject, messages)
      dispatcher?.kick()
    },
  }

  const server = createServer((req, res) => void handleRequest(req, res, services, routes))
  const ws: WebSocketGateway = attachWebSocket({ server, hub, store, cfg, hooks })

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve))
  const port = (server.address() as AddressInfo).port
  dispatcher?.start()
  if (args.delivery?.sweeper !== false) delivery.start()

  return {
    server,
    store,
    hub,
    cfg,
    dispatcher,
    delivery,
    simulatedPush,
    port,
    async close() {
      await dispatcher?.stop()
      await delivery.stop()
      await ws.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
