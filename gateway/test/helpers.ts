// Test helpers: an in-process Postgres (PGlite), a running gateway on a random port, and a small
// WebSocket client that records frames so a test can wait for the one it expects.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { WebSocket } from 'ws'

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { startGateway, type Gateway } from '../src/app'
import type { FileServiceOptions } from '../src/files'
import type { DeliveryOptions } from '../src/delivery'
import type { DispatcherOptions } from '../src/dispatcher'
import { MockPushAdapter } from '../src/push'
import { testConfig, type GatewayConfig } from '../src/config'
import { migrate, type Db, type Queryable } from '../src/db'
import type { GatewayHooks } from '../src/ws-server'
import type { Route } from '../src/http'
import type { Subject, Workspace } from '../src/store'

const here = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS = join(here, '..', 'migrations')

export async function createTestDb(): Promise<Db> {
  const pg = new PGlite()
  const wrap = (q: { query: PGlite['query'] }): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await q.query<T>(sql, params as never[])
      return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length }
    },
  })
  const db: Db = {
    ...wrap(pg),
    tx: (fn) => pg.transaction(async (tx) => fn(wrap(tx as never))),
    async exec(sql) {
      await pg.exec(sql)
    },
    async close() {
      await pg.close()
    },
  }
  await migrate(db, MIGRATIONS)
  return db
}

export const WORKSPACE = {
  key: 'vcw_abcdefghijklmnop1234',
  name: 'Vircle',
  haloWebhookUrl: 'https://halo.example.com/api/vircle-chat/webhook',
  signingSecret: 'vcs_halo_secret',
  apiToken: 'vct_halo_token',
}

export interface Harness {
  gw: Gateway
  db: Db
  workspace: Workspace
  sessionsKey: string
  /** The push adapter the gateway uses: records every alert it would have sent. */
  push: MockPushAdapter
  url: string
  /** Ask for a session over HTTP, as the Vircle backend would. */
  session(user?: Partial<{ wallet_id: string; name: string; phone: string; email: string }>): Promise<{ token: string; conversation_id: string }>
  subject(walletId: string): Promise<Subject>
  close(): Promise<void>
}

export async function startHarness(
  opts: {
    cfg?: Partial<GatewayConfig>
    hooks?: GatewayHooks
    routes?: Record<string, Route>
    /** Off unless a test asks for it, so no test posts to a made-up Halo address by accident. */
    dispatcher?: false | DispatcherOptions
    /** The sweeper that alerts for unacknowledged messages is off unless a test asks for it (`sweeper: true`). */
    delivery?: DeliveryOptions & { sweeper?: boolean }
    /** What the gateway fetches Halo's files with. */
    files?: FileServiceOptions
  } = {},
): Promise<Harness> {
  const db = await createTestDb()
  const cfg = testConfig(opts.cfg)
  const push = new MockPushAdapter()
  const gw = await startGateway({
    cfg,
    db,
    hooks: opts.hooks,
    routes: opts.routes,
    dispatcher: opts.dispatcher ?? false,
    push,
    delivery: { ...opts.delivery, sweeper: opts.delivery?.sweeper ?? false },
    files: opts.files,
    publicDir: join(MIGRATIONS, '..', 'public'),
  })
  const { workspace, sessionsKey } = await gw.store.createWorkspace(WORKSPACE)
  const url = `http://127.0.0.1:${gw.port}`
  return {
    gw,
    db,
    workspace,
    sessionsKey,
    push,
    url,
    async session(user = {}) {
      const res = await fetch(`${url}/v1/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionsKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ user: { wallet_id: 'W123', name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com', ...user } }),
      })
      if (res.status !== 201) throw new Error(`session failed: ${res.status} ${await res.text()}`)
      return (await res.json()) as { token: string; conversation_id: string }
    },
    async subject(walletId) {
      const s = await gw.store.findSubjectByWallet(workspace, walletId)
      if (!s) throw new Error('no such user')
      return s
    },
    async close() {
      await gw.close()
      await db.close()
    },
  }
}

export type Frame = Record<string, unknown> & { type: string }

/** A WebSocket client that remembers every frame it receives. */
export class TestClient {
  readonly frames: Frame[] = []
  closed: { code: number; reason: string } | null = null
  private readonly waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = []

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Frame
      this.frames.push(frame)
      for (const w of [...this.waiters]) {
        if (w.match(frame)) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          w.resolve(frame)
        }
      }
    })
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString('utf8') }
    })
  }

  static async connect(port: number, path = '/ws'): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return new TestClient(ws)
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame))
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data)
  }

  hello(token: string, extra: Record<string, unknown> = {}): void {
    this.send({ type: 'hello', v: 1, token, device_id: 'dev-1', app_version: '1.0.0', ...extra })
  }

  /** The next frame (already received or yet to arrive) of this type, or one matching the predicate. */
  next(type: string, match: (f: Frame) => boolean = () => true, timeoutMs = 5000): Promise<Frame> {
    const pick = (f: Frame) => f.type === type && match(f)
    const seen = this.frames.find(pick)
    if (seen) {
      this.frames.splice(this.frames.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for a "${type}" frame; got ${JSON.stringify(this.frames.map((f) => f.type))}`)), timeoutMs)
      this.waiters.push({
        match: pick,
        resolve: (f) => {
          clearTimeout(timer)
          this.frames.splice(this.frames.indexOf(f), 1)
          resolve(f)
        },
      })
    })
  }

  /** Wait for the connection to close and return how. */
  async untilClosed(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    const start = Date.now()
    while (!this.closed) {
      if (Date.now() - start > timeoutMs) throw new Error('the connection did not close')
      await new Promise((r) => setTimeout(r, 10))
    }
    return this.closed
  }

  close(): void {
    this.ws.close()
  }
}

