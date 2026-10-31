// ============================================================
// Storage provider abstraction.
//
// Wraps either Supabase Storage (current default) or a self-hosted
// MinIO instance (set STORAGE_PROVIDER=minio). All call sites use
// appStorage().from(bucket).<method>() — the same API shape as
// supabaseAdmin().storage so switching providers is transparent.
//
// MinIO env vars (required when STORAGE_PROVIDER=minio):
//   MINIO_ENDPOINT    — hostname or IP (no protocol, no port)
//   MINIO_PORT        — default 9000
//   MINIO_USE_SSL     — "true" | "false" (default "false")
//   MINIO_ACCESS_KEY  — root user / access key
//   MINIO_SECRET_KEY  — root password / secret key
//   MINIO_PUBLIC_URL  — base URL for public-read buckets, e.g. https://files.example.com
// ============================================================

import { Client as MinioClient } from 'minio'
import { supabaseAdmin } from '@/lib/supabase/admin-client'

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
      }
    },
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Server-side storage client. Defaults to Supabase Storage; set
 * STORAGE_PROVIDER=minio to switch to the self-hosted MinIO instance.
 *
 * Usage: appStorage().from('bucket-name').upload(path, bytes, { contentType })
 */
export function appStorage(): AppStorage {
  if (process.env.STORAGE_PROVIDER === 'minio') {
    return minioProvider()
  }
  // Supabase Storage matches our interface shape.
  return supabaseAdmin().storage as unknown as AppStorage
}
