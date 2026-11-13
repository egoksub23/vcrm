// How much each workspace has stored, for the daily usage job (migration 232).
//
// Every workspace keeps its files under an `account-<uuid>/` folder at the top of
// each bucket, whichever store is in use:
//   STORAGE_PROVIDER=filesystem  <STORAGE_FILEPATH>/<bucket>/account-<uuid>/...
//   STORAGE_PROVIDER=minio       <bucket>/account-<uuid>/...
// This adds up the bytes per workspace in one pass and returns { "<uuid>": bytes }.
// A workspace with no files is simply absent. Errors are thrown so the caller can
// tell "could not measure" (keep yesterday's figure) from "measured, nothing there".

import { promises as fs } from 'fs'
import path from 'path'

import { getMinioClient } from './provider'

const ACCOUNT_FOLDER = /^account-([0-9a-f-]{36})$/

/** The workspace id a stored object belongs to, from its path inside a bucket. */
export function accountOfPath(name: string): string | null {
  const m = /^account-([0-9a-f-]{36})\//.exec(name)
  return m ? m[1] : null
}

/** Total size of every regular file below `dir`. Symbolic links are not followed. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop() as string
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue // removed while we were counting
    }
    const files: string[] = []
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) pending.push(full)
      else if (e.isFile()) files.push(full)
    }
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(
        files.slice(i, i + 64).map((f) => fs.stat(f).then((s) => s.size, () => 0)),
      )
      for (const s of sizes) total += s
    }
  }
  return total
}

async function measureFilesystem(): Promise<Record<string, number>> {
  const base = (process.env.STORAGE_FILEPATH ?? '/app/storage').replace(/\/$/, '')
  const out: Record<string, number> = {}
  for (const bucket of await fs.readdir(base, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bucketDir = path.join(base, bucket.name)
    for (const folder of await fs.readdir(bucketDir, { withFileTypes: true })) {
      const m = folder.isDirectory() ? ACCOUNT_FOLDER.exec(folder.name) : null
      if (!m) continue
      out[m[1]] = (out[m[1]] ?? 0) + (await folderBytes(path.join(bucketDir, folder.name)))
    }
  }
  return out
}

async function measureMinio(): Promise<Record<string, number>> {
  const client = getMinioClient()
  const out: Record<string, number> = {}
  for (const bucket of await client.listBuckets()) {
    await new Promise<void>((resolve, reject) => {
      const stream = client.listObjectsV2(bucket.name, 'account-', true)
      stream.on('data', (o) => {
        const id = o.name ? accountOfPath(o.name) : null
        if (id) out[id] = (out[id] ?? 0) + (o.size ?? 0)
      })
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
  }
  return out
}

/** Bytes stored per workspace id, from whichever store STORAGE_PROVIDER names. */
export async function measureAccountStorage(): Promise<Record<string, number>> {
  if (process.env.STORAGE_PROVIDER === 'minio') return measureMinio()
  if (process.env.STORAGE_PROVIDER === 'filesystem') return measureFilesystem()
  throw new Error('Set STORAGE_PROVIDER=filesystem (or minio) in .env.local')
}
