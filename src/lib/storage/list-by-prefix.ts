// Every stored file under a path prefix, across all buckets.
//
// Used by the workspace export (all of a workspace's files) and the workspace
// deletion (remove them). It replaces the database function
// storage_objects_by_prefix (migration 153), which read Supabase's storage.objects:
// that table does not exist on our own server, so both jobs failed.
//
//   STORAGE_PROVIDER=filesystem  walks <STORAGE_FILEPATH>/<bucket>/<prefix...>
//   STORAGE_PROVIDER=minio       lists each bucket by prefix
//
// The prefix must be a workspace folder ("account-<uuid>/") or a person's folder
// ("<uuid>/"): anything shorter than that is refused, so a mistake can never list
// (and so never delete) a whole bucket. Results are sorted by bucket, then name.

import { promises as fs } from 'fs'
import path from 'path'

import { getMinioClient } from './provider'

export interface StoredObject {
  bucket: string
  name: string
}

/** "<uuid>/" is the shortest folder we ever list. */
const MIN_PREFIX = 37

const byBucketThenName = (a: StoredObject, b: StoredObject) =>
  a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0

async function listFilesystem(prefix: string): Promise<StoredObject[]> {
  const base = (process.env.STORAGE_FILEPATH ?? '/app/storage').replace(/\/$/, '')
  const startFolder = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
  let buckets
  try {
    buckets = await fs.readdir(base, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] // nothing has ever been stored
    throw err
  }
  const out: StoredObject[] = []
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const pending = [startFolder]
    while (pending.length > 0) {
      const rel = pending.pop() as string
      let entries
      try {
        entries = await fs.readdir(path.join(base, bucket.name, ...rel.split('/').filter(Boolean)), {
          withFileTypes: true,
        })
      } catch {
        continue // this bucket has no such folder
      }
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) pending.push(child)
        else if (e.isFile() && child.startsWith(prefix)) out.push({ bucket: bucket.name, name: child })
      }
    }
  }
  return out
}

async function listMinio(prefix: string): Promise<StoredObject[]> {
  const client = getMinioClient()
  const out: StoredObject[] = []
  for (const bucket of await client.listBuckets()) {
    await new Promise<void>((resolve, reject) => {
      const stream = client.listObjectsV2(bucket.name, prefix, true)
      stream.on('data', (o) => {
        if (o.name) out.push({ bucket: bucket.name, name: o.name })
      })
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
  }
  return out
}

/** All files whose path starts with `prefix`, in every bucket. */
export async function listObjectsByPrefix(prefix: string): Promise<StoredObject[]> {
  if (prefix.length < MIN_PREFIX || prefix.startsWith('/') || prefix.split('/').includes('..')) {
    throw new Error('listObjectsByPrefix: refusing a prefix that is not a workspace or person folder')
  }
  let found: StoredObject[]
  if (process.env.STORAGE_PROVIDER === 'minio') found = await listMinio(prefix)
  else if (process.env.STORAGE_PROVIDER === 'filesystem') found = await listFilesystem(prefix)
  else throw new Error('Set STORAGE_PROVIDER=filesystem (or minio) in .env.local')
  return found.sort(byBucketThenName)
}
