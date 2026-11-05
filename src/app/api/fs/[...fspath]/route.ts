// GET /api/fs/<bucket>/<path…>
// Serves files written by the filesystem storage provider (STORAGE_PROVIDER=filesystem).
// Path is validated against STORAGE_FILEPATH to prevent directory traversal.

import { NextResponse } from 'next/server'
import { promises as fsPromises } from 'fs'
import path from 'path'

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
  txt: 'text/plain',
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fspath: string[] }> },
) {
  const base = (process.env.STORAGE_FILEPATH ?? '/app/storage').replace(/\/$/, '')
  const segments = (await params).fspath
  if (!segments || segments.length < 2) {
    return new NextResponse('Not found', { status: 404 })
  }

  const joined = segments.join('/')
  const resolved = path.resolve(base, joined)

  // Guard against path traversal — resolved must stay inside base
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  try {
    const buf = await fsPromises.readFile(resolved)
    const ext = resolved.split('.').pop()?.toLowerCase() ?? ''
    const ct = MIME[ext] ?? 'application/octet-stream'
    return new NextResponse(buf, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
}
