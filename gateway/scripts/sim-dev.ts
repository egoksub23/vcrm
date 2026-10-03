// ============================================================
// Run the gateway and the simulator on this machine, with no database to install and no Halo needed:
//
//   cd gateway && npm run sim
//
// It starts the gateway on an in-memory Postgres (PGlite), a stand-in for Halo that checks every
// event's signature and remembers event ids the way Halo does, and prints a link that opens the simulator.
// Open http://localhost:8090/launch for a fresh link at any time. Everything is forgotten when you stop it.
// ============================================================

import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'

import { startGateway } from '../src/app'
import { testConfig } from '../src/config'
import { migrate, type Db, type Queryable } from '../src/db'
import { signBody } from '../src/signing'
import { createLaunchToken } from '../src/simulator/token'

const here = dirname(fileURLToPath(import.meta.url))
const GATEWAY_PORT = Number(process.env.PORT || 8090)
const HALO_PORT = Number(process.env.FAKE_HALO_PORT || 8091)
const KEY = 'vcw_simulatorsimulator01'
const SECRET = 'vcs_local_simulator_secret'

async function main(): Promise<void> {
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
    exec: async (sql) => void (await pg.exec(sql)),
    close: () => pg.close(),
  }
  await migrate(db, join(here, '..', 'migrations'))

  // A stand-in for Halo's webhook: verifies the signature, answers a repeat of an event id with "duplicate".
  const seen = new Set<string>()
  createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const ts = String(req.headers['x-vircle-timestamp'] ?? '')
      const ok = req.headers['x-vircle-signature'] === signBody(SECRET, ts, raw) && Math.abs(Date.now() / 1000 - Number(ts)) < 300
      if (!ok) {
        res.writeHead(401).end(JSON.stringify({ error: 'Invalid signature' }))
        return
      }
      const event = JSON.parse(raw) as { event: string; event_id: string }
      const duplicate = seen.has(event.event_id)
      seen.add(event.event_id)
      console.log(`[fake halo] ${event.event}${duplicate ? ' (repeat, ignored)' : ''}`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(duplicate ? { ok: true, duplicate: true } : { ok: true }))
    })
  }).listen(HALO_PORT)

  const gw = await startGateway({
    // Links to files must name the host the browser used (localhost), or the page's own policy would block them.
    cfg: testConfig({ port: GATEWAY_PORT, simulator: { enabled: true }, files: { ...testConfig().files, publicBaseUrl: `http://localhost:${GATEWAY_PORT}` } }),
    db,
    publicDir: join(here, '..', 'public'),
    routes: {
      // Local convenience only: a fresh launch link, as Halo's "Open simulator" button would make.
      'GET /launch': async (_req, res) => {
        res.writeHead(302, { location: `/simulator#t=${createLaunchToken(SECRET, KEY)}` }).end()
      },
    },
  })
  await gw.store.createWorkspace({
    key: KEY,
    name: 'Local simulator',
    haloWebhookUrl: `http://localhost:${HALO_PORT}/api/vircle-chat/webhook`,
    signingSecret: SECRET,
    apiToken: 'vct_local_simulator_token',
  })

  console.log(`\nGateway:    http://localhost:${gw.port}`)
  console.log(`Fake Halo:  http://localhost:${HALO_PORT}`)
  console.log(`\nOpen the simulator:  http://localhost:${gw.port}/launch\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
