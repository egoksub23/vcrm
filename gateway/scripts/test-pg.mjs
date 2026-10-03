// Runs the test suite on a real Postgres 16 instead of PGlite: `npm run test:pg [vitest args]`.
import { spawnSync } from 'node:child_process'

const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TEST_PG: '1' },
})
process.exit(r.status ?? 1)
