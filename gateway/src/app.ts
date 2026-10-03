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
import { Dispatcher, type DispatcherOptions } from './dispatcher'
import { buildRoutes, handleRequest, type Route } from './http'
import { Hub } from './hub'
import { Store } from './store'
import { attachWebSocket, type GatewayHooks, type WebSocketGateway } from './ws-server'

export interface Gateway {
  server: Server
  store: Store
  hub: Hub
  cfg: GatewayConfig
  /** Sends events to Halo; null when the gateway was started without one (some tests). */
  dispatcher: Dispatcher | null
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
}): Promise<Gateway> {
  const { cfg, db } = args
  const store = new Store(db, cfg)
  const hub = new Hub(cfg.maxDevicesPerUser)
  const routes = { ...buildRoutes(), ...args.routes }
  const services = { store, hub, cfg }

  const dispatcher = args.dispatcher === false ? null : new Dispatcher(store, cfg, args.dispatcher)
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

  return {
    server,
    store,
    hub,
    cfg,
    dispatcher,
    port,
    async close() {
      await dispatcher?.stop()
      await ws.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
