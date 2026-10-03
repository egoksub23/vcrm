// ============================================================
// Puts the pieces together: one HTTP server carrying the HTTP routes and the
// WebSocket endpoint, over a database. Used by the real server (server.ts) and
// by the tests, which pass an in-process database.
// ============================================================

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { GatewayConfig } from './config'
import type { Db } from './db'
import { buildRoutes, handleRequest, type Route } from './http'
import { Hub } from './hub'
import { Store } from './store'
import { attachWebSocket, type GatewayHooks, type WebSocketGateway } from './ws-server'

export interface Gateway {
  server: Server
  store: Store
  hub: Hub
  cfg: GatewayConfig
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
}): Promise<Gateway> {
  const { cfg, db } = args
  const store = new Store(db, cfg)
  const hub = new Hub(cfg.maxDevicesPerUser)
  const routes = { ...buildRoutes(), ...args.routes }
  const services = { store, hub, cfg }

  const server = createServer((req, res) => void handleRequest(req, res, services, routes))
  const ws: WebSocketGateway = attachWebSocket({ server, hub, store, cfg, hooks: args.hooks })

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve))
  const port = (server.address() as AddressInfo).port

  return {
    server,
    store,
    hub,
    cfg,
    port,
    async close() {
      await ws.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
