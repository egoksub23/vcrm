// ============================================================
// Load test for the gateway, on a real Postgres, through the same entry point production uses (dist/server.js).
//
//   cd gateway && npm run loadtest                     # 1,000 users, embedded Postgres 16 on this machine
//   npm run loadtest -- --users 2000 --idle 60 --halo-latency 250
//   LOADTEST_DATABASE_URL=postgres://... npm run loadtest      # an existing (empty or scratch) database
//   LOADTEST_GATEWAY_URL=https://chat.vircle.tech ...          # NOT supported on purpose: never load-test production
//
// What it does, in order, and what it measures:
//   1  connect      every user asks for a session (HTTP) and opens a socket: time until all are online
//   2  idle         all sockets sit idle: memory, event-loop lag, heartbeat behaviour
//   3  burst up     every user sends a message in the same instant: send-to-ack latency, then how long Halo takes to receive all events
//   4  burst down   Halo posts a message to every user in the same instant: HTTP time and time until the app has it
//   5  sustained    a steady rate of messages both ways for a while
//   6  push         a third of the users go offline; Halo writes to them (push path); they come back and resume
//   7  storm        the gateway is killed and restarted; every user reconnects at once and resumes
//
// A fake Halo (this process) accepts every event. The numbers are for THIS machine: the gateway and the load
// share it. Read them as "does it break, and where does it bend", then repeat on the server size you will run.
// ============================================================

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

import { testConfig } from '../src/config'
import { createPgDb, migrate } from '../src/db'
import { Store } from '../src/store'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}
const USERS = arg('users', 1000)
const IDLE_S = arg('idle', 20)
const SUSTAINED_S = arg('sustained', 20)
const SUSTAINED_RATE = arg('rate', 100) // messages per second, each way
const HALO_LATENCY_MS = arg('halo-latency', 100) // how long the pretend Halo takes to answer a webhook
const OFFLINE_SHARE = 0.33
const GATEWAY_PORT = arg('port', 18090)
const HALO_PORT = arg('halo-port', 18091)
const PG_PORT = arg('pg-port', 54331)
const ENC_KEY = 'ab'.repeat(32)
const KEY = 'vcw_loadtestloadtest01'
const SECRET = 'vcs_loadtest_secret'
const API_TOKEN = 'vct_loadtest_token'
const METRICS_TOKEN = 'mt_loadtest'
const BASE = `http://127.0.0.1:${GATEWAY_PORT}`

// ---------- small helpers ----------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const now = () => performance.now()

function pct(values: number[]) {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const v = [...values].sort((a, b) => a - b)
  const at = (p: number) => v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]!
  return { n: v.length, p50: Math.round(at(50)), p95: Math.round(at(95)), p99: Math.round(at(99)), max: Math.round(v[v.length - 1]!) }
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        await fn(items[i]!, i)
      }
    }),
  )
}

