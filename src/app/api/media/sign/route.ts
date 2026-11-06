// POST /api/media/sign — server-side signed URL generation
//
// Replaces browser-side createClient().storage.from(bucket).createSignedUrls().
// The browser sends { bucket, paths, ttl } and the server calls appStorage()
// to generate signed (or plain filesystem) URLs for the active provider.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { appStorage } from '@/lib/storage/provider'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let body: { bucket?: string; paths?: string[]; ttl?: number }
  try {
    body = await req.json()
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 })
  }

  const { bucket, paths, ttl = 3600 } = body
  if (!bucket || !Array.isArray(paths) || paths.length === 0) {
    return new NextResponse('Missing bucket or paths', { status: 400 })
  }

  const { data, error } = await appStorage().from(bucket).createSignedUrls(paths, ttl)
  if (error) {
    return new NextResponse(error.message, { status: 500 })
  }

  const urls: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) urls[row.path] = row.signedUrl
  }
  return NextResponse.json({ urls })
}
