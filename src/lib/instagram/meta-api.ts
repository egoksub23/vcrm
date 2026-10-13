/**
 * Instagram Messaging API helpers — nearly identical to Messenger's
 * Send API, scoped to the linked IG professional account instead of a
 * Page. Named-params-object convention, matching
 * `src/lib/whatsapp/meta-api.ts`.
 */

import { throwMetaError } from '@/lib/meta/errors'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface MetaSendResult {
  messageId: string
}

interface SendResponse {
  recipient_id: string
  message_id: string
}

export interface SendInstagramTextArgs {
  igBusinessAccountId: string
  pageAccessToken: string
  recipientIgsid: string
  text: string
}

export async function sendInstagramText(args: SendInstagramTextArgs): Promise<MetaSendResult> {
  const { igBusinessAccountId, pageAccessToken, recipientIgsid, text } = args
  const response = await fetch(`${META_API_BASE}/${igBusinessAccountId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Instagram API error: ${response.status}`)
  }
  const data = (await response.json()) as SendResponse
  return { messageId: data.message_id }
}

export interface SendInstagramGenericCardArgs {
  igBusinessAccountId: string
  pageAccessToken: string
  recipientIgsid: string
  title: string
  subtitle: string
  buttonTitle: string
  /** Where the button goes (https). */
  url: string
}

/** The JSON body of a generic template with one web button (exported so the shape is tested). */
export function instagramGenericCardPayload(args: Omit<SendInstagramGenericCardArgs, 'igBusinessAccountId' | 'pageAccessToken'>): Record<string, unknown> {
  return {
    recipient: { id: args.recipientIgsid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: Array.from(args.title).slice(0, 80).join(''),
              subtitle: Array.from(args.subtitle).slice(0, 80).join(''),
              buttons: [{ type: 'web_url', url: args.url, title: Array.from(args.buttonTitle).slice(0, 20).join('') }],
            },
          ],
        },
      },
    },
  }
}

/** A card with one web button (Instagram's generic template). */
export async function sendInstagramGenericCard(args: SendInstagramGenericCardArgs): Promise<MetaSendResult> {
  const response = await fetch(`${META_API_BASE}/${args.igBusinessAccountId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.pageAccessToken}`,
    },
    body: JSON.stringify(instagramGenericCardPayload(args)),
  })
  if (!response.ok) {
    await throwMetaError(response, `Instagram API error: ${response.status}`)
  }
  const data = (await response.json()) as SendResponse
  return { messageId: data.message_id }
}

export type InstagramMediaKind = 'image' | 'video' | 'audio' | 'file'

export interface SendInstagramMediaArgs {
  igBusinessAccountId: string
  pageAccessToken: string
  recipientIgsid: string
  kind: InstagramMediaKind
  url: string
}

export async function sendInstagramMedia(args: SendInstagramMediaArgs): Promise<MetaSendResult> {
  const { igBusinessAccountId, pageAccessToken, recipientIgsid, kind, url } = args
  const response = await fetch(`${META_API_BASE}/${igBusinessAccountId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { attachment: { type: kind, payload: { url, is_reusable: true } } },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Instagram API error: ${response.status}`)
  }
  const data = (await response.json()) as SendResponse
  return { messageId: data.message_id }
}
