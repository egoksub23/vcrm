// ============================================================
// Entry point: read the settings, open the database, apply migrations, listen.
// On SIGTERM / SIGINT it closes every connection with the "service restart"
// code, so apps resume against the next instance instead of timing out.
// ============================================================

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGateway } from './app'
import { loadConfig } from './config'
import { createPgDb, migrate, requireUtf8 } from './db'
import { log } from './log'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const cfg = loadConfig()
  if (cfg.push.adapter === 'mock') {
    log.warn('PUSH_ADAPTER=mock: alerts are recorded, NOT sent. Users who are away will not be notified until the Vircle push adapter is configured.')
  }
  const db = createPgDb(cfg.databaseUrl, { max: cfg.dbPoolMax })
  if (!cfg.files.publicBaseUrl) log.warn('PUBLIC_BASE_URL is not set: links to files will point at this machine (127.0.0.1) and no one else can open them.')
  if (cfg.simulator.enabled) log.warn('SIMULATOR_ENABLED=true: /simulator is available to anyone Halo opens it for. Switch it off for a production launch.')
  await requireUtf8(db)
  const applied = await migrate(db, process.env.GATEWAY_MIGRATIONS_DIR || join(here, '..', 'migrations'))
  if (applied.length > 0) log.info('applied migrations', { migrations: applied })

  const gateway = await startGateway({ cfg, db, publicDir: process.env.GATEWAY_PUBLIC_DIR || join(here, '..', 'public') })
  log.info('listening', { port: gateway.port, ws_path: cfg.wsPath, retention_days: cfg.retention.days, push_adapter: cfg.push.adapter })

  const stop = async (signal: string) => {
    log.info('shutting down: closing connections', { signal })
    await gateway.close()
    await db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

main().catch((err) => {
  log.error('failed to start', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
