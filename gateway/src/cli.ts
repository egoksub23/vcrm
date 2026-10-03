// ============================================================
// Operator commands for the gateway, run on the server next to it:
//
//   npm run cli -- create-workspace --key vcw_... --name "Vircle" --halo-url https://halo.example.com/api/vircle-chat/webhook
//   npm run cli -- update-workspace --key vcw_... [--halo-url ...] [--name ...]
//   npm run cli -- rotate-sessions-key --key vcw_...
//   npm run cli -- list-workspaces
//   npm run cli -- delete-workspace --key vcw_... --yes
//   npm run cli -- outbox [--key vcw_...]            what is waiting for Halo, and what was given up on
//   npm run cli -- retry-failed [--key vcw_...]      put given-up events back in the queue
//
// The two secrets Halo generates (Settings, Channels, Vircle Chat) are read from the environment
// (HALO_SIGNING_SECRET, HALO_API_TOKEN) so they stay out of the shell history; the flags
// --signing-secret and --api-token also work.
// Needs DATABASE_URL and GATEWAY_ENCRYPTION_KEY, like the server.
// ============================================================

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from './config'
import { createPgDb, migrate } from './db'
import { Store } from './store'

const here = dirname(fileURLToPath(import.meta.url))

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`)
    if (a === '--yes') {
      flags.yes = 'true' // a switch, not a value
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`)
    flags[a.slice(2)] = value
    i++
  }
  return flags
}

const need = (flags: Record<string, string>, name: string): string => {
  const v = flags[name]
  if (!v) throw new Error(`--${name} is required`)
  return v
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  const cfg = loadConfig()
  const db = createPgDb(cfg.databaseUrl, { max: 2 })
  try {
    await migrate(db, process.env.GATEWAY_MIGRATIONS_DIR || join(here, '..', 'migrations'))
    const store = new Store(db, cfg)
    const secrets = () => ({
      signingSecret: flags['signing-secret'] ?? process.env.HALO_SIGNING_SECRET,
      apiToken: flags['api-token'] ?? process.env.HALO_API_TOKEN,
    })

    switch (command) {
      case 'create-workspace': {
        const { signingSecret, apiToken } = secrets()
        if (!signingSecret || !apiToken) throw new Error('Set HALO_SIGNING_SECRET and HALO_API_TOKEN (shown once in Halo when the connection was created)')
        const { workspace, sessionsKey } = await store.createWorkspace({
          key: need(flags, 'key'),
          name: need(flags, 'name'),
          haloWebhookUrl: need(flags, 'halo-url'),
          signingSecret,
          apiToken,
        })
        console.log(`Workspace ${workspace.workspace_key} created.`)
        console.log('')
        console.log('Sessions key (give it to the Vircle backend; it is shown only now):')
        console.log(`  ${sessionsKey}`)
        break
      }
      case 'update-workspace': {
        const { signingSecret, apiToken } = secrets()
        const w = await store.updateWorkspace(need(flags, 'key'), {
          haloWebhookUrl: flags['halo-url'],
          name: flags.name,
          signingSecret,
          apiToken,
        })
        console.log(`Workspace ${w.workspace_key} updated.`)
        break
      }
      case 'rotate-sessions-key': {
        const key = await store.rotateSessionsKey(need(flags, 'key'))
        console.log('New sessions key (the old one no longer works; shown only now):')
        console.log(`  ${key}`)
        break
      }
      case 'delete-workspace': {
        // For a workspace whose Halo workspace has been deleted: removes its users, messages and files here too.
        if (flags.yes !== 'true') throw new Error('Add --yes to confirm: this removes the workspace and every message, file and user in it, and cannot be undone')
        const r = await store.deleteWorkspace(need(flags, 'key'))
        console.log(`Workspace removed: ${r.users} user(s), ${r.messages} message(s) and ${r.files} file(s) deleted.`)
        break
      }
      case 'list-workspaces': {
        for (const w of await store.listWorkspaces()) console.log(`${w.workspace_key}  ${w.name}  ${w.halo_webhook_url}`)
        break
      }
      case 'outbox': {
        const stats = await store.outboxStats()
        console.log(`Waiting for Halo: ${stats.pending}${stats.oldestPendingAt ? ` (oldest ${stats.oldestPendingAt})` : ''}`)
        console.log(`Given up on: ${stats.failed}`)
        for (const e of await store.failedEvents(flags.key ?? null, 20)) console.log(`  ${e.id}  ${e.kind}  ${e.last_error ?? ''}`)
        break
      }
      case 'retry-failed': {
        const n = await store.requeueFailed(flags.key ?? null)
        console.log(`${n} event(s) put back in the queue.`)
        break
      }
      default:
        console.log('Commands: create-workspace, update-workspace, rotate-sessions-key, delete-workspace, list-workspaces, outbox, retry-failed')
        process.exitCode = command ? 1 : 0
    }
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
