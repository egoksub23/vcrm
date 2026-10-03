// ============================================================
// Entry point: read the settings, open the database, apply migrations, listen.
// On SIGTERM / SIGINT it closes every connection with the "service restart"
// code, so apps resume against the next instance instead of timing out.
// ============================================================

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGateway } from './app'
import { loadConfig } from './config'
import { createPgDb, migrate } from './db'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const cfg = loadConfig()
  if (cfg.push.adapter === 'mock') {
    console.warn('[gateway] PUSH_ADAPTER=mock: alerts are recorded, NOT sent. Users who are away will not be notified until the Vircle push adapter is configured.')
  }
  const db = createPgDb(cfg.databaseUrl)
  const applied = await migrate(db, process.env.GATEWAY_MIGRATIONS_DIR || join(here, '..', 'migrations'))
  if (applied.length > 0) console.log(`[gateway] applied migrations: ${applied.join(', ')}`)

  const gateway = await startGateway({ cfg, db })
  console.log(`[gateway] listening on port ${gateway.port}, app connects at ${cfg.wsPath}`)

  const stop = async (signal: string) => {
    console.log(`[gateway] ${signal}: closing connections`)
    await gateway.close()
    await db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

main().catch((err) => {
  console.error('[gateway] failed to start:', err instanceof Error ? err.message : err)
  process.exit(1)
})
