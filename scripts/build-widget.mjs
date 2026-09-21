// ============================================================
// Builds the embeddable web-chat widget (widget/src/*) into
// self-contained classic scripts under public/widget/:
//   loader.js    the core widget (what customers embed)
//   recorder.js  Ogg/Opus voice-note encoder (opus-recorder + its worker),
//                loaded lazily from the API origin on first mic tap
//   emoji.js     a slim emoji dataset built from emojibase-data, loaded
//                lazily from the API origin on first picker open
// The two lazy files are never fetched from a CDN, so a host page that
// already allows loader.js needs no extra CSP entries.
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
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
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
const outDir = resolve(root, 'public/widget')
mkdirSync(outDir, { recursive: true })

// Cache-buster for the lazy scripts (they sit behind a short CDN cache).
const buildId = Date.now().toString(36)

const common = {
  bundle: true,
  // Plain-ASCII output (non-ASCII escaped as \uXXXX): the scripts are served
  // as static files, and a host or CDN that omits `charset=utf-8` would
  // otherwise mangle the Malay/Mandarin strings and emoji.
  charset: 'ascii',
  format: 'iife',
  target: ['es2019'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'info',
}

const loaderOptions = {
  ...common,
  entryPoints: [resolve(root, 'widget/src/main.tsx')],
  outfile: resolve(outDir, 'loader.js'),
  define: {
    __SUPABASE_URL__: JSON.stringify(supabaseUrl),
    __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
    __WIDGET_BUILD__: JSON.stringify(buildId),
  },
}

// The encoder worker is inlined as text and started from a blob: URL —
// a Worker cannot be created from another origin's URL, and the widget
// runs on the HOST page's origin. Same file the CRM composer serves
// from /opus/encoderWorker.min.js.
const opusWorkerPath = resolve(root, 'public/opus/encoderWorker.min.js')
if (!existsSync(opusWorkerPath)) {
  console.error('[build-widget] public/opus/encoderWorker.min.js is missing (needed for voice notes).')
  process.exit(1)
}
const recorderOptions = {
  ...common,
  entryPoints: [resolve(root, 'widget/src/recorder-chunk.ts')],
  outfile: resolve(outDir, 'recorder.js'),
  define: {
    __OPUS_WORKER_SOURCE__: JSON.stringify(readFileSync(opusWorkerPath, 'utf8')),
  },
}

// ---- emoji dataset (public/widget/emoji.js) ----
// Emojibase group number -> picker category (mirrors src/lib/emoji/build.ts;
// group 2 is skin-tone swatches, and regional indicators carry no group).
const EMOJI_GROUPS = {
  0: 'smileys',
  1: 'people',
  3: 'animals',
  4: 'food',
  5: 'travel',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
}
const EMOJI_ORDER = ['smileys', 'people', 'animals', 'food', 'travel', 'activities', 'objects', 'symbols', 'flags']

function buildEmojiScript() {
  const compact = JSON.parse(
    readFileSync(resolve(root, 'node_modules/emojibase-data/en/compact.json'), 'utf8'),
  )
  const byGroup = new Map(EMOJI_ORDER.map((k) => [k, []]))
  for (const e of compact) {
    const key = EMOJI_GROUPS[e.group]
    if (!key) continue
    // Base glyph only (skin-tone variants are left out to keep this small).
    const keywords = [e.label, ...(e.tags ?? [])].join(' ').toLowerCase()
    byGroup.get(key).push({ order: e.order ?? 0, item: [e.unicode, keywords] })
  }
  const groups = EMOJI_ORDER.map((key) => ({
    key,
    items: byGroup.get(key).sort((a, b) => a.order - b.order).map((x) => x.item),
  })).filter((g) => g.items.length > 0)
  return (
    '(function(){var w=window;w.__vircleWidgetLazy=w.__vircleWidgetLazy||{};' +
    'w.__vircleWidgetLazy.emoji=' +
    JSON.stringify({ groups }).replace(
      /[-￿]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    ) +
    ';})();'
  )
}

function writeEmojiScript() {
  const out = resolve(outDir, 'emoji.js')
  writeFileSync(out, buildEmojiScript(), 'utf8')
  console.log('[build-widget] wrote public/widget/emoji.js')
}

function report() {
  for (const name of ['loader.js', 'recorder.js', 'emoji.js']) {
    const path = resolve(outDir, name)
    if (!existsSync(path)) continue
    const size = statSync(path).size
    const gz = gzipSync(readFileSync(path)).length
    console.log(
      `[build-widget] ${name.padEnd(12)} ${(size / 1024).toFixed(1).padStart(8)} KB   gzip ${(gz / 1024).toFixed(1).padStart(7)} KB`,
    )
  }
}

if (watch) {
  const loaderCtx = await esbuild.context(loaderOptions)
  const recorderCtx = await esbuild.context(recorderOptions)
  await Promise.all([loaderCtx.watch(), recorderCtx.watch()])
  writeEmojiScript()
  console.log('[build-widget] watching for changes…')
} else {
  await Promise.all([esbuild.build(loaderOptions), esbuild.build(recorderOptions)])
  writeEmojiScript()
  console.log('[build-widget] wrote public/widget/loader.js and recorder.js')
  report()
}
