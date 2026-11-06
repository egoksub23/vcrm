// ============================================================
// POST /api/widget/upload  (multipart/form-data)
//
// Receives a media file from the widget visitor, validates it, stores it
// via appStorage() (filesystem on VPS; MinIO if STORAGE_PROVIDER=minio),
// and returns the storage path for use in /api/widget/message.
//
// This replaces the previous two-step approach:
//   1. POST /api/widget/upload-url  → get a signed Supabase Storage token
//   2. supabase.storage.uploadToSignedUrl(...)  → upload straight to Supabase
//
// Fields:  conversationId, fileName, mimeType, kind, sizeBytes, file (binary)
// Response: { path: string, bucket: string }
// ============================================================
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'

import { RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, withCors } from '@/lib/widget/cors'
import {
  baseMime,
  buildWidgetMediaPath,
  isAllowedMime,
  isMediaKind,
  kindForMime,
  WIDGET_MAX_FILE_BYTES,
  WIDGET_MEDIA_BUCKET,
} from '@/lib/widget/media'
import { authenticateVisitorRequest, loadOwnedConversation, widgetError } from '@/lib/widget/visitor-auth'
import { appStorage } from '@/lib/storage/provider'

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const auth = await authenticateVisitorRequest(request, {
    logTag: 'widget/upload',
    rate: { key: 'widget:upload:{visitor}', options: RATE_LIMITS.widgetUpload },
  })
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const { admin, corsOrigin, accountId } = ctx

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return widgetError(400, 'Expected multipart/form-data', 'bad_request', corsOrigin)
  }

  const conversationId = String(formData.get('conversationId') ?? '').trim()
  const fileName = String(formData.get('fileName') ?? '').trim()
  const mimeType = baseMime(formData.get('mimeType'))
  const kind = formData.get('kind')
  const sizeBytes = Number(formData.get('sizeBytes') ?? NaN)
  const file = formData.get('file')

  if (!conversationId) return widgetError(400, 'conversationId is required', 'bad_request', corsOrigin)
  if (!fileName) return widgetError(400, 'fileName is required', 'bad_request', corsOrigin)
  if (!(file instanceof Blob)) return widgetError(400, 'file is required', 'bad_request', corsOrigin)

  const actualSize = Number.isFinite(sizeBytes) ? sizeBytes : file.size
  if (actualSize > WIDGET_MAX_FILE_BYTES) {
    return widgetError(413, 'File is larger than 16 MB', 'file_too_large', corsOrigin)
  }
  if (!isAllowedMime(mimeType)) {
    return widgetError(415, 'This file type is not allowed', 'file_type_not_allowed', corsOrigin)
  }
  if (!isMediaKind(kind) || kindForMime(mimeType) !== kind) {
    return widgetError(400, 'kind does not match the file type', 'bad_request', corsOrigin)
  }

  let conversation
  try {
    conversation = await loadOwnedConversation(ctx, conversationId)
  } catch (err) {
    console.error('[widget/upload] conversation lookup error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
  if (!conversation) return widgetError(404, 'Conversation not found', 'not_found', corsOrigin)

  const path = buildWidgetMediaPath(accountId, conversationId, randomUUID(), fileName)
  const { data, error } = await appStorage()
    .from(WIDGET_MEDIA_BUCKET)
    .upload(path, file, { contentType: mimeType })

  if (error || !data) {
    console.error('[widget/upload] storage upload failed:', error)
    return widgetError(500, 'Upload failed', undefined, corsOrigin)
  }

  return withCors(
    NextResponse.json({ path: data.path, bucket: WIDGET_MEDIA_BUCKET }),
    corsOrigin,
  )
}
