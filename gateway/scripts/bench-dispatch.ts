// Where does the time go when the dispatcher sends events? Times every Store call during a drain of N events on a
// real Postgres, with an instant fake Halo. `npx tsx scripts/bench-dispatch.ts [events]`
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { testConfig } from '../src/config'
import { createPgDb, migrate } from '../src/db'
import { Dispatcher } from '../src/dispatcher'
import { Hub } from '../src/hub'
import { applySupportStatus } from '../src/receipts'
import { Store } from '../src/store'

const here = dirname(fileURLToPath(import.meta.url))
const N = Number(process.argv[2] || 2000)

async function main() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const dir = mkdtempSync(join(tmpdir(), 'gw-bench-'))
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: 54332, persistent: false, onLog: () => undefined, onError: () => undefined })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('gateway')
  const db = createPgDb('postgres://postgres:postgres@127.0.0.1:54332/gateway', { max: 20 })
  try {
    await migrate(db, join(here, '..', 'migrations'))
    const cfg = testConfig({ encryptionKey: 'ab'.repeat(32) })
    const store = new Store(db, cfg)
    const { workspace } = await store.createWorkspace({ key: 'vcw_benchbenchbench0001', name: 'b', haloWebhookUrl: 'http://127.0.0.1:1/x', signingSecret: 's', apiToken: 't' })

    // time every method of the store
    const timings = new Map<string, { n: number; ms: number }>()
    for (const name of Object.getOwnPropertyNames(Store.prototype)) {
      const fn = (store as never as Record<string, unknown>)[name]
      if (name === 'constructor' || typeof fn !== 'function') continue
      ;(store as never as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const t0 = performance.now()
        const out = (fn as (...a: unknown[]) => unknown).apply(store, args)
        if (!out || typeof (out as Promise<unknown>).then !== 'function') return out // a plain method: not timed
        return (out as Promise<unknown>).finally(() => {
          const t = timings.get(name) ?? { n: 0, ms: 0 }
          t.n++
          t.ms += performance.now() - t0
          timings.set(name, t)
        })
      }
    }

    const users = 1000
    for (let i = 0; i < users; i++) {
      const s = await store.upsertUser(workspace, { walletId: `B${i}`, name: 'u', phone: null, email: null })
      if (i < N) await store.appendInbound(s, { clientId: `c${i}`, type: 'text', text: 'hi' })
    }
    timings.clear()

    const hub = new Hub(3)
    const dispatcher = new Dispatcher(store, cfg, {
      fetch: (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch,
      log: () => undefined,
      onDispatched: async (event) => {
        const message = event.payload.message as { server_id?: string } | undefined
        const conversationId = event.payload.conversation_id
        if (!message?.server_id || typeof conversationId !== 'string') return
        const subject = await store.subjectByConversation(conversationId)
        if (subject) await applySupportStatus({ store, hub }, subject, [message.server_id], 'delivered')
      },
    })
    const t0 = performance.now()
    const r = await dispatcher.runOnce()
    const ms = performance.now() - t0
    console.log(`${r.sent} events in ${Math.round(ms)} ms = ${Math.round((r.sent / ms) * 1000)} events/s (instant Halo, ${cfg.dispatch.concurrency} lanes)`)
    console.table([...timings.entries()].map(([name, t]) => ({ call: name, calls: t.n, totalMs: Math.round(t.ms), avgMs: Math.round((t.ms / t.n) * 100) / 100 })))
  } finally {
    await db.close()
    await pg.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
