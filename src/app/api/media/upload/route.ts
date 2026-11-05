// ============================================================
// POST /api/media/upload — server-side media upload
// DELETE /api/media/upload — server-side media delete
//
// Replaces browser-side Supabase Storage calls in upload-media.ts and
// upload-sembang-file.ts. The client sends multipart/form-data; the
// server resolves the session, looks up the account, and writes to the
// active storage provider (filesystem / MinIO) via appStorage().
//
// POST body fields:
//   file      — the File
//   bucket    — storage bucket name, e.g. "chat-media"
//   subfolder — optional path prefix below account-<id>/
//
// DELETE body fields (JSON):
//   bucket    — storage bucket name
//   path      — the full object path to remove
//
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { createAdminPgDb } from '@/lib/postgres/db'
import { appStorage } from '@/lib/storage/provider'
import { buildMediaPath } from '@/lib/storage/upload-media'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return new NextResponse('Invalid form data', { status: 400 })
  }

  const file = formData.get('file') as File | null
  const bucket = formData.get('bucket') as string | null
  const subfolder = (formData.get('subfolder') as string | null) ?? undefined

  if (!file || !bucket) {
    return new NextResponse('Missing file or bucket', { status: 400 })
  }

  const admin = createAdminPgDb()
  const { data: profile } = await admin
    .from('profiles')
    .select('account_id')
    .eq('user_id', session.user.id)
    .maybeSingle()
  if (!profile?.account_id) {
    return new NextResponse('Account not found', { status: 403 })
  }

  const objectPath = buildMediaPath(
    profile.account_id as string,
    file.name,
    Date.now(),
    subfolder,
  )

  const bytes = new Uint8Array(await file.arrayBuffer())
  const storage = appStorage()
  const { error } = await storage.from(bucket).upload(objectPath, bytes, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
    cacheControl: '3600',
  })
  if (error) {
    return new NextResponse(error.message, { status: 500 })
  }

  const { data: { publicUrl } } = storage.from(bucket).getPublicUrl(objectPath)
  return NextResponse.json({ path: objectPath, publicUrl })
}

export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let body: { bucket?: string; path?: string }
  try {
    body = await req.json()
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 })
  }

  const { bucket, path: objectPath } = body
  if (!bucket || !objectPath) {
    return new NextResponse('Missing bucket or path', { status: 400 })
  }

  // Verify the path belongs to this user's account before deleting.
  const admin = createAdminPgDb()
  const { data: profile } = await admin
    .from('profiles')
    .select('account_id')
    .eq('user_id', session.user.id)
    .maybeSingle()
  if (!profile?.account_id) {
    return new NextResponse('Account not found', { status: 403 })
  }
  const expectedPrefix = `account-${profile.account_id}/`
  if (!objectPath.startsWith(expectedPrefix)) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const { error } = await appStorage().from(bucket).remove([objectPath])
  if (error) {
    return new NextResponse(error.message, { status: 500 })
  }
  return new NextResponse(null, { status: 204 })
}
