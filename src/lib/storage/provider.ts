// ============================================================
// Storage provider abstraction.
//
// All call sites use appStorage().from(bucket).<method>().
//
// STORAGE_PROVIDER=filesystem (recommended — no extra service needed):
//   STORAGE_FILEPATH   — absolute path on disk, e.g. /app/storage
//   STORAGE_PUBLIC_URL — the app's own public origin, e.g. https://halo.vircle.tech
//                        Files are served via GET /api/fs/<bucket>/<path>
//
// STORAGE_PROVIDER=minio (requires a running MinIO instance):
//   MINIO_ENDPOINT    — hostname or IP (no protocol, no port)
//   MINIO_PORT        — default 9000
//   MINIO_USE_SSL     — "true" | "false" (default "false")
//   MINIO_ACCESS_KEY  — root user / access key
//   MINIO_SECRET_KEY  — root password / secret key
//   MINIO_PUBLIC_URL  — base URL for public-read buckets, e.g. https://files.example.com
// ============================================================

import { promises as fs } from 'fs'
import path from 'path'

import { Client as MinioClient } from 'minio'

// ── Shared return shapes (mirror Supabase Storage exactly) ──────────────────

export interface AppStorageError {
  message: string
  statusCode?: number
}

export interface AppStorageBucket {
  upload(
    path: string,
    data: Uint8Array | Buffer | Blob | File,
    opts?: { contentType?: string; upsert?: boolean; cacheControl?: string },
  ): Promise<{ data: { path: string } | null; error: AppStorageError | null }>

  download(
    path: string,
  ): Promise<{ data: Blob | null; error: AppStorageError | null }>

  remove(
    paths: string[],
  ): Promise<{ data: null; error: AppStorageError | null }>

  copy(
    from: string,
    to: string,
  ): Promise<{ data: { path: string } | null; error: AppStorageError | null }>

  createSignedUrl(
    path: string,
    ttlSeconds: number,
  ): Promise<{ data: { signedUrl: string } | null; error: AppStorageError | null }>

  createSignedUrls(
    paths: string[],
    ttlSeconds: number,
  ): Promise<{
    data: Array<{ path: string; signedUrl: string; error: null }> | null
    error: AppStorageError | null
  }>

  info(
    path: string,
  ): Promise<{
    data: { size: number; contentType: string; content_type: string } | null
    error: AppStorageError | null
  }>

  getPublicUrl(path: string): { data: { publicUrl: string } }

  createSignedUploadUrl(
    path: string,
    ttlSeconds?: number,
  ): Promise<{ data: { path: string; token: string } | null; error: AppStorageError | null }>
}

export interface AppStorage {
  from(bucket: string): AppStorageBucket
}

// ── MinIO implementation ─────────────────────────────────────────────────────

let _minio: MinioClient | null = null

function getMinioClient(): MinioClient {
  if (!_minio) {
    _minio = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT!,
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY!,
      secretKey: process.env.MINIO_SECRET_KEY!,
    })
  }
  return _minio
}

