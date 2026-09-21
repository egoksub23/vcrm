import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import type { ChannelType } from '@/types'
import type { KnowledgeAttachment } from '@/lib/knowledge-types'
import { loadEffectiveAttachments } from './translations'

// ============================================================
// Sending an article's files along with an AI answer.
//
// After the AI's text reply, the files of the articles it used (only those
// switched on for "Send with AI answers") go out as separate media messages.
// A file already sent in this conversation is skipped, so a customer who asks
// the same thing twice does not get the price list twice. A channel that
// cannot carry a file gets it as a link line in text instead; a file is never
// silently dropped. Nothing here throws into the reply path: failures are
// logged and counted.
//
// An article's inline images are attachments like any other: they go out in
// document order (an article's files are stored in that order) with their
// caption as the media caption. Here the reply's text was written by the AI,
// so the article's own HTML is not part of it and an inline image is sent as
// a file on email too; only an agent inserting the article into an email
// keeps the images inline (see the composer).
// ============================================================

export type MediaMessageType = 'image' | 'video' | 'audio' | 'document'
export type Delivery = { via: 'media'; messageType: MediaMessageType } | { via: 'link' }

// What WhatsApp Cloud API accepts as image / video / audio; anything else
// still goes out, as a document.
const WA_IMAGE = new Set(['image/jpeg', 'image/png'])
const WA_VIDEO = new Set(['video/mp4', 'video/3gpp'])
const WA_AUDIO = new Set(['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'])
// Instagram DMs carry images, video and audio, but not documents.
const IG_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif'])
const IG_VIDEO = new Set(['video/mp4', 'video/ogg', 'video/avi', 'video/quicktime', 'video/webm'])
const IG_AUDIO = new Set(['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/wav'])

/** How one file travels on one channel. */
export function planDelivery(
  channel: ChannelType,
  file: Pick<KnowledgeAttachment, 'kind' | 'mime_type'>,
): Delivery {
  const mime = file.mime_type.toLowerCase()
  switch (channel) {
    case 'whatsapp':
      if (file.kind === 'image' && WA_IMAGE.has(mime)) return { via: 'media', messageType: 'image' }
      if (file.kind === 'video' && WA_VIDEO.has(mime)) return { via: 'media', messageType: 'video' }
      if (file.kind === 'audio' && WA_AUDIO.has(mime)) return { via: 'media', messageType: 'audio' }
      return { via: 'media', messageType: 'document' }
    case 'messenger':
      return { via: 'media', messageType: file.kind }
    case 'instagram':
      if (file.kind === 'image' && IG_IMAGE.has(mime)) return { via: 'media', messageType: 'image' }
      if (file.kind === 'video' && IG_VIDEO.has(mime)) return { via: 'media', messageType: 'video' }
      if (file.kind === 'audio' && IG_AUDIO.has(mime)) return { via: 'media', messageType: 'audio' }
      return { via: 'link' }
    case 'email':
    case 'gmail':
      // Real attachments: the send path downloads the file and attaches it.
      return { via: 'media', messageType: file.kind }
    case 'web_widget':
    default:
      // The web chat carries text only.
      return { via: 'link' }
  }
}

/** One text message listing files as "name: url" lines. An image with a
 *  caption is listed by that caption (its file name is a generated one). */
export function buildLinkText(
  files: (Pick<KnowledgeAttachment, 'file_name' | 'url'> & { caption?: string | null })[],
): string {
  return files.map((f) => `${f.caption?.trim() || f.file_name}: ${f.url}`).join('\n')
}

/**
 * The files of these articles that are switched on for AI answers, in the
 * order of the articles and then their own order. A translation sends its own
 * files, or its base article's when it has none, and a translation and its
 * base never both send theirs (see `loadEffectiveAttachments`). Uses whichever
 * client it is given (the service role in the auto-reply bot, the agent's own
 * in the draft route).
 */
export async function loadSendableAttachments(
  db: SupabaseClient,
  accountId: string,
  documentIds: string[],
): Promise<KnowledgeAttachment[]> {
  if (documentIds.length === 0) return []
  const effective = await loadEffectiveAttachments(db, accountId, documentIds)
  return Array.from(effective.values())
    .flat()
    .filter((a) => a.send_with_ai)
}

