// ============================================================
// POST /api/widget/message
//
// Where a widget visitor's outbound text / attachment lands. Public,
// CORS-enabled, verified via the same anonymous-auth bearer JWT as
// POST /api/widget/session. Deliberately NOT a direct client insert into
// `messages`: this route is the one synchronous place that also runs the
// inbound fan-out every WhatsApp message gets (automations, AI auto-reply,
// outbound webhooks; src/lib/widget/inbound.ts).
//
// Request:  { conversationId, text?, media?, clientMessageId? }
//           (at least one of text / media; text is the caption for media)
// Response: { message: { id, created_at, status } }   (+ legacy success/messageId)
//
// Attachments are uploaded by the widget straight to Storage with the
// signed token from /api/widget/upload-url. Here the object is re-checked
// against what Storage really holds; a mismatch deletes it.
// ============================================================
import { NextResponse } from 'next/server'

import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, withCors } from '@/lib/widget/cors'
import {
  checkStoredObject,
  parseDeclaredMedia,
  WIDGET_MEDIA_BUCKET,
} from '@/lib/widget/media'
import {
  insertWidgetCustomerMessage,
  isFirstCustomerMessage,
  runWidgetInboundFanout,
  type InboundMedia,
} from '@/lib/widget/inbound'
import { authenticateVisitorRequest, loadOwnedConversation, widgetError } from '@/lib/widget/visitor-auth'

const TEXT_MAX_LEN = 4000
const CAPTION_MAX_LEN = 1024

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const auth = await authenticateVisitorRequest(request, {
    logTag: 'widget/message',
    rate: { key: 'widget:message:{visitor}', options: RATE_LIMITS.widgetMessage },
  })
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const { admin, corsOrigin, accountId, contactId, visitorId } = ctx

  const body = (await request.json().catch(() => null)) as
    | { conversationId?: unknown; text?: unknown; media?: unknown; clientMessageId?: unknown }
    | null
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const hasMedia = body?.media !== undefined && body?.media !== null

  if (!conversationId) return widgetError(400, 'conversationId is required', 'bad_request', corsOrigin)
  if (!text && !hasMedia) return widgetError(400, 'text or media is required', 'bad_request', corsOrigin)
  if (text.length > (hasMedia ? CAPTION_MAX_LEN : TEXT_MAX_LEN)) {
    return widgetError(
      400,
      `text exceeds the ${hasMedia ? CAPTION_MAX_LEN : TEXT_MAX_LEN}-character limit`,
      'bad_request',
      corsOrigin,
    )
  }

  let conversation
  try {
    conversation = await loadOwnedConversation(ctx, conversationId)
  } catch (err) {
    console.error('[widget/message] conversation lookup error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
  if (!conversation) return widgetError(404, 'Conversation not found', 'not_found', corsOrigin)

  // ---- attachment: re-validate what was declared against Storage ----
  let media: InboundMedia | null = null
  if (hasMedia) {
    const declared = parseDeclaredMedia(body!.media, accountId, conversationId)
    if (!declared.ok) {
      // A declared object that fails the rules still gets removed when it sits
      // under this conversation's prefix.
      const rawPath = (body!.media as { path?: unknown })?.path
      if (
        typeof rawPath === 'string' &&
        (declared.status === 413 || declared.status === 415) &&
        rawPath.startsWith(`account-${accountId}/widget/${conversationId}/`) &&
        !rawPath.includes('..')
      ) {
        await admin.storage.from(WIDGET_MEDIA_BUCKET).remove([rawPath]).catch(() => undefined)
      }
      return widgetError(declared.status, declared.error, declared.code, corsOrigin)
    }
    const m = declared.media

    const { data: info, error: infoError } = await admin.storage.from(WIDGET_MEDIA_BUCKET).info(m.path)
    if (infoError || !info) {
      return widgetError(400, 'The uploaded file could not be found', 'bad_request', corsOrigin)
    }
    const stored = checkStoredObject(m, {
      size: info.size ?? null,
      contentType: info.contentType ?? (info as { content_type?: string }).content_type ?? null,
    })
    if (!stored.ok) {
      await admin.storage.from(WIDGET_MEDIA_BUCKET).remove([m.path]).catch(() => undefined)
      return widgetError(stored.status, stored.error, stored.code, corsOrigin)
    }

    const { data: pub } = admin.storage.from(WIDGET_MEDIA_BUCKET).getPublicUrl(m.path)
    media = { url: pub.publicUrl, kind: m.kind, mimeType: m.mimeType }
  }

  let ownerUserId: string
  try {
    ownerUserId = await resolveAuditUserId(admin, accountId)
  } catch (err) {
    if (err instanceof ContactError) return widgetError(err.status, err.message, undefined, corsOrigin)
    throw err
  }

  // First-message check BEFORE the insert, same as the WhatsApp webhook.
  const isFirstInboundMessage = await isFirstCustomerMessage(admin, conversationId)

  const inserted = await insertWidgetCustomerMessage(admin, {
    conversationId,
    text,
    media,
    clientMessageId: body?.clientMessageId,
  })
  if (!inserted) return widgetError(500, 'Failed to send message', undefined, corsOrigin)

  // A retried send (same clientMessageId) must not fire the fan-out twice.
  if (!inserted.duplicate) {
    await runWidgetInboundFanout(admin, {
      accountId,
      contactId,
      conversation,
      ownerUserId,
      messageId: inserted.id,
      text,
      media,
      isFirstInboundMessage,
      visitorId,
    })
  }

  return withCors(
    NextResponse.json({
      message: { id: inserted.id, created_at: inserted.created_at, status: inserted.status },
      // Legacy shape, read by old cached loaders.
      success: true,
      messageId: inserted.id,
    }),
    corsOrigin,
  )
}
