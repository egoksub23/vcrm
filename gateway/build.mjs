// Builds everything that is generated:
//   dist/server.js, dist/cli.js            the server and the operator CLI (dependencies stay external: the image installs them)
//   public/vircle-chat-client.js           the client library as one script for the simulator page (global `VircleChat`)
//   client/dist/index.js (+ .d.ts)         the client library for the app (ES module; run `npm run build:client` for the types too)
import { build } from 'esbuild'

await build({
  entryPoints: { server: 'src/server.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
})

await build({
  entryPoints: ['client/src/index.ts'],
  outfile: 'public/vircle-chat-client.js',
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  globalName: 'VircleChat',
  logLevel: 'info',
})

await build({
  entryPoints: ['client/src/index.ts'],
  outfile: 'client/dist/index.js',
  bundle: true,
  platform: 'neutral',
  target: 'es2020',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
})