function minioProvider(): AppStorage {
  const minio = getMinioClient()
  const publicBase = (process.env.MINIO_PUBLIC_URL ?? '').replace(/\/$/, '')

  return {
    from(bucket: string): AppStorageBucket {
      return {
        async upload(path, data, opts) {
          try {
            let buf: Buffer
            if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
              buf = Buffer.from(data)
            } else if (data instanceof Blob) {
              buf = Buffer.from(await data.arrayBuffer())
            } else {
              buf = Buffer.from(await (data as File).arrayBuffer())
            }
            await minio.putObject(bucket, path, buf, buf.length, {
              'Content-Type': opts?.contentType ?? 'application/octet-stream',
            })
            return { data: { path }, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async download(path) {
          try {
            const stream = await minio.getObject(bucket, path)
            const chunks: Buffer[] = []
            await new Promise<void>((resolve, reject) => {
              stream.on('data', (c: Buffer) => chunks.push(c))
              stream.on('end', resolve)
              stream.on('error', reject)
            })
            return { data: new Blob([Buffer.concat(chunks)]), error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async remove(paths) {
          try {
            await minio.removeObjects(bucket, paths)
            return { data: null, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async copy(from, to) {
          try {
            const { CopyConditions } = await import('minio')
            await minio.copyObject(bucket, to, `/${bucket}/${from}`, new CopyConditions())
            return { data: { path: to }, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async createSignedUrl(path, ttlSeconds) {
          try {
            const signedUrl = await minio.presignedGetObject(bucket, path, ttlSeconds)
            return { data: { signedUrl }, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async createSignedUrls(paths, ttlSeconds) {
          try {
            const signed = await Promise.all(
              paths.map(async (p) => ({
                path: p,
                signedUrl: await minio.presignedGetObject(bucket, p, ttlSeconds),
                error: null as null,
              })),
            )
            return { data: signed, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async info(path) {
          try {
            const stat = await minio.statObject(bucket, path)
            const ct = stat.metaData?.['content-type'] ?? 'application/octet-stream'
            return { data: { size: stat.size, contentType: ct, content_type: ct }, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        getPublicUrl(path) {
          const publicUrl = publicBase
            ? `${publicBase}/${bucket}/${path}`
            : `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT ?? 9000}/${bucket}/${path}`
          return { data: { publicUrl } }
        },

        async createSignedUploadUrl(path, ttlSeconds = 3600) {
          try {
            const token = await minio.presignedPutObject(bucket, path, ttlSeconds)
            return { data: { path, token }, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },
      }
    },
  }
}

// ── Filesystem implementation ────────────────────────────────────────────────

function filesystemProvider(): AppStorage {
  const base = (process.env.STORAGE_FILEPATH ?? '/app/storage').replace(/\/$/, '')
  const publicOrigin = (process.env.STORAGE_PUBLIC_URL ?? '').replace(/\/$/, '')

  function fileUrl(bucket: string, filePath: string): string {
    return `${publicOrigin}/api/fs/${bucket}/${filePath}`
  }

  return {
    from(bucket: string): AppStorageBucket {
      const bucketDir = `${base}/${bucket}`
      return {
        async upload(filePath, data, opts) {
          try {
            const full = path.join(bucketDir, filePath)
            // Prevent directory traversal
            if (!full.startsWith(bucketDir + path.sep) && full !== bucketDir) {
              return { data: null, error: { message: 'Invalid path' } }
            }
            await fs.mkdir(path.dirname(full), { recursive: true })
            let buf: Buffer
            if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
              buf = Buffer.from(data)
            } else if (data instanceof Blob) {
              buf = Buffer.from(await data.arrayBuffer())
            } else {
              buf = Buffer.from(await (data as File).arrayBuffer())
            }
            await fs.writeFile(full, buf)
            return { data: { path: filePath }, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async download(filePath) {
          try {
            const buf = await fs.readFile(path.join(bucketDir, filePath))
            return { data: new Blob([buf]), error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async remove(paths) {
          try {
            await Promise.all(
              paths.map((p) => fs.unlink(path.join(bucketDir, p)).catch(() => undefined)),
            )
            return { data: null, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async copy(from, to) {
          try {
            const dst = path.join(bucketDir, to)
            await fs.mkdir(path.dirname(dst), { recursive: true })
            await fs.copyFile(path.join(bucketDir, from), dst)
            return { data: { path: to }, error: null }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        async createSignedUrl(filePath, _ttlSeconds) {
          return { data: { signedUrl: fileUrl(bucket, filePath) }, error: null }
        },

        async createSignedUrls(paths, _ttlSeconds) {
          const data = paths.map((p) => ({ path: p, signedUrl: fileUrl(bucket, p), error: null as null }))
          return { data, error: null }
        },

        async info(filePath) {
          try {
            const stat = await fs.stat(path.join(bucketDir, filePath))
            return {
              data: { size: stat.size, contentType: 'application/octet-stream', content_type: 'application/octet-stream' },
              error: null,
            }
          } catch (err) {
            return { data: null, error: { message: String(err) } }
          }
        },

        getPublicUrl(filePath) {
          return { data: { publicUrl: fileUrl(bucket, filePath) } }
        },

        async createSignedUploadUrl(filePath, _ttlSeconds = 3600) {
          return { data: { path: filePath, token: '' }, error: null }
        },
      }
    },
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Server-side storage client.
 *   STORAGE_PROVIDER=filesystem  — stores files on the local disk (recommended for VPS)
 *   STORAGE_PROVIDER=minio       — self-hosted MinIO S3-compatible store
 *
 * Usage: appStorage().from('bucket-name').upload(path, bytes, { contentType })
 */
export function appStorage(): AppStorage {
  if (process.env.STORAGE_PROVIDER === 'minio') return minioProvider()
  if (process.env.STORAGE_PROVIDER === 'filesystem') return filesystemProvider()
  throw new Error('Set STORAGE_PROVIDER=filesystem (or minio) in .env.local')
}
