// ============================================================
// POST /api/widget/upload-url
//
// Hands a widget visitor a Supabase Storage SIGNED UPLOAD TOKEN for one
// attachment. The widget then uploads straight to Storage with
//   supabase.storage.from('chat-media').uploadToSignedUrl(path, token, blob, { contentType })
// and finally calls POST /api/widget/message with `media`. Uploading
// straight to Storage keeps file bytes out of this server (no Next body
// size limit involved) and out of the visitor's reach for anything but the
// one path issued here.
//
// The token is only issued after the same checks /message repeats on the
// stored object: the visitor owns the conversation, the MIME type is in the
// chat-media allow-list, the size is <= 16 MB, the kind matches the type.
// The bucket itself (unchanged) still enforces its own size and type limits
// at upload time.
//
// Request:  { conversationId, fileName, mimeType, sizeBytes, kind }
// Response: { bucket: 'chat-media', path, token }
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

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const auth = await authenticateVisitorRequest(request, {
    logTag: 'widget/upload-url',
    rate: { key: 'widget:upload:{visitor}', options: RATE_LIMITS.widgetUpload },
  })
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const { admin, corsOrigin, accountId } = ctx

  const body = (await request.json().catch(() => null)) as
    | { conversationId?: unknown; fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown; kind?: unknown }
    | null

  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : ''
  const mimeType = baseMime(body?.mimeType)
  const sizeBytes = typeof body?.sizeBytes === 'number' ? body.sizeBytes : NaN
  const kind = body?.kind

  if (!conversationId) return widgetError(400, 'conversationId is required', 'bad_request', corsOrigin)
  if (!fileName) return widgetError(400, 'fileName is required', 'bad_request', corsOrigin)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return widgetError(400, 'sizeBytes must be a positive number', 'bad_request', corsOrigin)
  }
  if (sizeBytes > WIDGET_MAX_FILE_BYTES) {
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
    console.error('[widget/upload-url] conversation lookup error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
  if (!conversation) return widgetError(404, 'Conversation not found', 'not_found', corsOrigin)

  const path = buildWidgetMediaPath(accountId, conversationId, randomUUID(), fileName)
  const { data, error } = await admin.storage.from(WIDGET_MEDIA_BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error('[widget/upload-url] createSignedUploadUrl failed:', error)
    return widgetError(500, 'Could not prepare the upload', undefined, corsOrigin)
  }

  return withCors(NextResponse.json({ bucket: WIDGET_MEDIA_BUCKET, path: data.path, token: data.token }), corsOrigin)
}