/** URLs already sent to the customer in this conversation, as a media message
 *  or inside a link line. */
async function alreadySent(db: SupabaseClient, conversationId: string, urls: string[]): Promise<Set<string>> {
  const sent = new Set<string>()
  try {
    const { data } = await db
      .from('messages')
      .select('media_url, content_text')
      .eq('conversation_id', conversationId)
      .in('sender_type', ['agent', 'bot'])
      .eq('is_internal', false)
      // A file whose send failed still has to go out next time.
      .neq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(300)
    for (const row of (data ?? []) as { media_url: string | null; content_text: string | null }[]) {
      for (const url of urls) {
        if (row.media_url === url || (row.content_text ?? '').includes(url)) sent.add(url)
      }
    }
  } catch (err) {
    // Not knowing is safer than not sending: the worst case is a repeat.
    console.warn('[knowledge attachments] duplicate check failed:', err)
  }
  return sent
}

export interface SendAttachmentsResult {
  /** Files sent as media. */
  sent: number
  /** Files sent as a link line. */
  linked: number
  /** Files skipped because they were already sent in this conversation. */
  skipped: number
  /** Files that could not be sent either way. */
  failed: number
}

export async function sendKnowledgeAttachments(
  db: SupabaseClient,
  accountId: string,
  args: {
    conversationId: string
    attachments: KnowledgeAttachment[]
    /** The channel to send on; read from the conversation when omitted. */
    channel?: ChannelType | null
    senderType?: 'agent' | 'bot'
    aiGenerated?: boolean
  },
): Promise<SendAttachmentsResult> {
  const result: SendAttachmentsResult = { sent: 0, linked: 0, skipped: 0, failed: 0 }
  try {
    // The same file attached to two cited articles goes out once.
    const files: KnowledgeAttachment[] = []
    const seen = new Set<string>()
    for (const a of args.attachments) {
      if (seen.has(a.url)) continue
      seen.add(a.url)
      files.push(a)
    }
    if (files.length === 0) return result

    let channel = args.channel ?? null
    if (!channel) {
      const { data } = await db
        .from('conversations')
        .select('last_channel_type')
        .eq('id', args.conversationId)
        .eq('account_id', accountId)
        .maybeSingle()
      channel = ((data as { last_channel_type?: ChannelType } | null)?.last_channel_type ?? null) as ChannelType | null
    }
    if (!channel) {
      console.error('[knowledge attachments] no channel for conversation', args.conversationId)
      result.failed = files.length
      return result
    }

    const already = await alreadySent(db, args.conversationId, files.map((f) => f.url))
    const toSend = files.filter((f) => !already.has(f.url))
    result.skipped = files.length - toSend.length

    const senderType = args.senderType ?? 'bot'
    const aiGenerated = args.aiGenerated ?? true
    const asLinks: KnowledgeAttachment[] = []

    for (const file of toSend) {
      const plan = planDelivery(channel, file)
      if (plan.via === 'link') {
        asLinks.push(file)
        continue
      }
      try {
        await sendMessageToConversation(db, accountId, {
          conversationId: args.conversationId,
          messageType: plan.messageType,
          mediaUrl: file.url,
          filename: file.file_name,
          // An image's caption goes out as the media caption (chat channels).
          ...(plan.messageType === 'image' && file.caption?.trim()
            ? { contentText: file.caption.trim().slice(0, 1024) }
            : {}),
          channelOverride: channel,
          senderType,
          aiGenerated,
        })
        result.sent += 1
      } catch (err) {
        // The channel refused the file (a type or size it does not take):
        // fall back to a link rather than lose it.
        console.error(`[knowledge attachments] media send failed for "${file.file_name}":`, err)
        asLinks.push(file)
      }
    }

    if (asLinks.length > 0) {
      try {
        await sendMessageToConversation(db, accountId, {
          conversationId: args.conversationId,
          messageType: 'text',
          contentText: buildLinkText(asLinks),
          channelOverride: channel,
          senderType,
          aiGenerated,
        })
        result.linked = asLinks.length
      } catch (err) {
        console.error('[knowledge attachments] link fallback failed:', err)
        result.failed += asLinks.length
      }
    }
  } catch (err) {
    console.error('[knowledge attachments] send failed:', err)
  }
  return result
}
