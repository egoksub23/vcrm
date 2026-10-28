import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { CommentWriteError, postInternalComment } from '@/lib/conversations/comment-write'
import { loadAiConfig } from '@/lib/ai/config'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { privateMediaPath, PRIVATE_MEDIA_BUCKET } from '@/lib/storage/media-urls'
import type { SupabaseClient } from '@supabase/supabase-js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const PROXY_PREFIX = '/api/whatsapp/media/'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const EXTRACT_PROMPT =
  'This is a transaction receipt screenshot. Extract all visible transaction details and format them as a structured summary. For each field you can see (such as amount, currency, date, time, transaction reference or ID, sender details, recipient details, payment method, bank, status, description), write it on its own line as "Field: value". If a field is not visible, omit it. Be precise — copy numbers and references exactly.'

async function fetchImageBytes(
  supabase: SupabaseClient,
  accountId: string,
  mediaUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  if (mediaUrl.startsWith(PROXY_PREFIX)) {
    const mediaId = mediaUrl.slice(PROXY_PREFIX.length).split('?')[0]!
    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config) throw new Error('whatsapp_not_configured')
    const accessToken = decrypt(config.access_token as string)
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    return await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })
  }

  const path = privateMediaPath(mediaUrl)
  if (path) {
    const { data, error } = await supabase.storage
      .from(PRIVATE_MEDIA_BUCKET)
      .createSignedUrl(path, 60)
    if (error || !data?.signedUrl) throw new Error('sign_failed')
    const res = await fetch(data.signedUrl)
    if (!res.ok) throw new Error('fetch_failed')
    const arrBuf = await res.arrayBuffer()
    return {
      buffer: Buffer.from(arrBuf),
      contentType: res.headers.get('content-type') ?? 'image/jpeg',
    }
  }

  throw new Error('unsupported_url')
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireCapability('conversations.manage')
    const { id: conversationId } = await params

    const body = (await request.json().catch(() => null)) as { messageId?: unknown } | null
    const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : ''
    if (!messageId) {
      return NextResponse.json({ error: 'messageId required' }, { status: 400 })
    }

    const { data: msg } = await ctx.supabase
      .from('messages')
      .select('id, media_url, content_type, conversation_id')
      .eq('id', messageId)
      .eq('conversation_id', conversationId)
      .maybeSingle()

    if (!msg || !msg.media_url) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const aiConfig = await loadAiConfig(ctx.supabase, ctx.accountId, { requireActive: false })
    if (!aiConfig || aiConfig.provider !== 'anthropic') {
      return NextResponse.json({ error: 'ai_not_configured' }, { status: 422 })
    }

    let buffer: Buffer
    let contentType: string
    try {
      const result = await fetchImageBytes(ctx.supabase, ctx.accountId, msg.media_url as string)
      buffer = result.buffer
      contentType = result.contentType
    } catch {
      return NextResponse.json({ error: 'image_fetch_failed' }, { status: 502 })
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'image_too_large' }, { status: 413 })
    }

    const mediaType = (
      contentType.startsWith('image/png') ? 'image/png'
      : contentType.startsWith('image/gif') ? 'image/gif'
      : contentType.startsWith('image/webp') ? 'image/webp'
      : 'image/jpeg'
    ) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

    const base64 = buffer.toString('base64')

    const anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': aiConfig.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiConfig.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: EXTRACT_PROMPT },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!anthropicRes.ok) {
      return NextResponse.json({ error: 'ai_failed' }, { status: 502 })
    }

    const aiData = (await anthropicRes.json()) as {
      content?: { type?: string; text?: string }[]
    }
    const extracted = aiData.content
      ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()

    if (!extracted) {
      return NextResponse.json({ error: 'ai_empty' }, { status: 502 })
    }

    const message = await postInternalComment(ctx.supabase, {
      accountId: ctx.accountId,
      conversationId,
      userId: ctx.userId,
      text: `📋 Receipt data extracted:\n\n${extracted}`,
      mentions: [],
    })

    return NextResponse.json({ message }, { status: 201 })
  } catch (error) {
    if (error instanceof CommentWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}
