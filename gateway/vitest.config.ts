import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // PGlite starts an in-process Postgres per test file; run files one at a time to keep memory flat.
    fileParallelism: false,
  },
})
