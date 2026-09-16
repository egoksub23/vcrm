// ============================================================
// Builds the embeddable web-chat widget (widget/src/*) into a single
// self-contained classic script, public/widget/loader.js.
//
// Run via `npm run build:widget`, and wired into `npm run build`
// ahead of `next build` so every deploy ships a current bundle. Reads
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY from
// process.env (already present in CI/Docker — see Dockerfile's
// builder stage ARGs) or, for local dev, from .env.local — and
// inlines them into the bundle via esbuild's `define`. There is no
// other way to hand them to the widget: it has to authenticate an
// anonymous Supabase session before it can call our own API at all.
// ============================================================
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function loadDotEnvLocal() {
  const path = resolve(root, '.env.local')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // Never override a value already set in the real environment
    // (Docker build args / CI secrets take precedence).
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnvLocal()

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[build-widget] NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set ' +
      '(via .env.local or the environment) to build the widget bundle.',
  )
  process.exit(1)
}

const watch = process.argv.includes('--watch')

const buildOptions = {
  entryPoints: [resolve(root, 'widget/src/main.tsx')],
  outfile: resolve(root, 'public/widget/loader.js'),
  bundle: true,
  format: 'iife',
  target: ['es2019'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: {
    __SUPABASE_URL__: JSON.stringify(supabaseUrl),
    __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
  },
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(buildOptions)
  await ctx.watch()
  console.log('[build-widget] watching for changes…')
} else {
  await esbuild.build(buildOptions)
  console.log('[build-widget] wrote public/widget/loader.js')
}
