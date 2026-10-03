import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // test/contract-halo.test.ts runs Halo's own client and parsers (../src) against this gateway.
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // PGlite starts an in-process Postgres per test file; run files one at a time to keep memory flat.
    fileParallelism: false,
  },
})