/** Open a connection and complete hello with a fresh session; resolves with the client and its welcome. */
export async function connectUser(
  h: Harness,
  user: Parameters<Harness['session']>[0] = {},
  hello: Record<string, unknown> = {},
): Promise<{ client: TestClient; welcome: Frame }> {
  const { token } = await h.session(user)
  const client = await TestClient.connect(h.gw.port)
  client.hello(token, hello)
  const welcome = await client.next('welcome')
  return { client, welcome }
}

// ------------------------------------------------------------
// Files
// ------------------------------------------------------------

/** The smallest thing that passes for a PNG: the signature, then filler. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)])
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 9)])
export const OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(200, 3)])
export const PDF = Buffer.concat([Buffer.from('%PDF-1.4 test', 'latin1'), Buffer.alloc(60, 1)])

/** The settings of a gateway that may fetch from a local test server (http://127.0.0.1) as Halo's file address. */
export function allowLocalFetch(): Partial<GatewayConfig> {
  const base = testConfig()
  return { files: { ...base.files, allowInsecureFetch: true } }
}

export interface FileServer {
  url(path: string): string
  /** Requests received, per path. */
  hits: Record<string, number>
  close(): Promise<void>
}

/** A tiny HTTP server that plays "Halo's storage": serves what it is given, and counts requests. */
export async function startFileServer(files: Record<string, { status?: number; type?: string; body: Buffer }>): Promise<FileServer> {
  const hits: Record<string, number> = {}
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    hits[path] = (hits[path] ?? 0) + 1
    const f = files[path]
    if (!f) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(f.status ?? 200, { 'content-type': f.type ?? 'application/octet-stream', 'content-length': String(f.body.length) })
    res.end(f.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Ask for an upload slot over the socket and PUT the bytes to it, as the app does. */
export async function uploadFile(
  client: TestClient,
  f: { kind: string; mime: string; name?: string; bytes: Buffer; durationSeconds?: number },
  tweak: { contentType?: string; body?: Buffer } = {},
): Promise<{ slot: Frame; res: Response }> {
  client.send({ type: 'upload_request', request_id: `r-${Math.random()}`, kind: f.kind, file_name: f.name, mime_type: f.mime, size_bytes: f.bytes.length, duration_seconds: f.durationSeconds })
  const slot = await client.next('upload_slot')
  const res = await fetch(slot.upload_url as string, { method: 'PUT', headers: { 'content-type': tweak.contentType ?? f.mime }, body: (tweak.body ?? f.bytes) as never })
  return { slot, res }
}
