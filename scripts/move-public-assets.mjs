// ============================================================
// Copies the files that must stay public out of `chat-media` and into
// `public-assets`, ahead of migration 146 (which makes chat-media private).
//
//   * knowledge-base images and attachments:   account-<id>/kb/...
//   * workspace logos:                          account-<id>/brand/...
//   * WhatsApp template header samples: whatever file each
//     message_templates.header_media_url points at in chat-media
//
// It COPIES (originals stay in chat-media until you delete them) and is safe
// to re-run: a file already present in public-assets is skipped. Migration
// 146 refuses to run while any of these files has no copy.
//
//   node scripts/move-public-assets.mjs            dry run: lists what it would copy
//   node scripts/move-public-assets.mjs --apply    copies
//
// Needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY
// in the environment, or in .env.local.
// ============================================================
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apply = process.argv.includes('--apply')

function loadDotEnvLocal() {
  const p = resolve(root, '.env.local')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadDotEnvLocal()

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const SRC = 'chat-media'
const DST = 'public-assets'
const db = createClient(url, key, { auth: { persistSession: false } })

/** Every object path under `prefix` (recursive; Storage lists one level at a time). */
async function listAll(prefix) {
  const out = []
  let offset = 0
  for (;;) {
    const { data, error } = await db.storage.from(SRC).list(prefix, { limit: 100, offset })
    if (error) throw new Error(`list ${prefix}: ${error.message}`)
    if (!data || data.length === 0) break
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.id === null) out.push(...(await listAll(path))) // a folder
      else out.push(path)
    }
    if (data.length < 100) break
    offset += 100
  }
  return out
}

async function accountFolders() {
  const names = []
  let offset = 0
  for (;;) {
    const { data, error } = await db.storage.from(SRC).list('', { limit: 100, offset })
    if (error) throw new Error(`list root: ${error.message}`)
    if (!data || data.length === 0) break
    for (const e of data) if (e.id === null && e.name.startsWith('account-')) names.push(e.name)
    if (data.length < 100) break
    offset += 100
  }
  return names
}

async function templateHeaderPaths() {
  const { data, error } = await db
    .from('message_templates')
    .select('header_media_url')
    .like('header_media_url', '%/storage/v1/object/public/chat-media/%')
  if (error) throw new Error(`message_templates: ${error.message}`)
  const paths = []
  for (const row of data ?? []) {
    const m = /\/storage\/v1\/object\/public\/chat-media\/([^?#]+)/.exec(row.header_media_url)
    if (m) paths.push(decodeURIComponent(m[1]))
  }
  return paths
}

async function exists(path) {
  const slash = path.lastIndexOf('/')
  const { data, error } = await db.storage.from(DST).list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 5 })
  if (error) return false
  return (data ?? []).some((e) => e.name === path.slice(slash + 1))
}

const wanted = new Set()
for (const folder of await accountFolders()) {
  for (const sub of ['kb', 'brand']) for (const p of await listAll(`${folder}/${sub}`)) wanted.add(p)
}
for (const p of await templateHeaderPaths()) wanted.add(p)

let copied = 0
let skipped = 0
let failed = 0
for (const path of [...wanted].sort()) {
  if (await exists(path)) {
    skipped++
    console.log(`skip     ${path} (already in ${DST})`)
    continue
  }
  if (!apply) {
    console.log(`would copy ${path}`)
    continue
  }
  const { error } = await db.storage.from(SRC).copy(path, path, { destinationBucket: DST })
  if (error) {
    failed++
    console.error(`FAILED   ${path}: ${error.message}`)
  } else {
    copied++
    console.log(`copied   ${path}`)
  }
}
console.log(
  `\n${wanted.size} file(s) must be public. ${apply ? `${copied} copied, ` : ''}${skipped} already there${failed ? `, ${failed} FAILED` : ''}.` +
    (apply ? '' : ' Dry run: add --apply to copy.'),
)
process.exit(failed ? 1 : 0)
