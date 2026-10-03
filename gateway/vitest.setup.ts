// Before the tests: builds the generated browser bundle of the client library (the simulator page serves it),
// and, when TEST_PG=1, starts a real Postgres 16 (embedded-postgres) so the whole suite runs on the real `pg`
// driver instead of PGlite (`npm run test:pg`). Each test database is then a fresh database on that server.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export default async function setup(): Promise<(() => Promise<void>) | void> {
  const here = dirname(fileURLToPath(import.meta.url))
  execFileSync(process.execPath, [join(here, 'build.mjs')], { cwd: here, stdio: 'ignore' })

  if (process.env.TEST_PG !== '1') return
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const dir = mkdtempSync(join(tmpdir(), 'gw-testpg-'))
  const port = Number(process.env.TEST_PG_PORT || 54330)
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'max_connections=200', '-c', 'fsync=off', '-c', 'synchronous_commit=off'],
    onLog: () => undefined,
    onError: () => undefined,
  })
  await pg.initialise()
  await pg.start()
  process.env.TEST_PG_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`
  return async () => {
    await pg.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}
