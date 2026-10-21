// Builds the package handed to the front-end team that builds the Vircle Chat screen in the Ionic app:
//
//   node scripts/build-app-kit.mjs          writes docs/app-kit/vircle-chat-app-kit.zip
//
// Inside: the design document (.docx, pictures embedded), the protocol note, the client library (the package to install, plus its
// TypeScript source), the exact frame definitions, the emoji list, the reference screens, and a copy of the simulator that runs on
// a computer with no server and no Halo (`npm install && npm run sim`). Nothing secret goes in: no environment files, no keys.
//
// The zip is generated, so it is git-ignored; run this again after any change to the documents, the library or the simulator.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')
const gw = join(root, 'gateway')
const kit = join(docs, 'app-kit')
const OUT = join(kit, 'vircle-chat-app-kit.zip')

/** @type {Record<string, Uint8Array>} */
const files = {}
const put = (zipPath, data) => {
  files[zipPath] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
}
const putFile = (zipPath, abs) => {
  if (!existsSync(abs)) throw new Error(`missing: ${relative(root, abs)}`)
  put(zipPath, readFileSync(abs))
}
/** Every file under `dir` (relative paths), skipping anything that must not travel. */
function walk(dir, skip = () => false) {
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = relative(gw, abs).split(sep).join('/')
    if (skip(rel, name)) continue
    if (statSync(abs).isDirectory()) out.push(...walk(abs, skip))
    else out.push(abs)
  }
  return out
}

// 1. The design document: rebuilt from its source so the pictures and the text are current.
try {
  execFileSync('pandoc', [join(docs, 'vircle-chat-app-design.md'), '--resource-path', docs, '-o', join(docs, 'vircle-chat-app-design.docx')], { stdio: 'inherit' })
} catch {
  console.warn('pandoc not found: using the .docx as it is on disk (it may be older than the .md)')
}
putFile('docs/vircle-chat-app-design.docx', join(docs, 'vircle-chat-app-design.docx'))
putFile('docs/vircle-chat-app-build-spec.md', join(docs, 'vircle-chat-app-build-spec.md'))
putFile('docs/vircle-chat-app-protocol.md', join(docs, 'vircle-chat-app-protocol.md'))

// 2. The library: the package to install, and its source.
const clientPkg = JSON.parse(readFileSync(join(gw, 'client', 'package.json'), 'utf8'))
const tgz = `vircle-chat-client-${clientPkg.version}.tgz`
putFile(`library/${tgz}`, join(kit, tgz))
putFile('library/README.md', join(gw, 'client', 'README.md'))
for (const name of readdirSync(join(gw, 'client', 'src'))) putFile(`library/src/${name}`, join(gw, 'client', 'src', name))

// 3. The wire format, the emoji list and the reference screens.
putFile('protocol/protocol.ts', join(gw, 'src', 'protocol.ts'))
putFile('emoji/emoji.js', join(kit, 'emoji.js'))
for (const name of readdirSync(join(kit, 'screens'))) putFile(`screens/${name}`, join(kit, 'screens', name))

// 4. The simulator: the gateway's own source, with the test machinery and the generated and private files left out.
const skip = (rel, name) =>
  name === 'node_modules' || name === 'dist' || name === 'test' || name === 'Dockerfile' || name === 'package-lock.json' ||
  name.startsWith('.env') || name === 'vitest.config.ts' || name === 'vitest.setup.ts' ||
  rel === 'public/vircle-chat-client.js' || rel === 'client/dist' || rel === 'client/test' ||
  /^scripts\/(loadtest|test-pg|bench-dispatch)/.test(rel)
for (const abs of walk(gw, skip)) putFile(`simulator/${relative(gw, abs).split(sep).join('/')}`, abs)

// The simulator's package.json: only what `npm run sim` needs (no test runner, no embedded Postgres).
const gwPkg = JSON.parse(readFileSync(join(gw, 'package.json'), 'utf8'))
const keep = ['pg', 'ws', '@electric-sql/pglite', '@types/node', '@types/pg', '@types/ws', 'esbuild', 'tsx', 'typescript']
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => keep.includes(k)))
put(
  'simulator/package.json',
  JSON.stringify(
    {
      name: 'vircle-chat-simulator',
      version: gwPkg.version,
      private: true,
      description: 'A pretend phone and agent console for the Vircle Chat gateway. Run: npm install && npm run sim',
      type: 'module',
      engines: gwPkg.engines,
      scripts: { sim: gwPkg.scripts.sim, build: gwPkg.scripts.build },
      dependencies: pick(gwPkg.dependencies),
      devDependencies: pick(gwPkg.devDependencies),
    },
    null,
    2,
  ) + '\n',
)

put(
  'README.txt',
  `Vircle Chat: kit for the Vircle app front-end team
===================================================

Start with docs/vircle-chat-app-design.docx. It says what to build, what is decided, and what you must ask others for.
Then docs/vircle-chat-app-build-spec.md: HOW to build it (architecture, interfaces, algorithms, tasks with acceptance criteria, testing).
Give that file, and this whole kit, to the coding agent that does the work.

docs/vircle-chat-app-protocol.md   what travels between the app and the gateway (you rarely need it: the library does it)
library/                           ${tgz} is the package to install (npm install ./${tgz}); src/ is its TypeScript source; README.md is the API reference
protocol/protocol.ts               the exact frame definitions
emoji/emoji.js                     the emoji list the web chat widget uses (1,914 emoji with search words)
screens/                           the reference screens (behaviour, not the visual design)
simulator/                         a pretend phone and an agent console, built on the same library

Run the simulator (Node 20 or later, no server, no database, no Halo needed):

    cd simulator
    npm install
    npm run sim
    open http://localhost:8090/launch

A script can play the support agent against it (scripts/sim-agent.mjs); with the simulator running, this checks the setup end to end:

    node scripts/sim-agent-selftest.mjs

No secret is in this kit and none belongs in the app. The one secret the chat needs (the "sessions key") lives only on the Vircle backend.
`,
)

const zip = zipSync(files, { level: 9, mtime: new Date('2026-10-21T00:00:00Z') })
writeFileSync(OUT, zip)
console.log(`wrote ${relative(root, OUT)}: ${Object.keys(files).length} files, ${(zip.length / 1024).toFixed(0)} KB`)