async function until(label: string, timeoutMs: number, cond: () => boolean): Promise<number> {
  const start = now()
  while (!cond()) {
    if (now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`)
    await sleep(20)
  }
  return now() - start
}

// ---------- the fake Halo ----------
let haloInbound = 0
let haloOther = 0
const haloServer = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c as Buffer))
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { event?: string }
      if (body.event === 'message.inbound') haloInbound++
      else haloOther++
    } catch {
      /* ignore */
    }
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'), HALO_LATENCY_MS)
  })
})

// ---------- the gateway as a child process ----------
let child: ChildProcess | null = null
let childLog = ''
function startGateway(databaseUrl: string): void {
  child = spawn(process.execPath, [join(here, '..', 'dist', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      DATABASE_URL: databaseUrl,
      GATEWAY_ENCRYPTION_KEY: ENC_KEY,
      METRICS_TOKEN,
      LOG_LEVEL: 'warn',
      PUSH_ADAPTER: 'mock',
      DB_POOL_MAX: String(process.env.DB_POOL_MAX || 20),
      SEND_RATE_LIMIT: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => (childLog += String(d)))
  child.stderr?.on('data', (d) => (childLog += String(d)))
}
async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) return
    } catch {
      /* not yet */
    }
    await sleep(100)
  }
  throw new Error('the gateway did not start:\n' + childLog)
}
function killGateway(): Promise<void> {
  return new Promise((resolve) => {
    if (!child) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

// ---------- metrics scraping ----------
interface Sample {
  rss: number
  loopP99: number
  poolWaiting: number
  poolConnections: number
  outboxOldest: number
  outboxPending: number
  connections: number
  cpu: number
}
async function scrape(): Promise<Sample | null> {
  try {
    const text = await (await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text()
    const g = (name: string) => Number(new RegExp(`^vircle_gateway_${name} (\\S+)$`, 'm').exec(text)?.[1] ?? 0)
    return {
      rss: g('process_rss_bytes'),
      loopP99: g('event_loop_lag_p99_seconds'),
      poolWaiting: g('db_pool_waiting'),
      poolConnections: g('db_pool_connections'),
      outboxOldest: g('outbox_oldest_seconds'),
      outboxPending: g('outbox_pending'),
      connections: g('connections'),
      cpu: g('process_cpu_seconds_total'),
    }
  } catch {
    return null
  }
}
const samples: Sample[] = []
let phaseMax: Sample | null = null
let sampler: NodeJS.Timeout | null = null
function startSampling(): void {
  sampler = setInterval(async () => {
    const s = await scrape()
    if (!s) return
    samples.push(s)
    phaseMax = phaseMax
      ? {
          rss: Math.max(phaseMax.rss, s.rss),
          loopP99: Math.max(phaseMax.loopP99, s.loopP99),
          poolWaiting: Math.max(phaseMax.poolWaiting, s.poolWaiting),
          poolConnections: Math.max(phaseMax.poolConnections, s.poolConnections),
          outboxOldest: Math.max(phaseMax.outboxOldest, s.outboxOldest),
          outboxPending: Math.max(phaseMax.outboxPending, s.outboxPending),
          connections: s.connections,
          cpu: s.cpu,
        }
      : { ...s }
  }, 1000)
}
function takePhaseMax(): Sample {
  const m = phaseMax ?? { rss: 0, loopP99: 0, poolWaiting: 0, poolConnections: 0, outboxOldest: 0, outboxPending: 0, connections: 0, cpu: 0 }
  phaseMax = null
  return m
}

// ---------- the pretend phones ----------
class Phone {
  ws: WebSocket | null = null
  online = false
  highSeq = 0
  deliveries = 0
  readonly acks = new Map<string, number>() // client_id -> time it was acknowledged
  readonly firstSeen = new Map<string, number>() // server message text -> arrival time
  closedWith: number | null = null
  constructor(
    readonly walletId: string,
    readonly sessionsKey: string,
  ) {}

  async session(): Promise<string> {
    const res = await fetch(`${BASE}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.sessionsKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user: { wallet_id: this.walletId, name: this.walletId, phone: '+60123456789' } }),
    })
    if (res.status !== 201) throw new Error(`session ${res.status}`)
    return ((await res.json()) as { token: string }).token
  }

  async connect(): Promise<void> {
    const token = await this.session()
    this.closedWith = null
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/ws`)
      this.ws = ws
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', v: 1, token, device_id: `load-${this.walletId}`, app_version: 'loadtest', last_seq: this.highSeq })))
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw)) as { type: string; client_id?: string; seq?: number; direction?: string; text?: string; server_id?: string }
        if (f.type === 'welcome') {
          this.online = true
          resolve()
        } else if (f.type === 'ack' && f.client_id) {
          this.acks.set(f.client_id, now())
        } else if (f.type === 'deliver') {
          if (typeof f.seq === 'number') this.highSeq = Math.max(this.highSeq, f.seq)
          if (f.direction === 'out') {
            this.deliveries++
            if (f.text && !this.firstSeen.has(f.text)) this.firstSeen.set(f.text, now())
            ws.send(JSON.stringify({ type: 'receipt', up_to_seq: f.seq, status: 'delivered' }))
          }
        }
      })
      ws.on('close', (code) => {
        this.online = false
        this.closedWith = code
        reject(new Error(`closed ${code} before welcome`))
      })
      ws.on('error', (err) => reject(err))
    })
  }

  /** Send a text; resolves with the time until the acknowledgement. */
  async send(text: string): Promise<number> {
    const clientId = `c_${this.walletId}_${Math.random().toString(36).slice(2)}`
    const t0 = now()
    this.ws!.send(JSON.stringify({ type: 'send', client_id: clientId, kind: 'text', text }))
    await until(`ack of ${clientId}`, 30_000, () => this.acks.has(clientId))
    return this.acks.get(clientId)! - t0
  }

  drop(): void {
    this.ws?.terminate()
    this.online = false
  }
}

async function haloPost(walletId: string, text: string): Promise<number> {
  const t0 = now()
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': `k_${walletId}_${text}` },
    body: JSON.stringify({ recipient: { wallet_id: walletId, name: walletId, phone: '+60123456789' }, type: 'text', text, sender: { name: 'Agent' } }),
  })
  if (res.status < 200 || res.status > 299) throw new Error(`halo post ${res.status} ${await res.text()}`)
  return now() - t0
}

// ---------- the run ----------
interface PhaseResult {
  phase: string
  seconds: number
  detail: Record<string, unknown>
  server: { cpuPercentOfOneCore: number; rssMb: number; loopP99Ms: number; poolWaitingMax: number; poolConnectionsMax: number; outboxOldestMaxS: number }
}
const results: PhaseResult[] = []
let lastCpu: { at: number; cpu: number } | null = null
function record(phase: string, startedAt: number, detail: Record<string, unknown>): void {
  const m = takePhaseMax()
  const prev = lastCpu
  lastCpu = { at: now(), cpu: m.cpu }
  const cpuPct = prev && m.cpu >= prev.cpu ? Math.round(((m.cpu - prev.cpu) / ((lastCpu.at - prev.at) / 1000)) * 100) : 0
  results.push({
    phase,
    seconds: Math.round(((now() - startedAt) / 1000) * 10) / 10,
    detail,
    server: { cpuPercentOfOneCore: cpuPct, rssMb: Math.round(m.rss / 1048576), loopP99Ms: Math.round(m.loopP99 * 1000), poolWaitingMax: m.poolWaiting, poolConnectionsMax: m.poolConnections, outboxOldestMaxS: Math.round(m.outboxOldest) },
  })
  console.log(`  ${phase}: ${JSON.stringify(detail)}`)
}

async function main(): Promise<void> {
  console.log(`Load test: ${USERS} users, idle ${IDLE_S}s, sustained ${SUSTAINED_RATE}/s for ${SUSTAINED_S}s, Halo answers in ${HALO_LATENCY_MS} ms`)
  let stopPg: (() => Promise<void>) | null = null
  let databaseUrl = process.env.LOADTEST_DATABASE_URL || ''
  if (!databaseUrl) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres')
    const dir = mkdtempSync(join(tmpdir(), 'gw-loadtest-'))
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'postgres',
      port: PG_PORT,
      persistent: false,
      postgresFlags: ['-c', 'max_connections=100'],
      onLog: () => undefined,
      onError: () => undefined,
    })
    await pg.initialise()
    await pg.start()
    await pg.createDatabase('gateway')
    databaseUrl = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/gateway`
    stopPg = async () => {
      await pg.stop()
      rmSync(dir, { recursive: true, force: true })
    }
    console.log('  Postgres 16 started (embedded)')
  }

  try {
    const setupDb = createPgDb(databaseUrl, { max: 2 })
    await migrate(setupDb, join(here, '..', 'migrations'))
    const store = new Store(setupDb, testConfig({ encryptionKey: ENC_KEY }))
    const { sessionsKey } = await store.createWorkspace({ key: KEY, name: 'Load test', haloWebhookUrl: `http://127.0.0.1:${HALO_PORT}/webhook`, signingSecret: SECRET, apiToken: API_TOKEN })
    await setupDb.close()
    await new Promise<void>((r) => haloServer.listen(HALO_PORT, r))

    startGateway(databaseUrl)
    await waitHealthy()
    startSampling()

    const phones = Array.from({ length: USERS }, (_, i) => new Phone(`LT${String(i).padStart(5, '0')}`, sessionsKey))

    // 1 connect
    let t = now()
    const connectTimes: number[] = []
    let failedConnects = 0
    await pool(phones, 100, async (p) => {
      const t0 = now()
      try {
        await p.connect()
        connectTimes.push(now() - t0)
      } catch {
        failedConnects++
      }
    })
    record('1 connect', t, { users: USERS, online: phones.filter((p) => p.online).length, failed: failedConnects, perUserMs: pct(connectTimes) })

    // 2 idle
    t = now()
    const before = phones.filter((p) => p.online).length
    await sleep(IDLE_S * 1000)
    record('2 idle', t, { seconds: IDLE_S, onlineBefore: before, onlineAfter: phones.filter((p) => p.online).length })

    // 3 burst up
    t = now()
    const haloBefore = haloInbound
    const online = phones.filter((p) => p.online)
    const ackTimes = await Promise.all(online.map((p) => p.send('burst-up')))
    const drain = await until('Halo to receive every burst-up event', 120_000, () => haloInbound - haloBefore >= online.length)
    record('3 burst up', t, { messages: online.length, sendToAckMs: pct(ackTimes), haloReceivedAllAfterMs: Math.round(drain) })

    // 4 burst down
    t = now()
    const postTimes: number[] = []
    const postStart = now()
    await pool(online, 200, async (p) => {
      postTimes.push(await haloPost(p.walletId, 'burst-down'))
    })
    await until('every phone to get burst-down', 60_000, () => online.every((p) => p.firstSeen.has('burst-down')))
    const arrival = online.map((p) => p.firstSeen.get('burst-down')! - postStart)
    record('4 burst down', t, { messages: online.length, haloPostMs: pct(postTimes), postStartToAppMs: pct(arrival) })

    // 5 sustained
    t = now()
    const sustainedAck: number[] = []
    const sustainedPost: number[] = []
    const total = SUSTAINED_RATE * SUSTAINED_S
    const pending: Promise<void>[] = []
    for (let i = 0; i < total; i++) {
      const p = online[i % online.length]!
      pending.push(
        (i % 2 === 0
          ? p.send(`s-up-${i}`).then((ms) => void sustainedAck.push(ms))
          : haloPost(p.walletId, `s-down-${i}`).then((ms) => void sustainedPost.push(ms))
        ).catch(() => undefined),
      )
      if (i % SUSTAINED_RATE === SUSTAINED_RATE - 1) await sleep(1000)
    }
    await Promise.all(pending)
    record('5 sustained', t, { ratePerSecond: SUSTAINED_RATE, seconds: SUSTAINED_S, sendToAckMs: pct(sustainedAck), haloPostMs: pct(sustainedPost) })

    // 6 push
    t = now()
    const offline = online.slice(0, Math.round(USERS * OFFLINE_SHARE))
    offline.forEach((p) => p.drop())
    await sleep(500)
    await pool(offline, 100, async (p) => void (await haloPost(p.walletId, 'while-away')))
    await sleep(2500)
    const metricsText = await (await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text()
    const pushSent = Number(/^vircle_gateway_push_sent_1h (\S+)$/m.exec(metricsText)?.[1] ?? 0)
    const resumeTimes: number[] = []
    await pool(offline, 100, async (p) => {
      const t0 = now()
      await p.connect()
      await until('replay', 30_000, () => p.firstSeen.has('while-away'))
      resumeTimes.push(now() - t0)
    })
    record('6 push', t, { wentOffline: offline.length, pushAlertsRecorded: pushSent, reconnectAndReplayMs: pct(resumeTimes), allGotTheirMessage: offline.every((p) => p.firstSeen.has('while-away')) })

    // 7 storm
    t = now()
    await killGateway()
    phones.forEach((p) => (p.online = false))
    await sleep(500)
    startGateway(databaseUrl)
    await waitHealthy()
    const restarted = now()
    const stormTimes: number[] = []
    let stormFailed = 0
    await pool(phones, 200, async (p) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await p.connect()
          stormTimes.push(now() - restarted)
          return
        } catch {
          await sleep(200 + Math.random() * 500)
        }
      }
      stormFailed++
    })
    record('7 storm', t, { users: USERS, backOnline: phones.filter((p) => p.online).length, failed: stormFailed, restartToOnlineMs: pct(stormTimes) })

    phones.forEach((p) => p.drop())
    await sleep(500)
  } finally {
    if (sampler) clearInterval(sampler)
    await killGateway()
    haloServer.close()
    if (stopPg) await stopPg()
  }

  const outFile = join(here, '..', 'loadtest-result.json')
  writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), users: USERS, node: process.version, platform: process.platform, results, haloInbound, outboxPendingTimeline: samples.filter((_, i) => i % 5 === 0).map((x) => x.outboxPending), rssTimelineMb: samples.filter((_, i) => i % 5 === 0).map((x) => Math.round(x.rss / 1048576)), gatewayLog: childLog.split('\n').slice(-30).join('\n') }, null, 2))
  console.log(`\nWrote ${outFile}`)
  console.table(results.map((r) => ({ phase: r.phase, seconds: r.seconds, cpuPct: r.server.cpuPercentOfOneCore, rssMb: r.server.rssMb, loopP99Ms: r.server.loopP99Ms, poolWaitMax: r.server.poolWaitingMax, poolConnMax: r.server.poolConnectionsMax, outboxOldestS: r.server.outboxOldestMaxS })))
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('LOAD TEST FAILED:', err instanceof Error ? err.message : err)
    console.error(childLog.split('\n').slice(-30).join('\n'))
    void killGateway().finally(() => process.exit(1))
  },
)
