// POST /api/platform/migrate-storage
//
// One-time migration: copies every file from Supabase Storage into the
// active filesystem / MinIO provider. Run once after STORAGE_PROVIDER is set.
// Streams NDJSON progress so the caller can follow along with:
//   curl -X POST https://halo.vircle.tech/api/platform/migrate-storage \
//     -H "Cookie: <session-cookie>" --no-buffer
//
// Idempotent — files are uploaded with upsert:true, so it is safe to re-run.

import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { appStorage } from '@/lib/storage/provider'

const BUCKETS = [
  'avatars',
  'chat-media',
  'post-media',
  'compliance-files',
  'share',
  'sign-documents',
  'kb',
  'private-media',
]

async function listAllFiles(bucket: string, folder = ''): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .storage.from(bucket)
    .list(folder, { limit: 1000, offset: 0 })
  if (error) throw new Error(`list ${bucket}/${folder}: ${error.message}`)
  const files: string[] = []
  for (const item of data ?? []) {
    const itemPath = folder ? `${folder}/${item.name}` : item.name
    if (item.id) {
      files.push(itemPath)
    } else {
      files.push(...(await listAllFiles(bucket, itemPath)))
    }
  }
  return files
}

export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))

      try {
        for (const bucket of BUCKETS) {
          send({ status: 'listing', bucket })
          let files: string[]
          try {
            files = await listAllFiles(bucket)
          } catch (err) {
            send({ status: 'error', bucket, message: String(err) })
            continue
          }
          send({ status: 'found', bucket, count: files.length })

          let done = 0
          let errors = 0
          for (const filePath of files) {
            try {
              const { data, error: dlErr } = await supabaseAdmin()
                .storage.from(bucket)
                .download(filePath)
              if (dlErr || !data)
                throw new Error(dlErr?.message ?? 'download returned null')
              const bytes = new Uint8Array(await data.arrayBuffer())
              const { error: upErr } = await appStorage()
                .from(bucket)
                .upload(filePath, bytes, { upsert: true })
              if (upErr) throw new Error(upErr.message)
              done++
              if (done % 20 === 0)
                send({ status: 'progress', bucket, done, total: files.length })
            } catch (err) {
              errors++
              send({ status: 'file-error', bucket, path: filePath, message: String(err) })
            }
          }
          send({ status: 'done', bucket, done, errors })
        }
        send({ status: 'complete' })
      } catch (err) {
        send({ status: 'fatal', message: String(err) })
      }
      controller.close()
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
    },
  })
}
