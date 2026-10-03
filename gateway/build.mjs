// Bundles the server and the operator CLI into dist/ (dependencies stay external: the image installs them).
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
